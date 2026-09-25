import React, { useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import { createLogger } from "@/utils/logger";
import { clamp } from "@/utils/math";
import { Camera } from '@capacitor/camera';
import { isNative } from "@/lib/device/platform";

const log = createLogger("CameraView");

export interface CameraViewHandle {
  getVideoElement: () => HTMLVideoElement | null;
  getDiagnostics: () => Record<string, unknown>;
  /**
   * Optimiza ACTIVAMENTE el hardware para el dedo ya colocado: bloquea foco cercano
   * y balance de blancos (anti-deriva), y AJUSTA la exposición/ISO según el nivel
   * REAL del rojo medido (`redLevel` 0–255) hacia la ventana óptima (sin saturar ni
   * quedar oscuro). Una sola vez en STABLE_CONTACT (timing seguro vs deriva del AE).
   */
  optimizeForFinger: (redLevel: number) => void;
}

interface CameraViewProps {
  onStreamReady?: (stream: MediaStream) => void;
  isMonitoring: boolean;
  measurementMode?: 'finger' | 'gym';
  faceDetected?: boolean;
  /**
   * Se invoca cuando la adquisición se interrumpe por pérdida de visibilidad
   * (pestaña oculta) o descarga de la página: las pistas ya fueron liberadas.
   * El propietario debe resetear buffers/lecturas y no guardar la sesión.
   */
  onInterrupted?: () => void;
}

/** Tiempo máximo de espera a que el <video> presente el primer frame. */
const WAIT_FOR_VIDEO_TIMEOUT_MS = 8000;

type TorchCapableConstraint = MediaTrackConstraintSet & { torch?: boolean };
type AdvancedConstraint = MediaTrackConstraintSet & {
  torch?: boolean;
  exposureMode?: string;
  exposureCompensation?: number;
  exposureTime?: number;
  whiteBalanceMode?: string;
  iso?: number;
  focusMode?: string;
  focusDistance?: number;
  frameRate?: number;
};
type ExtendedCapabilities = MediaTrackCapabilities & {
  torch?: boolean;
  exposureMode?: string[];
  exposureCompensation?: { min?: number; max?: number };
  exposureTime?: { min?: number; max?: number };
  whiteBalanceMode?: string[];
  iso?: { min?: number; max?: number };
  focusMode?: string[];
  focusDistance?: { min?: number; max?: number };
  frameRate?: { min?: number; max?: number };
};
type ExtendedSettings = MediaTrackSettings & {
  torch?: boolean;
  exposureMode?: string;
  whiteBalanceMode?: string;
  focusMode?: string;
  iso?: number;
  exposureCompensation?: number;
  exposureTime?: number;
};

interface SkinGuidePID {
  prevError: number;
  integral: number;
}

/**
 * PID controller for smooth skin-guided ISO/exposure adjustment.
 * Prevents frame-to-frame jumps; gradual convergence to target.
 * Output: EV correction factor (approx).
 */
function computeSkinGuidePID(
  state: SkinGuidePID,
  targetRed: number,
  measuredRed: number,
): { output: number; newState: SkinGuidePID } {
  const error = targetRed - measuredRed;
  state.integral += error;
  // Anti-windup
  if (state.integral > 100) state.integral = 100;
  if (state.integral < -100) state.integral = -100;
  const derivative = error - state.prevError;
  state.prevError = error;
  const Kp = 0.4;
  const Ki = 0.015;
  const Kd = 0.12;
  const output = Kp * error + Ki * state.integral + Kd * derivative;
  return { output, newState: state };
}

async function requestCameraPermission(): Promise<boolean> {
  if (!isNative()) return true;
  try {
    const result = await Camera.requestPermissions({ permissions: ['camera'] });
    const granted = result.camera === 'granted';
    if (!granted) log.warn("Permiso de cámara denegado por el usuario en diálogo nativo");
    return granted;
  } catch (err) {
    log.error("Error al solicitar permiso nativo de cámara", err);
    return false;
  }
}

type CameraErrorType =
  | 'permission_denied'
  | 'not_found'
  | 'not_readable'
  | 'overconstrained'
  | 'abort'
  | 'timeout'
  | 'interrupted'
  | 'unknown';

function classifyCameraError(err: unknown): CameraErrorType {
  if (err instanceof DOMException || (err as Error)?.name) {
    const name = (err as DOMException).name;
    if (name === 'NotAllowedError') return 'permission_denied';
    if (name === 'NotFoundError') return 'not_found';
    if (name === 'NotReadableError') return 'not_readable';
    if (name === 'OverconstrainedError') return 'overconstrained';
    if (name === 'AbortError') return 'abort';
    if (name === 'VideoTimeoutError') return 'timeout';
  }
  return 'unknown';
}

function isConstraintSupported(name: string): boolean {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getSupportedConstraints) return true;
  const supported = navigator.mediaDevices.getSupportedConstraints();
  return Boolean(supported[name as keyof MediaTrackSupportedConstraints]);
}

