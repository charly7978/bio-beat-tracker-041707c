import { useState, useRef, useCallback, useEffect } from 'react';
import { playCompletionSound } from '@/utils/soundUtils';
import { triggerSessionStartHaptic, triggerSessionEndHaptic } from '@/utils/haptics';
import { logWarn } from '@/utils/logger';
import { inferCameraRuntimeHints } from '@/lib/device/cameraDeviceProfile';
import { createDefaultVitalSignsResult } from '@/lib/vitals/defaultVitalSignsResult';
import type { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { DSP_CONSTANTS } from '@/config/signalProcessing';
import { startSession as startAuditSession } from '@/lib/sanity/sanityAuditLog';
import {
  MeasurementWindowValidator,
  type ValidationFrame,
  type ValidationVerdict,
} from '@/lib/acquisition/MeasurementWindowValidator';
import { healthBridge } from '@/lib/capacitor/healthBridge';
import type { CameraViewHandle } from '@/components/CameraView';

/** Contador monótono local: fallback determinista cuando crypto.randomUUID no existe. */
let auditSessionFallbackSeq = 0;

interface UseMeasurementSessionInput {
  cameraRef: React.RefObject<CameraViewHandle>;
  startFrameLoop: () => void;
  stopFrameLoop: () => void;
  startProcessing: () => void;
  stopProcessing: () => void;
  startCalibration: () => void;
  forceCalibrationCompletion: () => void;
  resetVitalSigns: () => VitalSignsResult | null;
  fullResetVitalSigns: () => void;
  resetHeartBeat: () => void;
  saveMeasurement: (data: {
    vitalSigns: VitalSignsResult;
    signalQuality: number;
    artifactMetrics?: {
      motionArtifactRatio: number;
      saturationRatio: number;
      underexposureRatio: number;
      totalFrames: number;
    };
    windowSeconds?: number;
  }) => Promise<boolean>;
  /** Reset duro del procesador PPG (fin/inicio de sesión y cambio de cámara). */
  resetProcessor: () => void;
  syncCameraHints: () => void;
  resetFingerContactSession: () => void;
  resetSessionRefs: () => void;
  setHeartbeatSignal: (v: number) => void;
  setBeatMarker: (v: number) => void;
  setRRIntervals: (v: number[]) => void;
  setVitalSigns: (v: VitalSignsResult | ((prev: VitalSignsResult) => VitalSignsResult)) => void;
  vitalSignsRef: React.MutableRefObject<VitalSignsResult>;
  totalBeatsRef: React.MutableRefObject<number>;
  arrhythmiaBeatsRef: React.MutableRefObject<number>;
  motionArtifactFramesRef: React.MutableRefObject<number>;
  saturationFramesRef: React.MutableRefObject<number>;
  underexposedFramesRef: React.MutableRefObject<number>;
  artifactCheckFramesRef: React.MutableRefObject<number>;
  lastArrhythmiaData: React.MutableRefObject<{ timestamp: number; rmssd: number; rrVariation: number } | null>;
  isMonitoringRef: React.MutableRefObject<boolean>;
  lastSignal: import('@/types/signal').ProcessedSignal | null;
  sanityProfileId: string;
  setHeartBeatRuntimeHints: (hints: import('@/lib/device/cameraDeviceProfile').CameraRuntimeHints) => void;
}

export function useMeasurementSession({
  cameraRef,
  startFrameLoop, stopFrameLoop,
  startProcessing, stopProcessing,
  startCalibration, forceCalibrationCompletion,
  resetVitalSigns, fullResetVitalSigns,
  resetHeartBeat,
  saveMeasurement,
  resetProcessor,
  syncCameraHints,
  resetFingerContactSession,
  resetSessionRefs,
  setHeartbeatSignal, setBeatMarker, setRRIntervals,
  setVitalSigns,
  vitalSignsRef,
  totalBeatsRef, arrhythmiaBeatsRef,
  motionArtifactFramesRef, saturationFramesRef,
  underexposedFramesRef, artifactCheckFramesRef,
  lastArrhythmiaData,
  isMonitoringRef,
  lastSignal,
  sanityProfileId,
  setHeartBeatRuntimeHints,
}: UseMeasurementSessionInput) {
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [measurementSummary, setLocalMeasurementSummary] = useState<{
    totalBeats: number;
    arrhythmiaBeats: number;
    normalPercent: number;
  } | null>(null);
  const [showResults, setLocalShowResults] = useState(false);
  const [validationVerdict, setValidationVerdict] = useState<ValidationVerdict | null>(null);

  const validationBufferRef = useRef<ValidationFrame[]>([]);
  const measurementTimerRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const monitoringStartedAtRef = useRef<number>(0);
  /** Identidad de la cámara activa: cambiarla obliga a un reset del pipeline. */
  const activeCameraKeyRef = useRef<string | null>(null);

  // Fullscreen
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element };
      setIsFullscreen(Boolean(doc.fullscreenElement || doc.webkitFullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Wake lock
  const requestWakeLock = useCallback(async () => {
    if ('wakeLock' in navigator && navigator.wakeLock) {
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      } catch {
        logWarn('useMeasurementSession', 'WakeLock request failed');
      }
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    if (wakeLockRef.current) {
      wakeLockRef.current.release();
      wakeLockRef.current = null;
    }
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isMonitoring) {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const preventScroll = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.closest('.overflow-y-auto')) {
        return;
      }
      e.preventDefault();
    };

    if (isMonitoring) {
      document.body.addEventListener('touchmove', preventScroll, { passive: false });
      document.body.addEventListener('scroll', preventScroll, { passive: false });
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.body.removeEventListener('touchmove', preventScroll);
      document.body.removeEventListener('scroll', preventScroll);
      releaseWakeLock();
    };
  }, [isMonitoring, requestWakeLock, releaseWakeLock]);

  useEffect(() => {
    if (isMonitoring) {
      if (monitoringStartedAtRef.current === 0) {
        monitoringStartedAtRef.current = performance.now();
      }
    } else {
      monitoringStartedAtRef.current = 0;
    }
  }, [isMonitoring]);

  // Acumular fotogramas en el buffer de validación clínica durante la sesión
  useEffect(() => {
    if (!isMonitoring || !lastSignal) return;
    const diag = lastSignal.diagnostics as Record<string, unknown> | undefined;
    const sqm = diag?.sqm as Record<string, number> | undefined;
    const hasContact =
      (!!lastSignal.fingerDetected || !!lastSignal.faceDetected) &&
      lastSignal.contactState !== 'NO_CONTACT';
    const frame: ValidationFrame = {
      sqi: lastSignal.quality || 0,
      pi: lastSignal.perfusionIndex || 0,
      fps: sqm?.fpsEffective ?? DSP_CONSTANTS.DEFAULT_SAMPLE_RATE,
      jitter: sqm?.timestampJitterMs ?? 0,
      motion: sqm?.motionScore ?? (lastSignal.motionArtifact ? 1 : 0),
      isClipping: (sqm?.saturationRatio ?? 0) > VITAL_THRESHOLDS.QUALITY.CLIPPING_SATURATION_RATIO,
      hasContact,
    };
    validationBufferRef.current.push(frame);
  }, [lastSignal, isMonitoring]);

  // Fullscreen
  const enterFullScreen = useCallback(async () => {
    if (isFullscreen) return;
    // Ocultar splash INMEDIATAMENTE (primera instrucción, sin condiciones)
    setIsFullscreen(true);
    // Intento best-effort de fullscreen nativo + orientación
    try {
      const docEl = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
      if (docEl.requestFullscreen) await docEl.requestFullscreen();
      else if (docEl.webkitRequestFullscreen) await docEl.webkitRequestFullscreen();
    } catch {
      logWarn('useMeasurementSession', 'Fullscreen request failed');
    }
    try {
      const orient = screen.orientation as ScreenOrientation & { lock?: (o: OrientationLockType) => Promise<void> };
      if (orient?.lock) await orient.lock('portrait').catch(() => undefined);
    } catch {
      logWarn('useMeasurementSession', 'Screen orientation lock failed');
    }
  }, [isFullscreen]);



  // === INICIO DE MONITOREO ===
  const startMonitoring = useCallback(() => {
    if (isMonitoring) return;

    triggerSessionStartHaptic().catch(() => undefined);

    enterFullScreen();
    setLocalShowResults(false);
    setLocalMeasurementSummary(null);
    setValidationVerdict(null);
    validationBufferRef.current = [];
    setElapsedTime(0);
    totalBeatsRef.current = 0;
    arrhythmiaBeatsRef.current = 0;
    // arrhythmia se resetea desde VitalSignsProcessor; no hay propiedad plana

    // Reset duro ANTES de arrancar: la sesión nueva no hereda baselines,
    // banda adaptativa, hints de cámara ni estadísticas de la anterior.
    activeCameraKeyRef.current = null;
    resetProcessor();
    startProcessing();
    setIsCameraOn(true);
    setIsMonitoring(true);
    requestWakeLock();

    if (measurementTimerRef.current) {
      clearInterval(measurementTimerRef.current);
    }
    measurementTimerRef.current = window.setInterval(() => {
      setElapsedTime(prev => prev + 1);
    }, 1000);

    const auditSessionId =
      globalThis.crypto?.randomUUID?.() ?? `s-${Date.now().toString(36)}-${auditSessionFallbackSeq++}`;
    startAuditSession(auditSessionId, sanityProfileId);

    startCalibration();
    resetFingerContactSession();
    setHeartBeatRuntimeHints(inferCameraRuntimeHints());
  }, [isMonitoring, enterFullScreen, startProcessing, startCalibration, requestWakeLock, sanityProfileId, setHeartBeatRuntimeHints, totalBeatsRef, arrhythmiaBeatsRef, resetFingerContactSession, resetProcessor]);

  // === CUANDO LA CÁMARA ESTÁ LISTA ===
  const handleStreamReady = useCallback((stream: MediaStream) => {
    setCameraStream(stream);
    // Cambio de cámara/track (o re-negociación del stream) ⇒ el pipeline queda
    // caracterizado para otro sensor: reset duro para no arrastrar estado.
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings?.();
    const cameraKey = `${settings?.deviceId ?? track?.id ?? 'unknown'}|${settings?.width ?? 0}x${settings?.height ?? 0}`;
    if (activeCameraKeyRef.current !== null && activeCameraKeyRef.current !== cameraKey) {
      resetProcessor();
    }
    activeCameraKeyRef.current = cameraKey;
    syncCameraHints();
    const video = cameraRef.current?.getVideoElement();
    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      startFrameLoop();
      return;
    }
    if (video) {
      const onCanPlay = () => {
        video.removeEventListener('canplay', onCanPlay);
        startFrameLoop();
      };
      video.addEventListener('canplay', onCanPlay, { once: true });
    }
  }, [cameraRef, startFrameLoop, syncCameraHints, resetProcessor]);

  // === FINALIZAR MEDICIÓN ===
  const finalizeMeasurement = useCallback(async () => {
    if (!isMonitoring) return;

    playCompletionSound();
    triggerSessionEndHaptic().catch(() => undefined);

    stopFrameLoop();
    if (measurementTimerRef.current) {
      clearInterval(measurementTimerRef.current);
      measurementTimerRef.current = null;
    }

    stopProcessing();

    // Validación de la ventana acumulada contra DURACIÓN REAL de sesión
    // (elapsedTime del reloj de sesión, no conteo de frames con FPS supuesto).
    const verdict = MeasurementWindowValidator.validate(validationBufferRef.current, elapsedTime);
    setValidationVerdict(verdict);

    // La calibración solo se fuerza a cierre si la ventana es aceptada: cerrar
    // la calibración de una sesión inválida fabricaba resultados "completos".
    if (vitalSignsRef.current.isCalibrating && verdict.accepted) {
      forceCalibrationCompletion();
    }

    const savedResults = resetVitalSigns();

    let dataToSave = savedResults ?? vitalSignsRef.current;
    // Puerta de honestidad: sin HR listo por veredicto, el pulso se publica
    // como NO disponible (0/NO_VALID_SIGNAL), nunca se conserva un latido
    // anterior como "resultado". SpO₂/PA dependen de HR listo por
    // construcción del validador, así que tampoco sobreviven.
    if (!verdict.vitalReadiness.hr) {
      dataToSave = {
        ...dataToSave,
        heartRate: { ...dataToSave.heartRate, value: 0, status: 'NO_VALID_SIGNAL' as const },
      };
    }
    const sqForSave = Math.round(
      dataToSave.signalQuality ?? lastSignal?.quality ?? 0,
    );
    const hasMeasurable =
      (dataToSave.heartRate.value != null && dataToSave.heartRate.value > 0) ||
      (dataToSave.spo2.value != null &&
        dataToSave.spo2.value >= VITAL_THRESHOLDS.SPO2.MIN_VALID) ||
      (dataToSave.bloodPressure.value?.systolic ?? 0) > 0;

    const totalCheckFrames = artifactCheckFramesRef.current;
    const artifactMetrics = totalCheckFrames > 0
      ? {
          motionArtifactRatio: motionArtifactFramesRef.current / totalCheckFrames,
          saturationRatio: saturationFramesRef.current / totalCheckFrames,
          underexposureRatio: underexposedFramesRef.current / totalCheckFrames,
          totalFrames: totalCheckFrames,
        }
      : undefined;

    if (hasMeasurable) {
      await saveMeasurement({
        vitalSigns: dataToSave,
        signalQuality: sqForSave,
        artifactMetrics,
        windowSeconds: elapsedTime,
      });
      healthBridge.checkAvailability().then(avail => {
        if (avail) healthBridge.saveVitals(dataToSave);
      }).catch((err) => {
        logWarn('useMeasurementSession', 'HealthBridge save failed: ' + String(err));
      });
    }

    setIsCameraOn(false);

    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }

    setIsMonitoring(false);
    isMonitoringRef.current = false;
    releaseWakeLock();

    if (savedResults) {
      setVitalSigns(savedResults);
    }
    setLocalShowResults(true);

    const total = totalBeatsRef.current;
    const arrBeats = arrhythmiaBeatsRef.current;
    setLocalMeasurementSummary({
      totalBeats: total,
      arrhythmiaBeats: arrBeats,
      normalPercent: total > 0 ? Math.round(((total - arrBeats) / total) * 100) : 100,
    });

    setElapsedTime(0);
  }, [isMonitoring, cameraStream, elapsedTime, stopFrameLoop, stopProcessing, forceCalibrationCompletion, resetVitalSigns, saveMeasurement, vitalSignsRef, lastSignal, releaseWakeLock, isMonitoringRef, totalBeatsRef, arrhythmiaBeatsRef, motionArtifactFramesRef, saturationFramesRef, underexposedFramesRef, artifactCheckFramesRef, setVitalSigns]);

  // === RESET COMPLETO ===
  const handleReset = useCallback(() => {
    stopFrameLoop();
    if (measurementTimerRef.current) {
      clearInterval(measurementTimerRef.current);
      measurementTimerRef.current = null;
    }

    stopProcessing();
    fullResetVitalSigns();
    resetHeartBeat();

    setIsCameraOn(false);

    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }

    setIsMonitoring(false);
    isMonitoringRef.current = false;
    setLocalShowResults(false);
    setLocalMeasurementSummary(null);
    setValidationVerdict(null);
    validationBufferRef.current = [];
    setElapsedTime(0);
    setVitalSigns(createDefaultVitalSignsResult());

    resetSessionRefs();
    setHeartbeatSignal(0);
    setBeatMarker(0);
    setRRIntervals([]);
    lastArrhythmiaData.current = null;
  }, [cameraStream, stopFrameLoop, stopProcessing, fullResetVitalSigns, resetHeartBeat, resetSessionRefs, isMonitoringRef, setHeartbeatSignal, setBeatMarker, setRRIntervals, lastArrhythmiaData, setVitalSigns]);

  // Interrupción de adquisición (pestaña oculta / descarga de página):
  // CameraView ya liberó pistas y torch. La sesión interrumpida NO es válida:
  // reset completo sin guardar (BPM a `--`, buffers vaciados, sin filas).
  useEffect(() => {
    const onInterrupted = () => {
      if (isMonitoringRef.current) {
        handleReset();
      }
    };
    window.addEventListener('camera-interrupted', onInterrupted);
    return () => window.removeEventListener('camera-interrupted', onInterrupted);
  }, [handleReset, isMonitoringRef]);

  // Auto-finalizar a los 90 segundos
  useEffect(() => {
    if (isMonitoring && elapsedTime >= 90) {
      finalizeMeasurement();
    }
  }, [elapsedTime, isMonitoring, finalizeMeasurement]);

  // Sincronizar isMonitoringRef
  useEffect(() => {
    isMonitoringRef.current = isMonitoring;
  }, [isMonitoring, isMonitoringRef]);

  return {
    isMonitoring,
    setIsMonitoring,
    isCameraOn,
    setIsCameraOn,
    elapsedTime,
    setElapsedTime,
    cameraStream,
    setCameraStream,
    measurementSummary,
    showResults,
    isFullscreen,
    startMonitoring,
    handleStreamReady,
    finalizeMeasurement,
    handleReset,
    enterFullScreen,
    setLocalShowResults,
    setLocalMeasurementSummary, validationVerdict,
  };
}
