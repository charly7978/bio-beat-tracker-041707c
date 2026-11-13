import React, { useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import { createLogger } from "@/utils/logger";
import { clamp } from "@/utils/math";
import { Camera } from '@capacitor/camera';
import { isNative } from "@/lib/device/platform";
import { startLensCoLocationScan, type LensScanResult } from "@/lib/device/lensCoLocation";
import { toast } from "@/hooks/use-toast";

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
  faceDetected?: boolean;
}

type TorchCapableConstraint = MediaTrackConstraintSet & { torch?: boolean };
type AdvancedConstraint = MediaTrackConstraintSet & {
  torch?: boolean;
  exposureMode?: string;
  exposureCompensation?: number;
  exposureTime?: number;
  whiteBalanceMode?: string;
  colorTemperature?: number;
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
  colorTemperature?: { min?: number; max?: number };
  iso?: { min?: number; max?: number };
  focusMode?: string[];
  focusDistance?: { min?: number; max?: number };
  frameRate?: { min?: number; max?: number };
};
type ExtendedSettings = MediaTrackSettings & {
  torch?: boolean;
  exposureMode?: string;
  whiteBalanceMode?: string;
  colorTemperature?: number;
  focusMode?: string;
  iso?: number;
  exposureCompensation?: number;
  exposureTime?: number;
};

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
  | 'unknown';

function classifyCameraError(err: unknown): CameraErrorType {
  if (err instanceof DOMException || (err as Error)?.name) {
    const name = (err as DOMException).name;
    if (name === 'NotAllowedError') return 'permission_denied';
    if (name === 'NotFoundError') return 'not_found';
    if (name === 'NotReadableError') return 'not_readable';
    if (name === 'OverconstrainedError' || name === 'OverconstrainedError') return 'overconstrained';
    if (name === 'AbortError') return 'abort';
  }
  return 'unknown';
}