async function stabilizeTrack(track: MediaStreamTrack, isGym = false): Promise<void> {
  const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
  const constraints: AdvancedConstraint[] = [];

  if (caps.frameRate && isConstraintSupported('frameRate')) {
    const maxFps = caps.frameRate.max ?? 30;
    const targetFps = Math.min(30, maxFps);
    constraints.push({ frameRate: targetFps });
  }

  // Exposición y WB en CONTINUO: el AE/AWB deben ADAPTARSE dinámicamente a la iluminación
  if (caps.exposureMode?.includes("continuous") && isConstraintSupported('exposureMode')) {
    constraints.push({ exposureMode: "continuous" });
  }

  if (caps.whiteBalanceMode?.includes("continuous") && isConstraintSupported('whiteBalanceMode')) {
    constraints.push({ whiteBalanceMode: "continuous" });
  }

  // Foco:
  // En modo finger (trasera), el dedo está pegado al lente -> foco manual a mínima distancia (0).
  // En modo gym (frontal), el rostro está a 30-80 cm -> SIEMPRE foco continuo/automático (NUNCA macro 0).
  if (isGym) {
    if (caps.focusMode?.includes("continuous") && isConstraintSupported('focusMode')) {
      constraints.push({ focusMode: "continuous" });
    }
  } else {
    if (caps.focusMode?.includes("manual") && isConstraintSupported('focusMode')) {
      constraints.push({ focusMode: "manual", focusDistance: 0 });
    } else if (caps.focusMode?.includes("continuous") && isConstraintSupported('focusMode')) {
      constraints.push({ focusMode: "continuous" });
    }
  }

  if (constraints.length > 0) {
    try {
      await track.applyConstraints({ advanced: constraints });
    } catch (e) {
      log.warn("No se pudieron estabilizar parámetros de cámara", e);
    }
  }
}

async function applyTorchDependentParams(track: MediaStreamTrack, torchOn: boolean): Promise<void> {
  const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
  const constraints: AdvancedConstraint[] = [];

  if (torchOn) {
    constraints.push({ torch: true });
    if (caps.iso) {
      const minISO = caps.iso.min ?? 50;
      const maxISO = caps.iso.max ?? 400;
      const targetISO = Math.max(minISO, Math.min(maxISO, 140));
      constraints.push({ iso: targetISO });
    }
    if (caps.exposureCompensation) {
      const minExp = caps.exposureCompensation.min ?? -2;
      const maxExp = caps.exposureCompensation.max ?? 2;
      const targetExp = Math.max(minExp, Math.min(maxExp, -0.35));
      constraints.push({ exposureCompensation: targetExp });
    }
  } else {
    if (caps.iso) {
      const minISO = caps.iso.min ?? 50;
      const maxISO = caps.iso.max ?? 800;
      const targetISO = Math.max(minISO, Math.min(maxISO, 400));
      constraints.push({ iso: targetISO });
    }
    if (caps.exposureCompensation) {
      const minExp = caps.exposureCompensation.min ?? -2;
      const maxExp = caps.exposureCompensation.max ?? 2;
      const targetExp = Math.max(minExp, Math.min(maxExp, 0));
      constraints.push({ exposureCompensation: targetExp });
    }
  }

  if (constraints.length > 0) {
    try {
      await track.applyConstraints({ advanced: constraints });
    } catch (e) {
      log.warn("No se pudieron aplicar parámetros post-torch", e);
    }
  }
}


