import { useState, useRef, useCallback, useEffect } from 'react';
import type { ProcessedSignal, ContactState, FingerPlacementMode } from '@/types/signal';
import type { VitalSignsResult, RGBData } from '@/modules/vital-signs/VitalSignsProcessor';
import type { SignalQualityMetrics } from '@/types/measurements';
import type { CameraRuntimeHints } from '@/lib/device/cameraDeviceProfile';
import type { TimedSignalSample } from '@/lib/signal/timedSamples';

import { SignalQualityIndex } from '@/modules/signal-quality/SignalQualityIndex';
import {
  createMeasurementSessionLatch,
  SESSION_LATCH,
  updateMeasurementSessionLatch,
} from '@/lib/measurement/measurementSessionLatch';
import { evaluateMeasurementReadiness } from '@/lib/measurement/measurementReadiness';
import { bpmFromEmittedRr } from '@/lib/measurement/peakEmitPolicy';
import {
  createStabilizationState,
  updateStabilization,
} from '@/lib/measurement/signalStabilization';
import { VitalDisplayFilter } from '@/lib/measurement/displaySmoothing';
import { createDefaultVitalSignsResult } from '@/lib/vitals/defaultVitalSignsResult';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { VitalsSanityChecker } from '@/lib/sanity/vitalsSanity';
import {
  getActiveProfileId,
  getCustomOverrides,
  resolveProfile,
} from '@/lib/sanity/sanityProfiles';
import { recordVerdict as recordAuditVerdict } from '@/lib/sanity/sanityAuditLog';
import { toast } from '@/hooks/use-toast';
import { triggerArrhythmiaHaptic, triggerPressureHaptic } from '@/utils/haptics';
import type { PressureVerdict } from '@/lib/finger/fingerPlacementEvidence';

interface HeartBeatProcessorAPI {
  processSignal: (
    value: number,
    contactState: ContactState,
    timestamp?: number,
    fingerConfirmed?: boolean,
    ppgQuality?: { sqi: number; perfusionIndex?: number; motionScore?: number },
    sampleValid?: boolean,
  ) => {
    bpm: number;
    confidence: number;
    isPeak: boolean;
    filteredValue: number;
    signalQuality: number;
    internalSqi?: number;
    externalSqi?: number;
    ensembleDiagnostics?: Record<string, unknown>;
    rrData?: { intervals: number[]; lastPeakTime: number | null; timestampNow?: number };
  };
  setFingerPlacementMode: (mode: FingerPlacementMode) => void;
  setRuntimeHints: (hints: CameraRuntimeHints) => void;
  reacquirePeaks: (timestamp?: number) => void;
  reset: () => void;
}

interface VitalSignsProcessorAPI {
  processSignal: (
    value: number,
    quality: number,
    bpm: number,
    rrData?: { intervals: number[]; lastPeakTime: number | null; timestampNow?: number },
    perfusionIndexFromPpg?: number,
    sqmBundle?: Partial<SignalQualityMetrics>,
    morphologyValue?: number,
    splitterChannels?: {
      morphologyFiltered?: number;
      respirationFiltered?: number;
      arrhythmiaFiltered?: number;
      spo2Channels?: {
        acRed: number;
        dcRed: number;
        acGreen: number;
        dcGreen: number;
        acBlue?: number;
        dcBlue?: number;
      };
    },
    faceBvp?: number,
    faceBpm?: number,
    faceQuality?: number,
    accelRespiration?: { rpm: number; quality: number },
    morphologyBatch?: TimedSignalSample[],
    sampleTimestampMs?: number,
  ) => VitalSignsResult;
  resetMorphologyWindow: () => void;
  resetRespirationWindow: () => void;
  setPlacementMode: (mode: FingerPlacementMode) => void;
  setRGBData: (data: RGBData) => void;
  getRGBStats: () => { redAC: number; redDC: number; greenAC: number; greenDC: number; blueAC?: number; blueDC?: number; rgRatio: number; ratioOfRatios: number };
}

interface UseSignalRouterInput {
  processHeartBeat: HeartBeatProcessorAPI;
  processVitalSigns: VitalSignsProcessorAPI;
  cameraHintsRef: React.MutableRefObject<CameraRuntimeHints>;
  ppgMeterRef?: React.RefObject<import('@/components/PPGSignalMeter').PPGSignalMeterHandle | null>;
}

// Frame-gates de contacto y throttles/cadencia DSP — fuente única en VITAL_THRESHOLDS.
// A scope de módulo: react-hooks los reconoce como constantes estables (no deps).
const {
  UNSTABLE_ZERO_THRESHOLD_FRAMES: UNSTABLE_ZERO_THRESHOLD,
  SESSION_RESET_FRAMES: NO_CONTACT_SESSION_RESET_FRAMES,
  REGAIN_RESET_MIN_FRAMES: CONTACT_REGAIN_RESET_MIN_FRAMES,
  STALE_PEAK_REACQUIRE_FRAMES,
} = VITAL_THRESHOLDS.CONTACT;
const {
  HR_PUSH_THROTTLE_MS,
  VITALS_PUSH_THROTTLE_MS,
  RR_PUSH_THROTTLE_MS,
  DIAG_PUSH_THROTTLE_MS,
  VITALS_PROCESS_EVERY_N_FRAMES,
} = VITAL_THRESHOLDS.ROUTER;
const {
  FEEDBACK_SETTLE_MS: PRESSURE_FEEDBACK_SETTLE_MS,
  HEAVY_REPEAT_MS: PRESSURE_HEAVY_REPEAT_MS,
  LIGHT_REPEAT_MS: PRESSURE_LIGHT_REPEAT_MS,
  HAPTIC_MIN_INTERVAL_MS: PRESSURE_HAPTIC_MIN_INTERVAL_MS,
  CONTACT_LOST_FRAMES: PRESSURE_CONTACT_LOST_FRAMES,
} = VITAL_THRESHOLDS.PRESSURE;