async function stabilizeTrack(track: MediaStreamTrack): Promise<void> {
  const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
  const constraints: AdvancedConstraint[] = [];

  if (caps.frameRate) {
    const maxFps = caps.frameRate.max ?? 30;
    const targetFps = Math.min(30, maxFps);
    constraints.push({ frameRate: targetFps });
  }

  // Exposición y WB en CONTINUO durante la COLOCACIÓN del dedo: el AE/AWB deben
  // ADAPTARSE al dedo que baja, no congelarse sobre la escena vacía (flash sin
  // dedo). El bloqueo anti-deriva se DIFIERE a optimizeForFinger(), que congela
  // exposición/WB ya sobre la escena REAL del dedo en STABLE_CONTACT (ver doc de
  // optimizeForFinger). Congelar acá la escena vacía retrasaba la convergencia
  // (~25-30 s) porque el frame del dedo quedaba mal expuesto hasta STABLE_CONTACT.
  if (caps.exposureMode?.includes("continuous")) {
    constraints.push({ exposureMode: "continuous" });
  }

  if (caps.whiteBalanceMode?.includes("continuous")) {
    constraints.push({ whiteBalanceMode: "continuous" });
  }

  // Foco cercano fijo desde el inicio: el dedo siempre está pegado al lente, así
  // que el foco manual a mínima distancia es estable y correcto (no introduce
  // deriva ni "hunting"). Es lo único que conviene fijar antes del dedo.
  if (caps.focusMode?.includes("manual")) {
    constraints.push({ focusMode: "manual", focusDistance: 0 });
  } else if (caps.focusMode?.includes("continuous")) {
    constraints.push({ focusMode: "continuous" });
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

const CameraView = forwardRef<CameraViewHandle, CameraViewProps>((
  { onStreamReady, isMonitoring},
  ref
) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  const streamRef = useRef<MediaStream | null>(null);

  const isStartingRef = useRef(false);

  // Último resultado del profiling de co-ubicación lente↔flash (solo diagnóstico).
  const lastLensScanRef = useRef<LensScanResult | null>(null);


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
          lensCoLocation: lastLensScanRef.current,
        };
      } catch {
        log.warn('Camera diagnostics failed');
        return { active: true, error: "caps_unavailable" };
      }
    },
    optimizeForFinger: (redLevel: number) => {
      const track = streamRef.current?.getVideoTracks?.()[0];
      if (!track) return;
      void (async () => {
        try {
          const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
          let appliedSteps = 0;

          // Bloqueo SECUENCIAL de controles analógicos (ISP): cada constraint va
          // en su propia llamada y EN ORDEN. En un mismo array `advanced`, Chrome
          // ignora el valor de exposición (iso/exposureTime/EC) enviado en la
          // misma llamada que el cambio exposureMode→manual, y un entry que
          // falla impide aplicar los siguientes. Modo primero, valor después.
          const applyStep = async (c: AdvancedConstraint, what: string): Promise<boolean> => {
            try {
              await track.applyConstraints({ advanced: [c] });
              appliedSteps++;
              return true;
            } catch (e) {
              log.warn(`${what} no aceptado (best-effort)`, e);
              return false;
            }
          };

          if (caps.focusMode?.includes("manual")) {
            const near = typeof caps.focusDistance?.min === "number" ? caps.focusDistance.min : 0;
            await applyStep({ focusMode: "manual", focusDistance: near }, "focus manual");
          } else {
            log.warn("focus manual no soportado: el AF del ISP puede derivar sobre el dedo");
          }
          if (caps.whiteBalanceMode?.includes("manual")) {
            if (await applyStep({ whiteBalanceMode: "manual" }, "WB manual")) {
              // En WB manual, `colorTemperature` es el único valor expuesto por la
              // API web (W3C Image Capture §9.4.1). Fijarlo al valor que el AWB ya
              // había convergido sobre el dedo congela las ganancias por canal sin
              // introducir un salto cromático.
              const wbSettings = (track.getSettings?.() ?? {}) as ExtendedSettings;
              if (caps.colorTemperature && typeof wbSettings.colorTemperature === "number") {
                const kMin = caps.colorTemperature.min ?? wbSettings.colorTemperature;
                const kMax = caps.colorTemperature.max ?? wbSettings.colorTemperature;
                await applyStep(
                  { colorTemperature: clamp(wbSettings.colorTemperature, kMin, kMax) },
                  "temperatura WB",
                );
              }
            }
          } else {
            log.warn("WB manual no soportado: el AWB del ISP puede derivar");
          }
          if (caps.exposureMode?.includes("manual")) {
            if (redLevel <= 0) {
              log.warn("exposición manual disponible pero aún sin nivel de rojo del dedo");
            } else if (await applyStep({ exposureMode: "manual" }, "exposure manual")) {
              // El VALOR se negocia en una llamada POSTERIOR al cambio de modo,
              // releyendo settings reales ya en manual.
              const settings = (track.getSettings?.() ?? {}) as ExtendedSettings;
              const TARGET = 180;
              const ratio = clamp(TARGET / redLevel, 0.45, 2.2);
              const value: AdvancedConstraint = {};
              if (caps.iso && typeof caps.iso.max === "number") {
                const isoMin = caps.iso.min ?? 25;
                const isoMax = caps.iso.max ?? 800;
                const curIso = settings.iso ?? (isoMin + isoMax) / 2;
                value.iso = clamp(Math.round(curIso * ratio), isoMin, isoMax);
              } else if (caps.exposureCompensation) {
                const evMin = caps.exposureCompensation.min ?? -2;
                const evMax = caps.exposureCompensation.max ?? 2;
                const curEv = settings.exposureCompensation ?? 0;
                value.exposureCompensation = clamp(curEv + clamp(Math.log2(ratio), -1, 1), evMin, evMax);
              } else if (caps.exposureTime && typeof settings.exposureTime === "number") {
                const etMin = caps.exposureTime.min ?? settings.exposureTime;
                const etMax = caps.exposureTime.max ?? settings.exposureTime;
                value.exposureTime = clamp(settings.exposureTime * ratio, etMin, etMax);
              }
              if (Object.keys(value).length > 0) {
                await applyStep(value, "valor de exposición");
              }
              // El tiempo de integración también es significativo en exposición
              // manual (W3C Image Capture §9.4.1). Fijarlo explícitamente evita que
              // el driver lo reajuste y promedie el pulso en ventanas más largas
              // (efecto low-pass sobre la AC). Es best-effort y capability-gated.
              const expSettings = (track.getSettings?.() ?? {}) as ExtendedSettings;
              if (caps.exposureTime && typeof expSettings.exposureTime === "number") {
                const etMin = caps.exposureTime.min ?? expSettings.exposureTime;
                const etMax = caps.exposureTime.max ?? expSettings.exposureTime;
                await applyStep(
                  { exposureTime: clamp(expSettings.exposureTime, etMin, etMax) },
                  "tiempo de exposición",
                );
              }
            }
          } else {
            log.warn("exposure manual no soportado: el AE del ISP puede modular la AC");
          }

          // Verificación real del bloqueo: settings post-aplicación (no la
          // constraint enviada). Queda expuesto también vía getDiagnostics().
          const after = (track.getSettings?.() ?? {}) as ExtendedSettings;
          if (caps.focusMode?.includes("manual") && after.focusMode !== "manual") {
            log.warn(`Focus no quedó bloqueado (settings.focusMode=${after.focusMode ?? 'n/a'})`);
          }
          if (caps.whiteBalanceMode?.includes("manual") && after.whiteBalanceMode !== "manual") {
            log.warn(`WB no quedó bloqueado (settings.whiteBalanceMode=${after.whiteBalanceMode ?? 'n/a'})`);
          }
          if (caps.exposureMode?.includes("manual") && after.exposureMode !== "manual") {
            log.warn(`Exposición no quedó bloqueada (settings.exposureMode=${after.exposureMode ?? 'n/a'})`);
          }
          log.info(
            `ISP lock: exposure=${after.exposureMode ?? 'n/a'} iso=${after.iso ?? 'n/a'} tExp=${after.exposureTime ?? 'n/a'} wb=${after.whiteBalanceMode ?? 'n/a'} k=${after.colorTemperature ?? 'n/a'} focus=${after.focusMode ?? 'n/a'} (red=${redLevel.toFixed(0)}, ${appliedSteps} pasos)`,
          );
        } catch (e) {
          log.warn("optimizeForFinger falló (best-effort)", e);
        }
      })();
    },
  }), []);

  useEffect(() => {
    const mountedRef = { current: true };

    const stopCamera = async () => {
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

    const activateTorch = async (track: MediaStreamTrack): Promise<{ active: boolean; verified: boolean }> => {
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
          if (settings.torch === true) return { active: true, verified: true };
        } catch { log.debug('Torch attempt failed — trying next syntax'); }
      }
      // Último intento: sin verificar settings, confiar en que applyConstraints funcionó
      try {
        await track.applyConstraints({ advanced: [{ torch: true } as TorchCapableConstraint] });
        return { active: true, verified: false };
      } catch { log.debug('Torch not available on this device'); }
      log.warn("Torch no disponible en este dispositivo");
      return { active: false, verified: false };
    };

    const waitForVideo = (video: HTMLVideoElement): Promise<void> => {
      return new Promise(resolve => {
        if (video.readyState >= 2 && video.videoWidth > 0) { resolve(); return; }
        const onMeta = async () => {
          video.removeEventListener("loadedmetadata", onMeta);
          try { await video.play(); } catch { log.debug('Video play() rejected (autoplay policy)'); }
          resolve();
        };
        video.addEventListener("loadedmetadata", onMeta);
      });
    };

    const startCamera = async () => {
      if (isStartingRef.current) return;
      isStartingRef.current = true;

      await stopCamera();
      if (!mountedRef.current) { isStartingRef.current = false; return; }

      // 1. Solicitar permiso nativo en APK antes de getUserMedia
      const permitted = await requestCameraPermission();
      if (!permitted) {
        log.error("Permiso de cámara denegado");
        window.dispatchEvent(new CustomEvent('camera-error', {
          detail: { type: 'permission_denied', message: 'Permiso de cámara denegado' },
        }));
        isStartingRef.current = false;
        return;
      }

      try {
        // 2. Cámara Trasera (Dedo + PPG)
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 640, max: 960 },
            height: { ideal: 480, max: 720 },
            frameRate: { ideal: 30, min: 15, max: 30 },
          },
        });

        if (!mountedRef.current) {
          stream.getTracks().forEach(t => t.stop());
          isStartingRef.current = false;
          return;
        }

        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await waitForVideo(videoRef.current);
        }

        const track = stream.getVideoTracks()[0];
        if (track) {
          await stabilizeTrack(track);
          let torch = await activateTorch(track);
          if (!torch.active) {
            await new Promise(r => setTimeout(r, 400));
            torch = await activateTorch(track);
          }
          if (torch.active && torch.verified) log.info("Flash activado (confirmado por settings)");
          else if (torch.active) log.warn("Flash activado sin confirmación de settings — diagnóstico de lente limitado");
          else log.warn("Flash no confirmado — se usará perfil de cámara tolerante");
          await applyTorchDependentParams(track, torch.active);

          // Profiling de co-ubicación lente↔flash: mide el flujo lumínico de los
          // primeros ~500 ms con torch y alerta si el dedo cubrió una lente SIN
          // flash (gran angular/tele en equipos multi-lente: `facingMode:
          // environment` no garantiza la lente principal). Fire-and-forget: no
          // retrasa onStreamReady y NO toca el pipeline de medición.
          if (videoRef.current) {
            lastLensScanRef.current = null;
            void startLensCoLocationScan(videoRef.current, {
              torchOn: torch.active,
              torchVerified: torch.verified,
            })
              .then(result => {
                lastLensScanRef.current = result;
                if (result.verdict === 'lens-covered-dark') {
                  toast({
                    variant: "destructive",
                    title: "Lente equivocada detectada",
                    description:
                      "El flash está activo pero la lente activa queda oscura. Apoya el dedo sobre la lente principal, junto al flash.",
                    duration: 6000,
                  });
                }
              })
              .catch(e => log.debug("Escaneo lente/flash no disponible", e));
          }
        }

        log.info(`Cámara trasera lista ${videoRef.current?.videoWidth ?? "?"}x${videoRef.current?.videoHeight ?? "?"}`);

        onStreamReady?.(stream);


      } catch (err) {
        const errType = classifyCameraError(err);
        log.error(`Error al inicializar cámara trasera (${errType})`, err);

        // Reintentar con constraints relajados si es OverconstrainedError
        if (errType === 'overconstrained' && mountedRef.current) {
          log.warn("Reintentando con constraints relajados...");
          try {
            const fallbackStream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: { facingMode: { ideal: "environment" } },
            });
            if (mountedRef.current) {
              streamRef.current = fallbackStream;
              if (videoRef.current) {
                videoRef.current.srcObject = fallbackStream;
                await waitForVideo(videoRef.current);
              }
              const track = fallbackStream.getVideoTracks()[0];
              if (track) await stabilizeTrack(track);
              log.info("Cámara iniciada con constraints relajados");
              onStreamReady?.(fallbackStream);
              isStartingRef.current = false;
              return;
            }
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

    if (isMonitoring) {
      startCamera();
    } else {
      stopCamera();
    }

    return () => {
      mountedRef.current = false;
      stopCamera();
    };
  }, [isMonitoring, onStreamReady]);

  return (
    <>
      {/* Cámara trasera principal (fondo completo) */}
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
        }}
      />
    </>
  );
});

CameraView.displayName = "CameraView";

export default CameraView;