async function getBestEnvironmentCameraDeviceId(): Promise<string | undefined> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return undefined;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');
    if (videoDevices.length <= 1) return undefined;

    const backCameras = videoDevices.filter(d =>
      /back|rear|environment|trasera|posterior|0/i.test(d.label) ||
      (!/front|user|delantera|selfie|1/i.test(d.label) && !/macro|wide/i.test(d.label))
    );
    return backCameras[0]?.deviceId ?? videoDevices[0]?.deviceId;
  } catch {
    return undefined;
  }
}

const CameraView = forwardRef<CameraViewHandle, CameraViewProps>((
  { onStreamReady, isMonitoring, measurementMode = 'finger', faceDetected, onInterrupted },
  ref
) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isStartingRef = useRef(false);
  const torchActiveRef = useRef(false);
  const skinGuidePIDRef = useRef<SkinGuidePID>({ prevError: 0, integral: 0 });
  const onStreamReadyRef = useRef(onStreamReady);
  onStreamReadyRef.current = onStreamReady;
  const onInterruptedRef = useRef(onInterrupted);
  onInterruptedRef.current = onInterrupted;
  /**
   * Generación de arranque: cada start/stop/desmontaje la incrementa. Los
   * `await` intermedios capturan su generación y abortan si cambió, de modo
   * que dos arranques concurrentes (toggle rápido, remontaje) nunca dejan
   * dos streams vivos ni entregan un stream rancio como listo. O(1).
   */
  const startGenerationRef = useRef(0);

  useImperativeHandle(ref, () => ({
    getVideoElement: () => videoRef.current,
    getDiagnostics: () => {
      const track = streamRef.current?.getVideoTracks?.()[0];
      if (!track) return { active: false };
      try {
        const settings = (track.getSettings?.() ?? {}) as ExtendedSettings;
        const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
        let applied: MediaTrackConstraints | undefined;
        const torchVerified = settings.torch === true;
        try {
          applied = track.getConstraints?.();
        } catch {
          log.debug('getConstraints not available');
          applied = undefined;
        }
        return {
          active: true,
          label: track.label,
          readyState: track.readyState,
          browser: navigator.userAgent,
          userAgent: navigator.userAgent,
          supportedConstraints: Object.keys(navigator.mediaDevices.getSupportedConstraints()),
          capabilities: caps,
          settings: settings,
          appliedConstraints: applied,
          torchSupported: !!caps.torch,
          torchActive: settings.torch === true,
          torchApplyVerified: torchVerified,
          fpsRequested: 30,
          fpsEffective: settings.frameRate || 0,
          resolution: { width: settings.width || 0, height: settings.height || 0 },
          exposureMode: settings.exposureMode,
          whiteBalanceMode: settings.whiteBalanceMode,
          focusMode: settings.focusMode,
        };
      } catch {
        log.warn('Camera diagnostics failed');
        return { active: true, error: "caps_unavailable" };
      }
    },
    optimizeForFinger: (redLevel: number) => {
      if (measurementMode === 'gym') return;
      const track = streamRef.current?.getVideoTracks?.()[0];
      if (!track) return;
      void (async () => {
        try {
          const pidResult: { output: number } = { output: 0 };
          const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
          const settings = (track.getSettings?.() ?? {}) as ExtendedSettings;
          const constraints: AdvancedConstraint[] = [];

          // Preservar SIEMPRE el flash si estaba activo o soportado para evitar el bucle de desconexión
          if (torchActiveRef.current || caps.torch) {
            constraints.push({ torch: true });
          }

          if (caps.focusMode?.includes("manual")) {
            const near = typeof caps.focusDistance?.min === "number" ? caps.focusDistance.min : 0;
            constraints.push({ focusMode: "manual", focusDistance: near });
          }
          if (caps.whiteBalanceMode?.includes("manual")) {
            constraints.push({ whiteBalanceMode: "manual" });
          }
          if (caps.exposureMode?.includes("manual") && redLevel > 0) {
            constraints.push({ exposureMode: "manual" });
            const TARGET = 180;
            const ratio = clamp(TARGET / redLevel, 0.45, 2.2);
            // PID skin-guided correction (smooth over frames)
            const SKIN_RED_TARGET = 180;
            pidResult.output = computeSkinGuidePID(skinGuidePIDRef.current, SKIN_RED_TARGET, redLevel).output;
            const pidFactor = clamp(1 + pidResult.output * 0.005, 0.5, 2.2);
            const effectiveRatio = ratio * pidFactor;
            if (caps.iso && typeof caps.iso.max === "number") {
              const isoMin = caps.iso.min ?? 25;
              const isoMax = caps.iso.max ?? 800;
              const curIso = settings.iso ?? (isoMin + isoMax) / 2;
              constraints.push({ iso: clamp(Math.round(curIso * effectiveRatio), isoMin, isoMax) });
            } else if (caps.exposureCompensation) {
              const evMin = caps.exposureCompensation.min ?? -2;
              const evMax = caps.exposureCompensation.max ?? 2;
              const curEv = settings.exposureCompensation ?? 0;
              constraints.push({
                exposureCompensation: clamp(curEv + clamp(Math.log2(effectiveRatio), -1, 1), evMin, evMax),
              });
            } else if (caps.exposureTime && typeof settings.exposureTime === "number") {
              const etMin = caps.exposureTime.min ?? settings.exposureTime;
              const etMax = caps.exposureTime.max ?? settings.exposureTime;
              constraints.push({ exposureTime: clamp(settings.exposureTime * effectiveRatio, etMin, etMax) });
            }
          }

          if (constraints.length > 0) {
            await track.applyConstraints({ advanced: constraints });
            // Re-verificar el estado real del torch tras re-aplicar: si el
            // hardware lo apagó, el ref debe reflejarlo (nunca asumir).
            try {
              const post = (track.getSettings?.() ?? {}) as ExtendedSettings;
              torchActiveRef.current = post.torch === true;
            } catch {
              log.debug('Torch re-verification unavailable after optimizeForFinger');
            }
            log.info(`Camera optimizada al dedo (red=${redLevel.toFixed(0)}, ${constraints.length} ajustes, pid=${pidResult?.output?.toFixed(2) ?? "0"})`);
          }
        } catch (e) {
          log.warn("optimizeForFinger falló (best-effort)", e);
        }
      })();
    },
  }), [measurementMode]);

  useEffect(() => {
    const mountedRef = { current: true };

    /**
     * Liberación SÍNCRONA de pistas (sin await): usada en visibilitychange /
     * pagehide, donde los await pueden no completarse. Apaga el torch de forma
     * best-effort (sin esperar) y detiene cada track de inmediato. O(n_tracks).
     */
    const releaseTracksSync = () => {
      torchActiveRef.current = false;
      const stream = streamRef.current;
      streamRef.current = null;
      if (stream) {
        for (const track of stream.getVideoTracks()) {
          try {
            track.applyConstraints({
              advanced: [{ torch: false } as TorchCapableConstraint],
            }).catch(() => undefined);
          } catch { log.debug('Torch off sync failed (expected if unsupported)'); }
          try { track.stop(); } catch { log.debug('track.stop() failed'); }
        }
      }
      if (videoRef.current) videoRef.current.srcObject = null;
    };

    const stopCamera = async () => {
      // Invalidar arranques en vuelo: ningún `await` pendiente entregará stream.
      startGenerationRef.current += 1;
      torchActiveRef.current = false;
      const stream = streamRef.current;
      if (stream) {
        for (const track of stream.getVideoTracks()) {
          try {
            await track.applyConstraints({
              advanced: [{ torch: false } as TorchCapableConstraint],
            });
          } catch { log.debug('Torch off (advanced) failed — trying direct'); }
          try {
            await track.applyConstraints({ torch: false } as MediaTrackConstraints);
          } catch { log.debug('Torch off (direct) failed — expected if unsupported'); }
          track.stop();
        }
        streamRef.current = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;

      isStartingRef.current = false;
    };

    const activateTorch = async (track: MediaStreamTrack): Promise<boolean> => {
      const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
      if (caps.torch === false) {
        log.warn("Torch capability is explicitly false on this track");
        return false;
      }
      const attempts = [
        { advanced: [{ torch: true } as TorchCapableConstraint] },
        { torch: true } as TorchCapableConstraint,
        { advanced: [{ torch: 'on' }] },
        { advanced: [{ torchMode: 'torch' }] },
      ] as MediaTrackConstraints[];
      for (const constraints of attempts) {
        try {
          await track.applyConstraints(constraints);
          const settings = (track.getSettings?.() ?? {}) as ExtendedSettings;
          if (settings.torch === true) {
            torchActiveRef.current = true;
            return true;
          }
        } catch { log.debug('Torch attempt failed — trying next syntax'); }
      }
      // Sin confirmación de `getSettings()` NO se declara éxito: un
      // `applyConstraints` resuelto no garantiza que el LED esté encendido
      // (MDN: el estado real solo lo confirma `track.getSettings()`).
      log.warn("Torch no confirmado por getSettings() en este dispositivo");
      torchActiveRef.current = false;
      return false;
    };

    /**
     * Espera al primer frame con TIMEOUT y cancelación por generación.
     * Rechaza con `VideoTimeoutError` si el vídeo no presenta frame en
     * WAIT_FOR_VIDEO_TIMEOUT_MS, o con `AbortError` si un stop/desmontaje/
     * nuevo arranque invalidó la generación en curso. Nunca espera
     * indefinidamente (el `loadedmetadata` puede no llegar con la cámara
     * bloqueada por otra app).
     */
    const waitForVideo = (video: HTMLVideoElement, generation: number): Promise<void> => {
      return new Promise((resolve, reject) => {
        if (video.readyState >= 2 && video.videoWidth > 0) { resolve(); return; }
        let settled = false;
        const timer = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          video.removeEventListener("loadedmetadata", onMeta);
          video.removeEventListener("canplay", onMeta);
          const err = new DOMException("Video frame timeout", "VideoTimeoutError");
          reject(err);
        }, WAIT_FOR_VIDEO_TIMEOUT_MS);
        const onMeta = async () => {
          if (settled) return;
          if (generation !== startGenerationRef.current || !mountedRef.current) {
            settled = true;
            window.clearTimeout(timer);
            video.removeEventListener("loadedmetadata", onMeta);
            video.removeEventListener("canplay", onMeta);
            reject(new DOMException("Camera start superseded", "AbortError"));
            return;
          }
          settled = true;
          window.clearTimeout(timer);
          video.removeEventListener("loadedmetadata", onMeta);
          video.removeEventListener("canplay", onMeta);
          try { await video.play(); } catch { log.debug('Video play() rejected (autoplay policy)'); }
          resolve();
        };
        video.addEventListener("loadedmetadata", onMeta);
        video.addEventListener("canplay", onMeta);
      });
    };

    const startCamera = async () => {
      if (isStartingRef.current) return;
      isStartingRef.current = true;

      await stopCamera();
      if (!mountedRef.current) { isStartingRef.current = false; return; }
      // Generación propia: cualquier stop/desmontaje/re-arranque posterior
      // la invalida y este arranque aborta sin entregar streams rancios.
      const generation = startGenerationRef.current + 1;
      startGenerationRef.current = generation;
      const alive = () => mountedRef.current && generation === startGenerationRef.current;

      // 1. Solicitar permiso nativo en APK antes de getUserMedia
      const permitted = await requestCameraPermission();
      if (!alive()) {
        isStartingRef.current = false;
        return;
      }
      if (!permitted) {
        log.error("Permiso de cámara denegado");
        window.dispatchEvent(new CustomEvent('camera-error', {
          detail: { type: 'permission_denied', message: 'Permiso de cámara denegado' },
        }));
        isStartingRef.current = false;
        return;
      }

      const isGym = measurementMode === 'gym';

      try {
        let stream: MediaStream;
        if (isGym) {
          // Cámara Frontal para rPPG en Modo Gimnasio
          const videoConstraints: MediaTrackConstraints = {
            facingMode: { ideal: "user" },
            width: { ideal: 640, max: 1280 },
            height: { ideal: 480, max: 720 },
            frameRate: { ideal: 30, min: 15, max: 30 },
          };

          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: videoConstraints,
          });
        } else {
          // 2. Cámara Trasera con preferencia a sensor principal con flash
          const preferredDeviceId = await getBestEnvironmentCameraDeviceId();
          if (!alive()) { isStartingRef.current = false; return; }
          const videoConstraints: MediaTrackConstraints = {
            facingMode: preferredDeviceId ? undefined : { ideal: "environment" },
            deviceId: preferredDeviceId ? { ideal: preferredDeviceId } : undefined,
            width: { ideal: 640, max: 960 },
            height: { ideal: 480, max: 720 },
            frameRate: { ideal: 30, min: 15, max: 30 },
          };

          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: videoConstraints,
          });
        }

        if (!alive()) {
          stream.getTracks().forEach(t => { try { t.stop(); } catch { log.debug('late stream track stop failed'); } });
          isStartingRef.current = false;
          return;
        }

        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await waitForVideo(videoRef.current, generation);
        }
        if (!alive()) {
          await stopCamera();
          return;
        }

        const track = stream.getVideoTracks()[0];
        if (track && !isGym) {
          await stabilizeTrack(track, false);
          if (!alive()) { await stopCamera(); return; }
          let torchOn = await activateTorch(track);
          if (!torchOn) {
            await new Promise(r => setTimeout(r, 400));
            if (!alive()) { await stopCamera(); return; }
            torchOn = await activateTorch(track);
          }
          if (torchOn) log.info("Flash activado y verificado por getSettings()");
          else log.warn("Flash no confirmado — se usará perfil de cámara tolerante");
          await applyTorchDependentParams(track, torchOn);
        } else if (track && isGym) {
          await stabilizeTrack(track, true);
          log.info("Cámara frontal lista para rPPG deportivo");
        }
        if (!alive()) { await stopCamera(); return; }

        log.info(`Cámara ${isGym ? 'frontal (GYM)' : 'trasera'} lista ${videoRef.current?.videoWidth ?? "?"}x${videoRef.current?.videoHeight ?? "?"}`);

        onStreamReadyRef.current?.(stream);

      } catch (err) {
        if (!alive()) {
          // Arranque superado por otro: silenciar el error rancio.
          isStartingRef.current = false;
          return;
        }
        const errType = classifyCameraError(err);
        log.error(`Error al inicializar cámara (${errType})`, err);

        // Reintentar con constraints relajados si es OverconstrainedError
        if (errType === 'overconstrained' && alive()) {
          log.warn("Reintentando con constraints relajados...");
          try {
            const fallbackStream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: { facingMode: isGym ? { ideal: "user" } : { ideal: "environment" } },
            });
            if (alive()) {
              streamRef.current = fallbackStream;
              if (videoRef.current) {
                videoRef.current.srcObject = fallbackStream;
                await waitForVideo(videoRef.current, generation);
              }
              if (!alive()) { await stopCamera(); return; }
              const track = fallbackStream.getVideoTracks()[0];
              if (track) await stabilizeTrack(track, isGym);
              log.info("Cámara iniciada con constraints relajados");
              onStreamReadyRef.current?.(fallbackStream);
              isStartingRef.current = false;
              return;
            }
            fallbackStream.getTracks().forEach(t => { try { t.stop(); } catch { log.debug('fallback late stop failed'); } });
          } catch (fallbackErr) {
            log.error("Reintento con constraints relajados también falló", fallbackErr);
          }
        }

        window.dispatchEvent(new CustomEvent('camera-error', {
          detail: { type: errType, message: (err as Error)?.message || 'Error desconocido' },
        }));
      } finally {
        isStartingRef.current = false;
      }
    };

    const handleInterrupted = (reason: 'hidden' | 'pagehide') => {
      if (!streamRef.current) return;
      log.warn(`Adquisición interrumpida (${reason}): liberando pistas y torch`);
      // Bump de generación: invalida el arranque en vuelo.
      startGenerationRef.current += 1;
      releaseTracksSync();
      isStartingRef.current = false;
      window.dispatchEvent(new CustomEvent('camera-interrupted', {
        detail: { reason },
      }));
      onInterruptedRef.current?.();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') handleInterrupted('hidden');
    };
    const onPageHide = () => handleInterrupted('pagehide');
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);

    if (isMonitoring) {
      startCamera();
    } else {
      stopCamera();
    }

    return () => {
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      stopCamera();
    };
  }, [isMonitoring, measurementMode]);


  return (
    <>
      {/* Video de cámara (trasera directa o frontal espejada para rPPG) */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          imageRendering: "pixelated",
          opacity: 1,
          pointerEvents: "none",
          transform: measurementMode === 'gym' ? "scaleX(-1)" : "none",
        }}
      />
      {measurementMode === 'gym' && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10,
          }}
        >
          {/* Facial Reticle / Face framing guide */}
          <div
            style={{
              width: "220px",
              height: "280px",
              borderRadius: "110px",
              border: `2px dashed ${faceDetected ? "rgba(16, 185, 129, 0.85)" : "rgba(239, 68, 68, 0.7)"}`,
              boxShadow: faceDetected
                ? "0 0 24px rgba(16, 185, 129, 0.35), inset 0 0 20px rgba(16, 185, 129, 0.15)"
                : "0 0 24px rgba(239, 68, 68, 0.25)",
              transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
              position: "relative",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "flex-start",
              paddingTop: "24px",
            }}
          >
            {/* Forehead Target Area Indicator */}
            <div
              style={{
                width: "96px",
                height: "36px",
                borderRadius: "8px",
                border: `1.5px solid ${faceDetected ? "rgba(59, 130, 246, 0.85)" : "rgba(148, 163, 184, 0.4)"}`,
                background: faceDetected ? "rgba(59, 130, 246, 0.2)" : "rgba(15, 23, 42, 0.4)",
                backdropFilter: "blur(4px)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "10px",
                fontWeight: 700,
                letterSpacing: "0.08em",
                color: faceDetected ? "#93c5fd" : "#94a3b8",
                textTransform: "uppercase",
              }}
            >
              ROI rPPG
            </div>
            {/* Status Pill at Bottom of Reticle */}
            <div
              style={{
                position: "absolute",
                bottom: "-32px",
                padding: "4px 12px",
                borderRadius: "12px",
                background: faceDetected ? "rgba(16, 185, 129, 0.9)" : "rgba(239, 68, 68, 0.9)",
                color: "#ffffff",
                fontSize: "10px",
                fontWeight: 700,
                letterSpacing: "0.05em",
                boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                textTransform: "uppercase",
              }}
            >
              {faceDetected ? "ROSTRO BLOQUEADO" : "ENFOCAR ROSTRO"}
            </div>
          </div>
        </div>
      )}
      {measurementMode !== 'gym' && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "flex-end",
            paddingBottom: "18px",
            zIndex: 10,
          }}
        >
          {/* Guía de colocación del dedo sobre la cámara trasera */}
          <div
            role="status"
            aria-live="polite"
            style={{
              padding: "6px 14px",
              borderRadius: "14px",
              background: "rgba(0, 0, 0, 0.62)",
              border: "1px solid rgba(255, 255, 255, 0.14)",
              color: "#f4f4f5",
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
              textAlign: "center",
              maxWidth: "86%",
            }}
          >
            Cubre el lente trasero con el dedo · sin presionar
          </div>
          <div
            style={{
              marginTop: "6px",
              fontSize: "10px",
              color: "rgba(255,255,255,0.62)",
              letterSpacing: "0.04em",
              textAlign: "center",
              maxWidth: "86%",
            }}
          >
            Si el flash no está disponible, se usará luz ambiental y solo se
            aceptará señal que pase los controles de calidad
          </div>
        </div>
      )}
    </>
  );
});

CameraView.displayName = "CameraView";

export default CameraView;