export function useSignalRouter({ processHeartBeat, processVitalSigns, cameraHintsRef, ppgMeterRef }: UseSignalRouterInput) {
  // Estados de salida
  const [vitalSigns, setVitalSigns] = useState<VitalSignsResult>(createDefaultVitalSignsResult);
  const [heartbeatSignal, setHeartbeatSignal] = useState(0);
  const [beatMarker, setBeatMarker] = useState(0);
  const [rrIntervals, setRRIntervals] = useState<number[]>([]);
  const [currentDiagnostics, setCurrentDiagnostics] = useState<Record<string, unknown> | null>(null);


  // Refs de sesión compartidos
  const vitalSignsRef = useRef<VitalSignsResult>(vitalSigns);
  const totalBeatsRef = useRef(0);
  const arrhythmiaBeatsRef = useRef(0);
  const lastArrhythmiaCountForBeatsRef = useRef(0);
  const arrhythmiaDetectedRef = useRef(false);
  const lastArrhythmiaData = useRef<{ timestamp: number; rmssd: number; rrVariation: number } | null>(null);

  const motionArtifactFramesRef = useRef(0);
  const saturationFramesRef = useRef(0);
  const underexposedFramesRef = useRef(0);
  const artifactCheckFramesRef = useRef(0);

  // Signal routing internals
  const vitalSignsFrameCounter = useRef<number>(0);
  // La morfología PPG se acumula en CADA frame; los signos se orquestan cada 3.
  const morphologyBatchRef = useRef<TimedSignalSample[]>([]);
  const morphologyStreamActiveRef = useRef(false);
  const unstableFrameCounter = useRef<number>(0);
  const measurementLatchRef = useRef(createMeasurementSessionLatch());
  const lastRrSnapshotRef = useRef<{ intervals: number[]; lastPeakTime: number | null } | null>(null);
  const lastGoodBpmRef = useRef(0);
  const lastBpmSeenAtRef = useRef(0);
  const prevHasUsableContactRef = useRef(false);
  const contactStartedAtRef = useRef(0);
  // Bucle cerrado de presión: veredicto canónico + anti-rebote del háptico.
  const pressureVerdictRef = useRef<PressureVerdict>('NONE');
  const pressureNoneSinceRef = useRef(0);
  const lastPressureHapticAtRef = useRef(0);
  const lastContactSeenAtRef = useRef(0);
  const noContactSessionFramesRef = useRef(0);
  const displayFilterRef = useRef(new VitalDisplayFilter());
  const displaySnapshotRef = useRef(vitalSigns);
  const lastHrFilterInputRef = useRef('');
  // Latch de estabilización de adquisición: hasta que la señal estabiliza
  // (acquisitionStage READY) no se publica el número de HR (evita BPM errático
  // mientras la cámara/AE y el contacto se asientan). Una vez estabilizado, se
  // mantiene durante toda la sesión de contacto.
  const acqReadyLatchRef = useRef(false);
  const stabilizationRef = useRef(createStabilizationState());

  // Throttle timers
  const lastHrPushRef = useRef(0);
  const lastVitalsPushRef = useRef(0);
  const lastSignalPushRef = useRef(0);
  const lastRrPushRef = useRef(0);
  const lastDiagPushRef = useRef(0);
  const beatMarkerTimerRef = useRef<number | null>(null);

  // Sanity checker
  const [sanityProfileId, setSanityProfileId] = useState<string>(() => getActiveProfileId());
  const [customJSON, setCustomJSON] = useState<string>(() => {
    const o = getCustomOverrides();
    return Object.keys(o).length ? JSON.stringify(o, null, 2) : "";
  });
  const bpmSanityRef = useRef<VitalsSanityChecker>(
    new VitalsSanityChecker({
      ...resolveProfile(getActiveProfileId()).effective,
      onVerdict: (sample, verdict, win) => {
        recordAuditVerdict(sample, verdict, win);
      },
    })
  );
  // Dedup de error de sanity: el ref es la única fuente de verdad (no hay UI que
  // renderice el mensaje; el aviso al usuario va por toast más abajo).
  const sanityErrorRef = useRef<string | null>(null);
  const sanityToastAtRef = useRef<number>(0);
  const isMonitoringRef = useRef(false);

  // Cleanup: cancela cualquier timer pendiente al desmontar para evitar
  // setBeatMarker sobre un componente desmontado.
  useEffect(() => {
    return () => {
      if (beatMarkerTimerRef.current) {
        window.clearTimeout(beatMarkerTimerRef.current);
        beatMarkerTimerRef.current = null;
      }
    };
  }, []);

  const applyLiveDisplaySmooth = useCallback((vitals: VitalSignsResult): VitalSignsResult => {
    const shown = displayFilterRef.current.update(vitals);
    displaySnapshotRef.current = shown;
    return shown;
  }, []);

  const resetFingerContactSession = useCallback(() => {
    processHeartBeat.reset();
    measurementLatchRef.current = createMeasurementSessionLatch();
    lastGoodBpmRef.current = 0;
    lastBpmSeenAtRef.current = 0;
    lastRrSnapshotRef.current = null;
    unstableFrameCounter.current = 0;
    contactStartedAtRef.current = 0;
    lastContactSeenAtRef.current = 0;
    pressureVerdictRef.current = 'NONE';
    pressureNoneSinceRef.current = 0;
    lastPressureHapticAtRef.current = 0;
    acqReadyLatchRef.current = false;
    stabilizationRef.current = createStabilizationState();
    setRRIntervals([]);
    setBeatMarker(0);
    if (beatMarkerTimerRef.current) {
      window.clearTimeout(beatMarkerTimerRef.current);
      beatMarkerTimerRef.current = null;
    }
    bpmSanityRef.current.reset();
    sanityErrorRef.current = null;
    displayFilterRef.current.reset();
    lastHrFilterInputRef.current = '';
    vitalSignsRef.current = createDefaultVitalSignsResult();
    displaySnapshotRef.current = vitalSignsRef.current;
    setVitalSigns(displaySnapshotRef.current);
    lastHrPushRef.current = 0;
    lastVitalsPushRef.current = 0;
    lastRrPushRef.current = 0;
    lastSignalPushRef.current = 0;
    lastDiagPushRef.current = 0;
    morphologyBatchRef.current = [];
    morphologyStreamActiveRef.current = false;
    processVitalSigns.resetMorphologyWindow();
    processVitalSigns.resetRespirationWindow();
    ppgMeterRef?.current?.clearBuffer();

  }, [processHeartBeat, processVitalSigns, ppgMeterRef]);


  const resetSessionRefs = useCallback(() => {
    displayFilterRef.current.reset();
    lastHrFilterInputRef.current = '';
    totalBeatsRef.current = 0;
    arrhythmiaBeatsRef.current = 0;
    lastArrhythmiaCountForBeatsRef.current = 0;
    unstableFrameCounter.current = 0;
    measurementLatchRef.current = createMeasurementSessionLatch();
    lastGoodBpmRef.current = 0;
    lastBpmSeenAtRef.current = 0;
    prevHasUsableContactRef.current = false;
    noContactSessionFramesRef.current = 0;
    lastRrSnapshotRef.current = null;
    motionArtifactFramesRef.current = 0;
    saturationFramesRef.current = 0;
    underexposedFramesRef.current = 0;
    artifactCheckFramesRef.current = 0;
    bpmSanityRef.current.reset();
    sanityErrorRef.current = null;
    lastArrhythmiaData.current = null;
    arrhythmiaDetectedRef.current = false;
    morphologyBatchRef.current = [];
    morphologyStreamActiveRef.current = false;
    processVitalSigns.resetMorphologyWindow();
    processVitalSigns.resetRespirationWindow();
    ppgMeterRef?.current?.clearBuffer();

  }, [processVitalSigns, ppgMeterRef]);

  const handleSignalRealtime = useCallback((lastSignal: ProcessedSignal) => {
    if (!isMonitoringRef.current) return;
    const signalValue = lastSignal.filteredValue;
    const contactState: ContactState =
      lastSignal.contactState ??
      (lastSignal.fingerDetected ? "UNSTABLE_CONTACT" : "NO_CONTACT");
    const diag = lastSignal.diagnostics;
    const placementMode =
      lastSignal.placementMode ??
      (diag && typeof diag === 'object' && typeof diag.placementMode === 'string'
        ? (diag.placementMode as FingerPlacementMode)
        : 'hybrid');
    processHeartBeat.setFingerPlacementMode(placementMode);
    processVitalSigns.setPlacementMode(placementMode);
    const fingerConfirmed = !!lastSignal.fingerDetected;
    const nowT = performance.now();
    const hasUsableContact =
      fingerConfirmed && contactState !== 'NO_CONTACT';

    if (
      hasUsableContact &&
      !prevHasUsableContactRef.current &&
      noContactSessionFramesRef.current >= CONTACT_REGAIN_RESET_MIN_FRAMES
    ) {
      resetFingerContactSession();
    }
    if (hasUsableContact) {
      lastContactSeenAtRef.current = nowT;
      if (!prevHasUsableContactRef.current || contactStartedAtRef.current === 0) {
        contactStartedAtRef.current = nowT;
      }
    } else if (noContactSessionFramesRef.current >= PRESSURE_CONTACT_LOST_FRAMES) {
      contactStartedAtRef.current = 0;
    }
    prevHasUsableContactRef.current = hasUsableContact;

    if (!hasUsableContact) {
      noContactSessionFramesRef.current += 1;
      if (noContactSessionFramesRef.current === NO_CONTACT_SESSION_RESET_FRAMES) {
        resetFingerContactSession();
      }
    } else {
      noContactSessionFramesRef.current = 0;
    }

    artifactCheckFramesRef.current += 1;
    if (lastSignal.motionArtifact) {
      motionArtifactFramesRef.current += 1;
    }
    const sqm = diag && typeof diag === 'object' && diag.sqm && typeof diag.sqm === 'object'
      ? diag.sqm as Record<string, unknown>
      : {};
    if (typeof sqm.saturationRatio === 'number' && sqm.saturationRatio > VITAL_THRESHOLDS.ROUTER.SATURATION_FRAME_RATIO) {
      saturationFramesRef.current += 1;
    }
    if (typeof sqm.underexposureRatio === 'number' && sqm.underexposureRatio > VITAL_THRESHOLDS.ROUTER.UNDEREXPOSURE_FRAME_RATIO) {
      underexposedFramesRef.current += 1;
    }

    const hints = cameraHintsRef.current;
    const Q = VITAL_THRESHOLDS.QUALITY;
    const minConf =
      (contactState === 'STABLE_CONTACT'
        ? Q.MIN_ENSEMBLE_CONF_STABLE
        : Q.MIN_ENSEMBLE_CONF_UNSTABLE) * hints.ensembleConfScale;
    const rawSqi =
      (diag && typeof diag === 'object' && diag.sqm && typeof diag.sqm.sqi === 'number'
        ? diag.sqm.sqi
        : lastSignal.quality) || 0;

    // Los cruces reales por cero son muestras PPG legítimas; jamás los
    // reemplazamos por la muestra anterior. Las ventanas físicamente inválidas
    // se excluyen por estado del frame, no por su amplitud numérica.
    const statusForHeartbeat = typeof diag?.status === 'string' ? diag.status : '';
    const sampleValid =
      hasUsableContact &&
      Number.isFinite(signalValue) &&
      !lastSignal.motionArtifact &&
      statusForHeartbeat !== 'SATURATED' &&
      statusForHeartbeat !== 'UNDEREXPOSED' &&
      statusForHeartbeat !== 'LOW_FPS' &&
      statusForHeartbeat !== 'NO_FINGER';
    const frameTimeMs =
      Number.isFinite(lastSignal.timestamp) && lastSignal.timestamp > 0
        ? lastSignal.timestamp
        : nowT;
    const heartBeatResult = processHeartBeat.processSignal(
      sampleValid ? signalValue : 0,
      contactState,
      frameTimeMs,
      fingerConfirmed,
      {
        sqi: sampleValid ? rawSqi : 0,
        perfusionIndex: lastSignal.perfusionIndex ?? 0,
        motionScore: typeof sqm.motionScore === 'number' ? sqm.motionScore : 0,
      },
      sampleValid,
    );

    const mergedDiag =
      diag && typeof diag === 'object'
        ? { ...diag, peakDetection: heartBeatResult.ensembleDiagnostics }
        : { peakDetection: heartBeatResult.ensembleDiagnostics };
    // El push del diag se hace MÁS ABAJO, tras sobreescribir el stage/progress de
    // estabilización con el criterio REAL por convergencia (necesita bpmLive).

    const bpmForLatch =
      heartBeatResult.bpm > 0
        ? heartBeatResult.bpm
        : hasUsableContact
          ? lastGoodBpmRef.current
          : 0;
    if (bpmForLatch > 0 && hasUsableContact) lastGoodBpmRef.current = bpmForLatch;

    measurementLatchRef.current = updateMeasurementSessionLatch(
      measurementLatchRef.current,
      hasUsableContact,
      bpmForLatch,
      rawSqi,
      nowT,
      heartBeatResult.isPeak,
    );
    const latchPeakMs = measurementLatchRef.current.lastPeakMs;
    const peakRecent =
      fingerConfirmed &&
      latchPeakMs > 0 &&
      nowT - latchPeakMs < SESSION_LATCH.MAX_PEAK_GAP_MS;

    const rrForBpm = heartBeatResult.rrData?.intervals ?? [];
    const bpmFromRr =
      rrForBpm.length >= 1 ? bpmFromEmittedRr(rrForBpm) : 0;
    const bpmProcessor =
      heartBeatResult.bpm >= VITAL_THRESHOLDS.HR.MIN &&
      heartBeatResult.bpm <= VITAL_THRESHOLDS.HR.MAX
        ? heartBeatResult.bpm
        : 0;
    const bpmLive =
      fingerConfirmed && (bpmProcessor > 0 || bpmFromRr > 0)
        ? bpmProcessor > 0
          ? bpmProcessor
          : bpmFromRr
        : 0;

    if (bpmLive > 0) {
      lastGoodBpmRef.current = bpmLive;
      lastBpmSeenAtRef.current = nowT;
    }

    const bpmOut =
      hasUsableContact && fingerConfirmed && bpmLive > 0 ? bpmLive : 0;

    // ESTABILIZACIÓN POR CONVERGENCIA (criterio REAL, reemplaza el warm-up fijo).
    // La señal está estable cuando la LECTURA DE HR convergió (dejó de moverse) y
    // la calidad se sostiene — el tiempo lo dicta la señal, no un reloj. Robusto a
    // arritmia: usa el BPM suavizado (la frecuencia media se asienta). Solo aquí se
    // revela la onda y el número.
    const stab = updateStabilization(stabilizationRef.current, {
      hasContact: hasUsableContact,
      bpm: bpmLive,
      sqi: sampleValid ? rawSqi : 0,
      perfusionIndex: lastSignal.perfusionIndex ?? 0,
      periodicity: typeof sqm.periodicity === 'number' ? sqm.periodicity : 0,
      motionScore: typeof sqm.motionScore === 'number' ? sqm.motionScore : 0,
      confirmedRrCount: rrForBpm.length,
      nowMs: nowT,
    });
    if (stab.stabilized) acqReadyLatchRef.current = true;
    const acqStabilized = acqReadyLatchRef.current;
    const bpmDisplay = acqStabilized ? bpmOut : 0;

    // Sobreescribe el stage/progress del diag con el criterio REAL de convergencia
    // (la UI revela la onda con ESTO, no con el warm-up por tiempo del procesador).
    const md = mergedDiag as Record<string, unknown>;
    md.acquisitionStage = hasUsableContact ? stab.stage : 'SEARCHING';
    md.acquisitionProgress = stab.progress;
    md.stabilizationReason = stab.reason;
    if (nowT - lastDiagPushRef.current >= DIAG_PUSH_THROTTLE_MS) {
      lastDiagPushRef.current = nowT;
      setCurrentDiagnostics(mergedDiag);
    }

    // Bucle cerrado de presión (modelo transmural único). La evidencia se
    // actualiza por frame y el diagnóstico va throttled: se lee aquí para que
    // el háptico reaccione con la cadencia real de la señal, no con la UI.
    const pressureEvidence = diag?.placementEvidence;
    // Gate por estado: no disparar hápticos con evidencia stale (saturación,
    // subexposición, fps bajo, artefacto de movimiento).
    const status = typeof diag?.status === 'string' ? diag.status : '';
    const staleStatus = status === 'SATURATED' || status === 'UNDEREXPOSED' ||
      status === 'LOW_FPS' || status === 'MOTION_ARTIFACT';
    if (pressureEvidence && !staleStatus) {
      const verdict = pressureEvidence.pressure;
      if (verdict === 'NONE' || !hasUsableContact) {
        // No resetear el veredicto con un solo frame NONE: mantener el
        // anterior hasta salida real de contacto (anti-parpadeo).
        if (!hasUsableContact && noContactSessionFramesRef.current >= PRESSURE_CONTACT_LOST_FRAMES) {
          pressureVerdictRef.current = 'NONE';
        }
      } else {
        const prev = pressureVerdictRef.current;
        const sinceHaptic = nowT - lastPressureHapticAtRef.current;
        const globalOk = sinceHaptic >= PRESSURE_HAPTIC_MIN_INTERVAL_MS;
        // El PRIMER aviso de cada estado no espera asentamiento: si el dedo está
        // mal apoyado hay que decirlo ya (el settle de 2 s hacía que el usuario
        // corrigiera a ciegas durante los primeros segundos). El asentamiento
        // solo gobierna la REPATICIÓN, que sí necesita cadencia.
        const isTransition = prev !== verdict;
        const contactAge = contactStartedAtRef.current > 0 ? nowT - contactStartedAtRef.current : 0;
        const settled = contactAge >= PRESSURE_FEEDBACK_SETTLE_MS;
        const repeatable = !isTransition && settled;
        let fire = false;
        if (verdict === 'HEAVY') {
          fire = globalOk && (isTransition || (repeatable && sinceHaptic >= PRESSURE_HEAVY_REPEAT_MS));
        } else if (verdict === 'LIGHT') {
          fire = globalOk && (isTransition || (repeatable && sinceHaptic >= PRESSURE_LIGHT_REPEAT_MS));
        } else {
          // IDEAL solo confirma la transición desde un estado corregible.
          fire = globalOk && isTransition && (prev === 'LIGHT' || prev === 'HEAVY');
        }
        if (fire) {
          lastPressureHapticAtRef.current = nowT;
          // El grado continuo del modelo transmural gradúa el patrón: no es un
          // aviso on/off, la severidad cambia con la distancia al óptimo.
          triggerPressureHaptic(verdict, pressureEvidence.pressureScore).catch(() => undefined);
        }
        pressureVerdictRef.current = verdict;
      }
    } else {
      // Sin evidencia fresca: no afirmar presión; mantener veredicto anterior
      // hasta salida real de contacto.
      if (!hasUsableContact && noContactSessionFramesRef.current >= PRESSURE_CONTACT_LOST_FRAMES) {
        pressureVerdictRef.current = 'NONE';
      }
    }

    const piMin = Q.MIN_PI * Math.max(
      VITAL_THRESHOLDS.ROUTER.PI_MIN_READINESS_FLOOR,
      hints.minPiScale * VITAL_THRESHOLDS.ROUTER.PI_MIN_READINESS_SCALE,
    );
    const readiness = evaluateMeasurementReadiness({
      hasUsableContact,
      contactState,
      rawSqi,
      perfusionIndex: lastSignal.perfusionIndex ?? 0,
      piMin,
      bpm: bpmOut,
      peakRecent,
      ensembleConfidence: heartBeatResult.confidence,
      minEnsembleConf: minConf,
      latch: measurementLatchRef.current,
      nowMs: nowT,
    });
    const { vitalsDspReady, fullVitalsReady, hrDisplayReady: hrReady } = readiness;

    // Muestreamos morfología a la frecuencia de captura, no a la cadencia
    // reducida de VitalSignsProcessor. Los timestamps provienen del frame real.
    const morphologyValue = lastSignal.morphologyFiltered;
    const morphologyFrameUsable =
      vitalsDspReady &&
      hasUsableContact &&
      contactState === 'STABLE_CONTACT' &&
      !lastSignal.motionArtifact &&
      typeof morphologyValue === 'number' &&
      Number.isFinite(morphologyValue) &&
      Math.abs(morphologyValue) > 1e-9 &&
      typeof lastSignal.timestamp === 'number' &&
      Number.isFinite(lastSignal.timestamp);

    if (morphologyFrameUsable) {
      morphologyStreamActiveRef.current = true;
      morphologyBatchRef.current.push({
        value: morphologyValue,
        timestampMs: lastSignal.timestamp,
      });
      // Mantener 6 s como máximo para resampleo y análisis de calidad.
      if (morphologyBatchRef.current.length > 180) {
        morphologyBatchRef.current.splice(0, morphologyBatchRef.current.length - 180);
      }
    } else if (morphologyStreamActiveRef.current || morphologyBatchRef.current.length > 0) {
      morphologyBatchRef.current = [];
      morphologyStreamActiveRef.current = false;
      processVitalSigns.resetMorphologyWindow();
      processVitalSigns.resetRespirationWindow();
    }

    const showWaveform = hasUsableContact;

    if (ppgMeterRef?.current) {
      ppgMeterRef.current.pushSignal(showWaveform ? signalValue : 0, lastSignal.timestamp);
    }

    if (hasUsableContact && nowT - lastHrPushRef.current >= HR_PUSH_THROTTLE_MS) {
      lastHrPushRef.current = nowT;
      const sqRounded = Math.round(rawSqi);
      const hrStatus: import('@/types/measurements').MeasurementStatus =
        acqStabilized && contactState === 'STABLE_CONTACT' && bpmLive > 0 && hrReady
          ? 'VALID'
          : bpmDisplay > 0
            ? 'WARMUP'
            : 'NO_VALID_SIGNAL';
      const raw = {
        ...vitalSignsRef.current,
        heartRate: { ...vitalSignsRef.current.heartRate, value: bpmDisplay, status: hrStatus },
        signalQuality: sqRounded,
      };
      vitalSignsRef.current = raw;
      const inputKey = `${heartBeatResult.rrData?.lastPeakTime ?? 0}:${bpmDisplay}:${hrStatus}`;
      // Held BPM frames are not new observations. Never filter inside an updater.
      if (inputKey !== lastHrFilterInputRef.current) {
        lastHrFilterInputRef.current = inputKey;
        displaySnapshotRef.current = displayFilterRef.current.update(
          { ...displaySnapshotRef.current, heartRate: raw.heartRate, signalQuality: sqRounded },
          ['heartRate'],
        );
      }
      setVitalSigns({ ...displaySnapshotRef.current, signalQuality: sqRounded });
    }

    // Limpieza INMEDIATA del BPM ante NO_CONTACT inequívoco: evita el "BPM sin
    // dedo" fantasma que persistía mientras el contador de inestabilidad llegaba
    // a su umbral (~2 s) tras retirar el dedo. Solo dispara con NO_CONTACT (no con
    // UNSTABLE), así no afecta la tolerancia a artefactos breves con el dedo puesto.
    // Resetea también el ref del EMA para que el valor caiga a 0 sin decaer.
    if (
      !hasUsableContact &&
      contactState === 'NO_CONTACT' &&
      nowT - lastHrPushRef.current >= HR_PUSH_THROTTLE_MS &&
      vitalSignsRef.current.heartRate.value !== 0
    ) {
      lastHrPushRef.current = nowT;
      displayFilterRef.current.reset(['heartRate']);
      lastHrFilterInputRef.current = '';
      const heartRate = { ...vitalSignsRef.current.heartRate, value: 0, status: 'NO_VALID_SIGNAL' as const };
      vitalSignsRef.current = { ...vitalSignsRef.current, heartRate };
      displaySnapshotRef.current = { ...displaySnapshotRef.current, heartRate };
      setVitalSigns(displaySnapshotRef.current);
    }

    if (hrReady && bpmOut > 0) {
      unstableFrameCounter.current = 0;
      if (bpmLive > 0) {
        const verdict = bpmSanityRef.current.push(bpmLive);
        if (verdict.ok === false) {
          const msg = `BPM stream ${verdict.reason} (${verdict.detail})`;
          if (sanityErrorRef.current !== verdict.reason) {
            sanityErrorRef.current = verdict.reason;
            const now = performance.now();
            if (now - sanityToastAtRef.current > VITAL_THRESHOLDS.ROUTER.SANITY_TOAST_COOLDOWN_MS) {
              sanityToastAtRef.current = now;
              toast({
                variant: "destructive",
                title: "⚠ Señal sospechosa detectada",
                description: msg,
              });
            }
          }
        } else if (sanityErrorRef.current) {
          sanityErrorRef.current = null;
        }
      }
    } else {
      if (!hasUsableContact) {
        unstableFrameCounter.current++;
      } else if (bpmOut <= 0) {
        unstableFrameCounter.current = Math.min(
          unstableFrameCounter.current + 1,
          UNSTABLE_ZERO_THRESHOLD,
        );
        if (
          hasUsableContact &&
          unstableFrameCounter.current === STALE_PEAK_REACQUIRE_FRAMES
        ) {
          processHeartBeat.reacquirePeaks(nowT);
        }
        const STALE_FINGER_NO_BPM = VITAL_THRESHOLDS.CONTACT.STALE_NO_BPM_FRAMES;
        if (
          hasUsableContact &&
          unstableFrameCounter.current === STALE_FINGER_NO_BPM
        ) {
          processHeartBeat.reacquirePeaks(nowT);
          displayFilterRef.current.reset(['spo2', 'bloodPressure']);
          vitalSignsRef.current = {
            ...vitalSignsRef.current,
            spo2: { ...vitalSignsRef.current.spo2, value: 0, status: 'NO_VALID_SIGNAL' },
            bloodPressure: {
              ...vitalSignsRef.current.bloodPressure,
              value: { systolic: 0, diastolic: 0 },
              status: 'NO_VALID_SIGNAL',
            },
          };
          displaySnapshotRef.current = {
            ...displaySnapshotRef.current,
            spo2: vitalSignsRef.current.spo2,
            bloodPressure: vitalSignsRef.current.bloodPressure,
          };
          setVitalSigns(displaySnapshotRef.current);
        }
      } else {
        unstableFrameCounter.current = Math.max(0, unstableFrameCounter.current - 2);
      }
      if (unstableFrameCounter.current >= UNSTABLE_ZERO_THRESHOLD && !hasUsableContact) {
        vitalSignsFrameCounter.current = 0;
        setBeatMarker(0);
        setRRIntervals([]);
        arrhythmiaDetectedRef.current = false;
        measurementLatchRef.current = createMeasurementSessionLatch();
        lastGoodBpmRef.current = 0;
        lastRrSnapshotRef.current = null;
        displayFilterRef.current.reset();
        lastHrFilterInputRef.current = '';
        const raw: VitalSignsResult = {
          ...vitalSignsRef.current,
          heartRate: { ...vitalSignsRef.current.heartRate, value: 0, status: 'NO_VALID_SIGNAL' },
          spo2: { ...vitalSignsRef.current.spo2, value: 0, status: 'NO_VALID_SIGNAL' },
          bloodPressure: { ...vitalSignsRef.current.bloodPressure, value: { systolic: 0, diastolic: 0 }, status: 'NO_VALID_SIGNAL' },
          arrhythmia: { ...vitalSignsRef.current.arrhythmia, value: { count: 0, status: 'NORMAL' } },
          signalQuality: 0,
        };
        vitalSignsRef.current = raw;
        displaySnapshotRef.current = raw;
        setVitalSigns(raw);
      }
    }

    if (
      hasUsableContact &&
      heartBeatResult.rrData &&
      heartBeatResult.rrData.intervals.length >= 2
    ) {
      lastRrSnapshotRef.current = heartBeatResult.rrData;
    } else if (!hasUsableContact) {
      lastRrSnapshotRef.current = null;
    }

    const emittedPeak = hasUsableContact && heartBeatResult.isPeak;

    if (emittedPeak) {
      setBeatMarker(1);
      if (beatMarkerTimerRef.current) window.clearTimeout(beatMarkerTimerRef.current);
      beatMarkerTimerRef.current = window.setTimeout(() => {
        setBeatMarker(0);
        beatMarkerTimerRef.current = null;
      }, VITAL_THRESHOLDS.ROUTER.BEAT_MARKER_MS);
    }

    if (emittedPeak) {
      totalBeatsRef.current++;
      const currentArrCount = vitalSignsRef.current.arrhythmia.value?.count ?? 0;
      if (currentArrCount > lastArrhythmiaCountForBeatsRef.current) {
        arrhythmiaBeatsRef.current++;
        lastArrhythmiaCountForBeatsRef.current = currentArrCount;
      }
    }

    if (
      emittedPeak &&
      heartBeatResult.rrData?.intervals &&
      heartBeatResult.rrData.intervals.length > 0 &&
      nowT - lastRrPushRef.current >= RR_PUSH_THROTTLE_MS
    ) {
      lastRrPushRef.current = nowT;
      setRRIntervals(heartBeatResult.rrData.intervals.slice(-5));
    }

    if (!vitalsDspReady) {
      if (
        hasUsableContact &&
        (vitalSignsRef.current.spo2.value ?? 0) > 0 &&
        nowT - lastVitalsPushRef.current >= VITALS_PUSH_THROTTLE_MS
      ) {
        lastVitalsPushRef.current = nowT;
        setVitalSigns(prev => ({
          ...prev,
          spo2: displaySnapshotRef.current.spo2,
          bloodPressure: displaySnapshotRef.current.bloodPressure,
          signalQuality: Math.round(rawSqi),
        }));
      }
      return;
    }

    vitalSignsFrameCounter.current++;

    const dspDue = vitalSignsFrameCounter.current >= VITALS_PROCESS_EVERY_N_FRAMES;
    if (dspDue) {
      vitalSignsFrameCounter.current = 0;
      const rgbStats = processVitalSigns.getRGBStats();

      if (rgbStats.redDC > 0 && rgbStats.greenDC > 0) {
        processVitalSigns.setRGBData({
          redAC: rgbStats.redAC,
          redDC: rgbStats.redDC,
          greenAC: rgbStats.greenAC,
          greenDC: rgbStats.greenDC,
          blueAC: rgbStats.blueAC,
          blueDC: rgbStats.blueDC,
        });
      }

      const peakDiag = heartBeatResult.ensembleDiagnostics as
        | { agreement?: { elgendi?: number; spectral?: number }; confidence?: number }
        | undefined;
      const sqmRaw = diag?.sqm && typeof diag.sqm === "object" ? diag.sqm : {};
      const enrichedSqm = SignalQualityIndex.enrichMetrics(
        {
          ...sqmRaw,
          sqi: rawSqi || lastSignal.quality || 0,
          perfusionIndex: lastSignal.perfusionIndex ?? 0,
        },
        {
          agreement: peakDiag?.agreement,
          elgendiConfidence: peakDiag?.agreement?.elgendi,
        },
      );

      const rrForVitals =
        fullVitalsReady &&
        heartBeatResult.rrData &&
        heartBeatResult.rrData.intervals.length >= 2
          ? { ...heartBeatResult.rrData, timestampNow: nowT }
          : fullVitalsReady &&
              lastRrSnapshotRef.current &&
              lastRrSnapshotRef.current.intervals.length >= 2
            ? { ...lastRrSnapshotRef.current, timestampNow: nowT }
            : undefined;

      // Extraer canales del banco de filtros especializado (PPGSignalSplitter)
      const splitterChannels = {
        morphologyFiltered: lastSignal.morphologyFiltered,
        respirationFiltered: lastSignal.respirationFiltered,
        arrhythmiaFiltered: lastSignal.arrhythmiaFiltered,
        spo2Channels: lastSignal.spo2Channels,
      };

      const effectiveBpm = bpmOut || lastGoodBpmRef.current;
      const morphologyBatch = morphologyBatchRef.current;
      morphologyBatchRef.current = [];

      const vitals = processVitalSigns.processSignal(
        lastSignal.filteredValue,
        rawSqi || lastSignal.quality || 0,
        effectiveBpm,
        rrForVitals,
        lastSignal.perfusionIndex,
        enrichedSqm,
        lastSignal.morphologyValue ?? lastSignal.filteredValue,
        splitterChannels,
        undefined,
        undefined,
        undefined,
        lastSignal.accelRespiration,
        morphologyBatch,
        lastSignal.timestamp
      );

      vitalSignsRef.current = vitals;
      displaySnapshotRef.current = displayFilterRef.current.update(
        { ...vitals, heartRate: displaySnapshotRef.current.heartRate },
        ['spo2', 'bloodPressure'],
      );

      const uiDue = nowT - lastVitalsPushRef.current >= VITALS_PUSH_THROTTLE_MS;
      if (uiDue) {
        lastVitalsPushRef.current = nowT;
        setVitalSigns(displaySnapshotRef.current);
      }

      if (
        fullVitalsReady &&
        heartBeatResult.rrData &&
        heartBeatResult.rrData.intervals.length >= 2 &&
        heartBeatResult.confidence > VITAL_THRESHOLDS.ROUTER.ARRHYTHMIA_MIN_CONF &&
        vitals.heartRate.status === 'VALID'
      ) {
        const arrhythmiaStatus = vitals.arrhythmia.value?.status ?? '';
        if (arrhythmiaStatus) {
          lastArrhythmiaData.current = vitals.lastArrhythmiaData || null;

          const isArrhythmiaDetected = arrhythmiaStatus.includes("ARRITMIA DETECTADA");
          if (isArrhythmiaDetected !== arrhythmiaDetectedRef.current) {
            arrhythmiaDetectedRef.current = isArrhythmiaDetected;

            if (isArrhythmiaDetected) {
              triggerArrhythmiaHaptic().catch(() => undefined);
              toast({
                title: "⚠️ Arritmia detectada",
                description: `Latido irregular #${vitals.arrhythmia.value?.count ?? 0}`,
                variant: "destructive",
                duration: 4000
              });
            }
          }
        }
      }
    }
  }, [
    processHeartBeat,
    processVitalSigns,
    cameraHintsRef,
    resetFingerContactSession,
    ppgMeterRef,
  ]);



  // Conectar isMonitoringRef externamente
  const setIsMonitoringRef = useCallback((val: boolean) => {
    isMonitoringRef.current = val;
  }, []);

  return {
    // State outputs
    vitalSigns,
    setVitalSigns,
    heartbeatSignal,
    setHeartbeatSignal,
    beatMarker,
    setBeatMarker,
    rrIntervals,
    setRRIntervals,
    currentDiagnostics,
    setCurrentDiagnostics,


    // Refs for save
    vitalSignsRef,
    totalBeatsRef,
    arrhythmiaBeatsRef,
    lastArrhythmiaData,
    motionArtifactFramesRef,
    saturationFramesRef,
    underexposedFramesRef,
    artifactCheckFramesRef,
    isMonitoringRef: isMonitoringRef,

    // Sanity state
    sanityProfileId,
    setSanityProfileId,
    customJSON,
    setCustomJSON,

    // Callbacks
    handleSignalRealtime,

    resetFingerContactSession,
    resetSessionRefs,
    setIsMonitoringRef,
    bpmSanityRef,
    applyLiveDisplaySmooth,
  };
}
