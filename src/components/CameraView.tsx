import React, { useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import { createLogger } from "@/utils/logger";
import { clamp } from "@/utils/math";
import { Camera } from '@capacitor/camera';
import { isNative } from "@/lib/device/platform";
import { startLensCoLocationScan, type LensScanResult } from "@/lib/device/lensCoLocation";
import { toast } from "@/hooks/use-toast";
import { FingerExposureRecovery, type FingerExposurePhotometry } from '@/lib/device/exposureRecovery';
import type { CameraCaptureState } from '@/types/measurements';

const log = createLogger("CameraView");

export interface CameraViewHandle {
  getVideoElement: () => HTMLVideoElement | null;
  getDiagnostics: () => Record<string, unknown>;
  getAcquisitionState: () => CameraCaptureState;
  /**
   * Fija los valores medidos ya convergidos, una vez en STABLE_CONTACT.
   * El bloqueo no cambia la ganancia hacia un brillo objetivo.
   */
  optimizeForFinger: (redLevel: number) => void;
  /** Restaura AE/AWB continuos al perder el contacto y cancela locks pendientes. */
  resumeFingerAcquisition: () => void;
  /** Compensa recorte sostenido con AE automático, antes de fijar la escena. */
  recoverFingerExposure: (photometry: FingerExposurePhotometry, timestampMs: number) => void;
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

async function applyCameraStep(
  track: MediaStreamTrack,
  constraint: AdvancedConstraint,
  what: string,
  isCurrent: () => boolean,
  markChange: () => void,
): Promise<boolean> {
  if (!isCurrent()) return false;
  try {
    markChange();
    await track.applyConstraints({ advanced: [constraint] });
    if (!isCurrent()) return false;
    const settings = track.getSettings?.() as Record<string, unknown> | undefined;
    const verified = settings && Object.entries(constraint).every(([key, value]) => {
      const actual = settings[key];
      return typeof value === 'number'
        ? typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - value) <= Math.max(1e-6, Math.abs(value) * 1e-6)
        : actual === value;
    });
    if (!verified) log.warn(`${what} no confirmado por settings`);
    return !!verified;
  } catch (error) {
    log.warn(`${what} no aceptado (best-effort)`, error);
    return false;
  }
}

function measuredValue(value: unknown, range: { min?: number; max?: number } | undefined): number | undefined {
  if (!range || typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const min = typeof range.min === 'number' && Number.isFinite(range.min) ? range.min : value;
  const max = typeof range.max === 'number' && Number.isFinite(range.max) ? range.max : value;
  return min <= max ? clamp(value, min, max) : undefined;
}

async function restoreAutomatic(track: MediaStreamTrack, isCurrent: () => boolean, markChange: () => void): Promise<void> {
  const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
  // Independent calls: an unsupported optional control must not block AE/AWB.
  if (caps.exposureMode?.includes('continuous')) {
    await applyCameraStep(track, { exposureMode: 'continuous' }, 'AE continuo', isCurrent, markChange);
  }
  if (caps.whiteBalanceMode?.includes('continuous')) {
    await applyCameraStep(track, { whiteBalanceMode: 'continuous' }, 'AWB continuo', isCurrent, markChange);
  }
}

async function stabilizeTrack(track: MediaStreamTrack, isCurrent: () => boolean, markChange: () => void): Promise<void> {
  const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
  if (caps.frameRate && Number.isFinite(caps.frameRate.max)) {
    const min = caps.frameRate.min ?? 0;
    const target = Math.max(min, Math.min(30, caps.frameRate.max!));
    if (target > 0) await applyCameraStep(track, { frameRate: target }, 'FPS', isCurrent, markChange);
  }
  // AE/AWB remain continuous throughout placement. Only focus can be fixed now.
  await restoreAutomatic(track, isCurrent, markChange);
  if (caps.focusMode?.includes('manual')) {
    if (await applyCameraStep(track, { focusMode: 'manual' }, 'foco manual', isCurrent, markChange)) {
      const near = caps.focusDistance?.min;
      if (typeof near === 'number' && Number.isFinite(near)) {
        await applyCameraStep(track, { focusDistance: near }, 'distancia de foco', isCurrent, markChange);
      }
    }
  } else if (caps.focusMode?.includes('continuous')) {
    await applyCameraStep(track, { focusMode: 'continuous' }, 'foco continuo', isCurrent, markChange);
  }
}

async function lockConvergedTrack(track: MediaStreamTrack, isCurrent: () => boolean, markChange: () => void): Promise<void> {
  const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
  // Read BEFORE changing modes: some drivers replace the measured values with
  // defaults on entering manual. Preserve the scene that earned stable contact.
  const before = (track.getSettings?.() ?? {}) as ExtendedSettings;
  const temperature = measuredValue(before.colorTemperature, caps.colorTemperature);
  const iso = measuredValue(before.iso, caps.iso);
  const exposureTime = measuredValue(before.exposureTime, caps.exposureTime);
  if (caps.whiteBalanceMode?.includes('manual') && temperature !== undefined) {
    if (await applyCameraStep(track, { whiteBalanceMode: 'manual' }, 'WB manual', isCurrent, markChange)) {
      if (!await applyCameraStep(track, { colorTemperature: temperature }, 'temperatura WB', isCurrent, markChange) &&
        caps.whiteBalanceMode.includes('continuous')) {
        await applyCameraStep(track, { whiteBalanceMode: 'continuous' }, 'restaurar AWB', isCurrent, markChange);
      }
    }
  }
  // Without a measured manual value, leave automatic exposure running. A
  // supported manual mode alone cannot reproduce the converged exposure.
  if (caps.exposureMode?.includes('manual') && (iso !== undefined || exposureTime !== undefined)) {
    if (await applyCameraStep(track, { exposureMode: 'manual' }, 'exposición manual', isCurrent, markChange)) {
      let preserved = true;
      if (iso !== undefined) preserved = await applyCameraStep(track, { iso }, 'ISO convergido', isCurrent, markChange) && preserved;
      if (exposureTime !== undefined) preserved = await applyCameraStep(track, { exposureTime }, 'tiempo convergido', isCurrent, markChange) && preserved;
      if (!preserved && caps.exposureMode.includes('continuous')) {
        await applyCameraStep(track, { exposureMode: 'continuous' }, 'restaurar AE', isCurrent, markChange);
      }
    }
  }
}

const CameraView = forwardRef<CameraViewHandle, CameraViewProps>((
  { onStreamReady, isMonitoring},
  ref
) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  const streamRef = useRef<MediaStream | null>(null);

  const cameraGenerationRef = useRef(0);
  const retiringRef = useRef<Promise<void>>(Promise.resolve());
  const exposureRecoveryRef = useRef(new FingerExposureRecovery());

  // Último resultado del profiling de co-ubicación lente↔flash (solo diagnóstico).
  const lastLensScanRef = useRef<LensScanResult | null>(null);


  useImperativeHandle(ref, () => ({
    getVideoElement: () => videoRef.current,
    getAcquisitionState: () => exposureRecoveryRef.current.getAcquisitionState(),
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
          exposureRecovery: exposureRecoveryRef.current.getDiagnostics(),
        };
      } catch {
        log.warn('Camera diagnostics failed');
        return { active: true, error: "caps_unavailable" };
      }
    },
    recoverFingerExposure: (photometry, timestampMs) => {
      const track = streamRef.current?.getVideoTracks?.()[0];
      if (track) void exposureRecoveryRef.current.observe(track, photometry, timestampMs);
    },
    resumeFingerAcquisition: () => {
      const track = streamRef.current?.getVideoTracks?.()[0];
      if (track) {
        void exposureRecoveryRef.current.resumeAcquisition(track, (isCurrent, markChange) => restoreAutomatic(track, isCurrent, markChange))
          .catch(error => log.warn('No se pudo restaurar adquisición automática', error));
      }
    },
    optimizeForFinger: (redLevel: number) => {
      const track = streamRef.current?.getVideoTracks?.()[0];
      if (!track || !Number.isFinite(redLevel) || redLevel <= 0) return;
      void exposureRecoveryRef.current.lockForFinger(track, (isCurrent, markChange) => lockConvergedTrack(track, isCurrent, markChange))
        .catch(error => log.warn('No se pudo fijar el ISP convergido', error));
    },
  }), []);

  useEffect(() => {
    const mountedVideo = videoRef.current;
    const generation = ++cameraGenerationRef.current;
    const abort = new AbortController();
    const ownsCamera = () => cameraGenerationRef.current === generation && !abort.signal.aborted;

    const stopCamera = () => {
      const recovery = exposureRecoveryRef.current;
      recovery.clear();
      const stream = streamRef.current;
      // Detach synchronously. An older asynchronous teardown must never erase
      // the reference/video belonging to a later startup.
      streamRef.current = null;
      if (mountedVideo?.srcObject === stream) mountedVideo.srcObject = null;
      if (!stream) return retiringRef.current;
      const pending = recovery.whenIdle();
      const retirement = (async () => {
        await pending;
        for (const track of stream.getVideoTracks()) {
          try {
            if (track.readyState === 'live') {
              try {
                await track.applyConstraints({ advanced: [{ torch: false } as TorchCapableConstraint] });
              } catch { log.debug('Torch off (advanced) failed — trying direct'); }
              try {
                await track.applyConstraints({ torch: false } as MediaTrackConstraints);
              } catch { log.debug('Torch off (direct) failed — expected if unsupported'); }
            }
          } finally { track.stop(); }
        }
      })();
      retiringRef.current = retirement;
      return retirement;
    };

    const activateTorch = async (
      track: MediaStreamTrack,
      isCurrent: () => boolean,
      markChange: () => void,
    ): Promise<{ active: boolean; verified: boolean }> => {
      const attempts = [
        { advanced: [{ torch: true } as TorchCapableConstraint] },
        { torch: true } as TorchCapableConstraint,
        { advanced: [{ torch: 'on' }] },
        { advanced: [{ torchMode: 'torch' }] },
      ] as MediaTrackConstraints[];
      for (const constraints of attempts) {
        if (!isCurrent()) return { active: false, verified: false };
        try {
          markChange();
          await track.applyConstraints(constraints);
          if (!isCurrent()) return { active: false, verified: false };
          const settings = (track.getSettings?.() ?? {}) as ExtendedSettings;
          if (settings.torch === true) return { active: true, verified: true };
        } catch { log.debug('Torch attempt failed — trying next syntax'); }
      }
      // Safari may report stale torch settings. Preserve the unverified fallback.
      if (!isCurrent()) return { active: false, verified: false };
      try {
        markChange();
        await track.applyConstraints({ advanced: [{ torch: true } as TorchCapableConstraint] });
        return { active: isCurrent(), verified: false };
      } catch { log.debug('Torch not available on this device'); }
      return { active: false, verified: false };
    };

    const waitForVideo = (video: HTMLVideoElement): Promise<boolean> => new Promise((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('canplay', onReady);
        video.removeEventListener('error', onError);
        abort.signal.removeEventListener('abort', onAbort);
      };
      const finish = (ready: boolean) => { cleanup(); resolve(ready); };
      const onReady = () => {
        if (video.readyState >= 2 && video.videoWidth > 0) finish(true);
      };
      const onAbort = () => finish(false);
      const onError = () => { cleanup(); reject(new Error('No se pudo reproducir el stream de cámara')); };
      if (!ownsCamera()) { resolve(false); return; }
      video.addEventListener('loadeddata', onReady);
      video.addEventListener('canplay', onReady);
      video.addEventListener('error', onError);
      abort.signal.addEventListener('abort', onAbort, { once: true });
      try { void video.play().catch(() => log.debug('Video play() rejected (autoplay policy)')); }
      catch { log.debug('Video play() unavailable'); }
      onReady();
    });

    const startCamera = async () => {
      // A previous instance can still be finishing a driver request. Open the
      // next stream only after that instance has released its hardware.
      await retiringRef.current;
      if (!ownsCamera()) return;
      const permitted = await requestCameraPermission();
      if (!ownsCamera()) return;
      if (!permitted) {
        window.dispatchEvent(new CustomEvent('camera-error', {
          detail: { type: 'permission_denied', message: 'Permiso de cámara denegado' },
        }));
        return;
      }

      try {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: { ideal: 'environment' },
              width: { ideal: 640, max: 960 },
              height: { ideal: 480, max: 720 },
              frameRate: { ideal: 30, min: 15, max: 30 },
            },
          });
        } catch (error) {
          if (classifyCameraError(error) !== 'overconstrained' || !ownsCamera()) throw error;
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false, video: { facingMode: { ideal: 'environment' } },
          });
        }
        if (!ownsCamera()) { stream.getTracks().forEach(track => track.stop()); return; }
        streamRef.current = stream;
        const video = mountedVideo;
        if (!video) { void stopCamera(); return; }
        video.srcObject = stream;
        if (!await waitForVideo(video) || !ownsCamera()) return;

        const track = stream.getVideoTracks()[0];
        if (track) {
          let torch = { active: false, verified: false };
          await exposureRecoveryRef.current.resumeAcquisition(track, async (isCurrent, markChange) => {
            await stabilizeTrack(track, isCurrent, markChange);
            if (!isCurrent()) return;
            torch = await activateTorch(track, isCurrent, markChange);
            if (!torch.active && isCurrent()) {
              await new Promise<void>(resolve => {
                const timer = setTimeout(resolve, 400);
                abort.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
              });
              torch = await activateTorch(track, isCurrent, markChange);
            }
            // Torch activation may reset controls on a driver. Verify the
            // acquisition modes again; never impose an arbitrary ISO/EV preset.
            if (isCurrent()) await restoreAutomatic(track, isCurrent, markChange);
          });
          if (!ownsCamera()) return;
          if (torch.active && torch.verified) log.info('Flash activado (confirmado por settings)');
          else if (torch.active) log.warn('Flash activado sin confirmación de settings');
          else log.warn('Flash no confirmado — se usará perfil de cámara tolerante');

          lastLensScanRef.current = null;
          void startLensCoLocationScan(video, { torchOn: torch.active, torchVerified: torch.verified })
            .then(result => {
              if (!ownsCamera() || streamRef.current !== stream) return;
              lastLensScanRef.current = result;
              if (result.verdict === 'lens-covered-dark') {
                toast({
                  variant: 'destructive',
                  title: 'Lente equivocada detectada',
                  description: 'El flash está activo pero la lente activa queda oscura. Apoya el dedo sobre la lente principal, junto al flash.',
                  duration: 6000,
                });
              }
            })
            .catch(error => log.debug('Escaneo lente/flash no disponible', error));
        }
        if (ownsCamera()) onStreamReady?.(stream);
      } catch (error) {
        if (!ownsCamera()) return;
        const type = classifyCameraError(error);
        log.error(`Error al inicializar cámara trasera (${type})`, error);
        void stopCamera();
        window.dispatchEvent(new CustomEvent('camera-error', {
          detail: { type, message: (error as Error)?.message || 'Error desconocido' },
        }));
      }
    };

    if (isMonitoring) void startCamera();
    else void stopCamera();
    const releaseCamera = () => {
      if (cameraGenerationRef.current === generation) {
        cameraGenerationRef.current++;
        void stopCamera();
      }
    };
    return () => {
      abort.abort();
      releaseCamera();
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

