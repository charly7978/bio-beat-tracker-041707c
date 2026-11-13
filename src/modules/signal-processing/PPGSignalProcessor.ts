import type { ProcessedSignal, ProcessingError, SignalProcessor as SignalProcessorInterface, ContactState } from '../../types/signal';
import { BandpassFilter } from './BandpassFilter';
import { PPGSignalSplitter } from './PPGSignalSplitter';
import { createLogger, ppgPerf } from '../../utils/logger';
import { clamp } from '../../utils/math';
import { RingF32 } from '../../utils/RingBuffer';
import {
  DEFAULT_BACKPRESSURE_CONFIG,
  sanitizeBackpressureConfig,
  type BackpressureConfig,
} from '../../lib/perf/backpressureConfig';
import type { MeasurementStatus, SignalQualityMetrics } from '../../types/measurements';
import {
  SignalQualityIndex,
  createDiagnosticStatusState,
  type DiagnosticStatusState,
} from '../signal-quality/SignalQualityIndex';
import { VITAL_THRESHOLDS } from '../../config/vitalThresholds';
import { DSP_CONSTANTS } from '../../config/signalProcessing';
import {
  AdaptivePixelRoi,
  redSeriesCoefficientOfVariation,
} from '../../lib/signal/adaptivePixelRoi';
import {
  hasFingerHemoglobinSignature,
  calibrateZlo,
  getZlo,
  resetZlo,
} from '../../lib/finger/fingerContactSignature';
import {
  computePlacementEvidence,
  resetPlacementEvidence,
  type FingerPlacementEvidence,
} from '../../lib/finger/fingerPlacementEvidence';
import {
  isExposureFlickerNotFingerPulse,
  isOpenFlashWithoutContact,
  passesFingerAcquire,
  passesFingerMaintain,
  passesLiveFingerContact,
  passesPulsatileAcquire,
  updateFingerDetection,
} from '../../lib/finger/fingerSceneClassifier';
import {
  classifyFingerPlacement,
  placementHintText,
  smoothPlacementMode,
} from '../../lib/finger/fingerPlacementProfile';
import type { FingerPlacementMode } from '../../types/signal';
import {
  inferCameraRuntimeHints,
  type CameraRuntimeHints,
} from '../../lib/device/cameraDeviceProfile';
import {
  applyPulseAgc,
  createPulseAgcState,
  DEFAULT_PULSE_AGC,
  resetPulseAgc,
} from './shared/pulseAgc';
import {
  createAcquisitionState,
  updateAcquisition,
  type AcquisitionState,
} from '../../lib/acquisition/AcquisitionStabilizer';
import {
  createActiveStabilizer,
  stabilizeSample,
  resetActiveStabilizer,
} from '../../lib/signal/activeStabilizer';
import { bandLimitedDominantFreq } from './shared/dsp';
import { RESP_SMART_FUSION, RESPIRATION_DEFAULTS } from '../../config/signalProcessing';

const log = createLogger('PPGSignalProcessor');
// BUILD_STAMP: 2026-05-15 18:32:00

interface ROIMetrics {
  rawRed: number;
  rawGreen: number;
  rawBlue: number;
  coverageRatio: number;
  fingerScore: number;
  fingerTileCount: number;
  /** Sellado óptico [0..1]: lente cubierta por tejido (sin exigir pulso). */
  sealRatio: number;
  /** Fracción del tejido que además está perfundido [0..1]. */
  perfusedFraction: number;
  /** DC rojo de los píxeles de tejido. */
  tissueRed: number;
  roiX: number;
  roiY: number;
  roiH: number;
  roiW: number;
  centroidMotion: number;
  centroidX: number;
  centroidY: number;
  maskCorrelation: number;
  displacementPenalty: number;
}

/**
 * MULTI-SOURCE PPG SIGNAL PROCESSOR
 * 
 * Mejoras clave:
 * 1. Estado de contacto 3-niveles (NO_CONTACT / UNSTABLE / STABLE)
 * 2. SelecciÃ³n competitiva de canal (R, G, R-G; sin CHROM â€” ruido con dedo+flash)
 * 3. SQI unificado â€” Ãºnica fuente de verdad
 * 4. HistÃ©resis fuerte para tolerancia a temblores
 */
export class PPGSignalProcessor implements SignalProcessorInterface {
  public isProcessing = false;

  private bandpassFilter: BandpassFilter;
  private morphBandpassFilter: BandpassFilter;
  private readonly signalSplitter = new PPGSignalSplitter(30);
  /** BPM estimado para el notch adaptativo del canal 5 (arritmias) */
  private lastKnownBpm = 0;
  private placementMode: FingerPlacementMode = 'hybrid';
  private placementStreak = { mode: 'hybrid' as FingerPlacementMode, count: 0 };
  private readonly pulseAgcState = createPulseAgcState();

  private readonly ACDC_WINDOW = 120;
  private readonly pixelRoi = new AdaptivePixelRoi();

  // === BACKPRESSURE / ADAPTIVE STRIDE ===
  // Stride de muestreo de píxeles dentro del ROI. 3 = baseline (cada 3 píxeles).
  // Sube a 4 si fps < 20 sostenido > 3s, baja a 3 cuando fps >= 25.
  // Evita reescribir el pipeline cuando el dispositivo es lento; sólo reduce el
  // muestreo espacial preservando la temporal (que es lo que importa para BPM).
  private pixelStride = 3;
  private lastBackpressureCheck = 0;
  private lowFpsSinceMs = 0;
  private highFpsSinceMs = 0;
  private readonly BACKPRESSURE_CHECK_MS = 1000;
  private backpressureConfig: BackpressureConfig = { ...DEFAULT_BACKPRESSURE_CONFIG };

  // Buffers (ring buffers Float32 — sin Array.shift O(n) por frame)
  private readonly rawBuffer = new RingF32(DSP_CONSTANTS.BUFFER_SIZE);
  private readonly filteredBuffer = new RingF32(DSP_CONSTANTS.BUFFER_SIZE);
  private readonly redBuffer = new RingF32(DSP_CONSTANTS.BUFFER_SIZE);
  private readonly greenBuffer = new RingF32(DSP_CONSTANTS.BUFFER_SIZE);
  private readonly blueBuffer = new RingF32(DSP_CONSTANTS.BUFFER_SIZE);
  private readonly frameIntervalBuffer = new RingF32(DSP_CONSTANTS.MAX_RR_INTERVALS);

  // Scratch buffers reusables para stats (ACDC, SQI, source-score) â€” evita
  // `[...arr].sort()` por frame. TamaÃ±o mÃ¡ximo = ACDC_WINDOW.
  private readonly statScratch = new Float32Array(this.ACDC_WINDOW);
  private readonly sortedScratch = new Float32Array(this.ACDC_WINDOW);
  private readonly periodicityScratch = new Float32Array(DSP_CONSTANTS.BUFFER_SIZE);
  // Scratch dedicados R/G/B para AC/DC: las 3 ventanas se necesitan vivas a la vez
  // (DC de las 3 antes del early-return, luego AC de cada una). Asignados una vez.
  private readonly acdcRedScratch = new Float32Array(this.ACDC_WINDOW);
  private readonly acdcGreenScratch = new Float32Array(this.ACDC_WINDOW);
  private readonly acdcBlueScratch = new Float32Array(this.ACDC_WINDOW);

  // AC/DC
  private redDC = 0;
  private redAC = 0;
  private greenDC = 0;
  private greenAC = 0;
  private blueDC = 0;
  private blueAC = 0;

  // Baselines dinÃ¡micas
  private redBaseline = 0;
  private greenBaseline = 0;
  private blueBaseline = 0;
  private estimatedSampleRate: number = DSP_CONSTANTS.DEFAULT_SAMPLE_RATE;
  private lastFrameTimestamp = 0;

  private frameCount = 0;
  private lastLogTime = 0;

  // === ESTADO DE CONTACTO UNIFICADO ===
  private contactState: ContactState = 'NO_CONTACT';
  private fingerDetected = false;
  private signalQuality = 0;
  private fingerConfidenceCount = 0;
  private fingerLostCount = 0;
  private stableContactCount = 0;
  /** Ultima evidencia fisica de colocacion (presion/ubicacion/movimiento). */
  private lastPlacementEvidence: FingerPlacementEvidence | null = null;
  /** Frames consecutivos en STABLE sin pulso evidenciado â€” reversiÃ³n continua. */
  private stableNoPulseStreak = 0;
  private instantLostStreak = 0;
  private liveFingerMissStreak = 0;
  private noContactHardStreak = 0;
  private cameraHints: CameraRuntimeHints = inferCameraRuntimeHints();
  private lastInstantFinger = false;
  private readonly FINGER_CONFIRM_FRAMES = VITAL_THRESHOLDS.FINGER.FINGER_CONFIRM_FRAMES;

  // Ensemble de detecciÃ³n universal: gray buffer + temporal variance + ZLO
  private grayBuffer: Uint8ClampedArray | null = null;
  private lastEnsembleScore = 0;
  private zloFrameCount = 0;
  private readonly ZLO_CALIBRATION_FRAMES = 10;

  // Suavizado temporal â€” mÃ¡s lentos = mÃ¡s estable
  private smoothedRed = 0;
  private smoothedGreen = 0;
  private smoothedBlue = 0;
  private smoothedCoverage = 0;
  private smoothedFingerScore = 0;
  private readonly RGB_SMOOTH_ALPHA = 0.08;
  private readonly COVERAGE_SMOOTH_ALPHA = 0.10;

  /** Ventana corta de R medio en ROI â€” CV temporal para distinguir tejido pulsÃ¡til vs. rojo estÃ¡tico */
  private readonly roiRedPulseRing = new RingF32(VITAL_THRESHOLDS.FINGER.ROI_PULSE_BUFFER);
  private lastRoiRedCv = 0;

  /** Skewness y relative power cacheados para SQI (recalculados periÃ³dicamente) */
  private cachedSkewness = 0;
  private cachedKurtosis = 0;
  private cachedRelativePower = 0;
  private sqiMetricsCounter = 0;

  // IMU / Motion
  private motionScore = 0;
  private motionListenerActive = false;
  private lastAcceleration = { x: 0, y: 0, z: 0 };
  private readonly MOTION_THRESHOLD = VITAL_THRESHOLDS.QUALITY.MAX_MOTION;
  /** Cuenta regresiva de supresiÃ³n post-motion para que el ringing del BPF decaiga */
  private postMotionSuppression = 0;

  // IMU â†’ RESPIRACIÃ“N (modalidad ACC, no-Ã³ptica). La respiraciÃ³n mece levemente
  // la mano/telÃ©fono â†’ el acelerÃ³metro oscila en banda respiratoria. Se sigue la
  // gravedad con un EMA lento (â‰ˆDC) y se guarda la proyecciÃ³n AC del vector sobre
  // la direcciÃ³n de gravedad, muestreada a ACCEL_RESP_HZ. El periodograma sobre
  // ese buffer da una estimaciÃ³n de FR independiente de la cÃ¡mara.
  private readonly ACCEL_RESP_HZ = 20;
  private readonly accelRespRing = new RingF32(512); // â‰ˆ25 s a 20 Hz
  private gravityEma = { x: 0, y: 0, z: 0 };
  private gravityEmaInit = false;
  private lastAccelRespPushMs = 0;
  private lastAccelRespComputeMs = 0;
  private accelRespEstimate: { rpm: number; quality: number } | null = null;

  // Micro-movimiento del dedo DESDE LA SEÃ‘AL (complementa al IMU; ver QUALITY.MOTION_*)
  private signalMotionScore = 0;
  private lastRawRedForMotion = 0;

  // Acondicionador ACTIVO de seÃ±al (denoise edge-preserving + estabilizaciÃ³n baseline).
  private readonly activeStabilizer = createActiveStabilizer();

  // Cache: PI se calcula una sola vez por frame y se reutiliza en SQI, contact state, etc.
  private cachedPI = 0;
  private underexposureEma = 0;
  // Cache de stats lentas (recomputadas cada N frames): evita slice+sort por frame
  // sobre ventanas estadÃ­sticas de 30-90 muestras que cambian lentamente.
  private cachedSqi = 0;
  private cachedPeriodicity = 0;
  private periodicityEma = 0;
  private displaySqiEma = 0;
  private consecutiveNoContactFrames = 0;
  private periodicitySkip = 0;
  private readonly diagStatusState: DiagnosticStatusState = createDiagnosticStatusState();

  // EstabilizaciÃ³n de adquisiciÃ³n (fase inicial de colocaciÃ³n del dedo):
  // fusiona PI/periodicidad/SQI/cobertura/movimiento en una confianza firme.
  private readonly acquisitionState: AcquisitionState = createAcquisitionState();

  // === MULTI-SOURCE RANKING (CHROM eliminado â€” amplifica ruido sin dedo) ===
  private readonly sourceBuffers: { [key: string]: RingF32 } = {
    R: new RingF32(DSP_CONSTANTS.SOURCE_BUFFER_SIZE),
    G: new RingF32(DSP_CONSTANTS.SOURCE_BUFFER_SIZE),
    RG: new RingF32(DSP_CONSTANTS.SOURCE_BUFFER_SIZE),
    POS: new RingF32(DSP_CONSTANTS.SOURCE_BUFFER_SIZE),
  };
  private activeSource: string = 'RG';
  private sourceScores: { [key: string]: number } = { R: 0, G: 0, RG: 0, POS: 0 };
  private lastSourceSwitch = 0;
  private readonly SOURCE_HYSTERESIS_MS = 4000;

  // Buffers deslizantes para la proyecciÃ³n del algoritmo POS (Plane-Orthogonal-to-Skin)
  private readonly xBuffer = new RingF32(30);
  private readonly yBuffer = new RingF32(30);
  private smoothedPosAlpha = 0.5;

  constructor(
    public onSignalReady?: (signal: ProcessedSignal) => void,
    public onError?: (error: ProcessingError) => void
  ) {
    // Pulso (HR): 0.5-4.5Hz â€” rango cardÃ­aco estÃ¡ndar, 4Âº orden para mejor rechazo
    this.bandpassFilter = new BandpassFilter(this.estimatedSampleRate, 4.5);
    // MorfologÃ­a (BP): 0.5-8Hz â€” preserva escotadura dicrÃ³tica y forma completa del pulso
    this.morphBandpassFilter = new BandpassFilter(this.estimatedSampleRate, 8.0);
  }

  async initialize(): Promise<void> {
    this.reset();
  }

  start(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.initialize();
    this.startMotionListener();
  }

  stop(): void {
    this.isProcessing = false;
    this.stopMotionListener();
  }

  async calibrate(): Promise<boolean> {
    return true;
  }

  /** Actualizar perfil segÃºn diagnÃ³stico de CameraView (torch/FPS/jitter). */
  setCameraRuntimeHints(diag: Record<string, unknown> | null | undefined): void {
    this.cameraHints = inferCameraRuntimeHints(diag);
  }

  processFrame(imageData: ImageData, frameTimestampMs?: number): void {
    if (!this.isProcessing || !this.onSignalReady) return;

    this.frameCount++;
    const timestamp = typeof frameTimestampMs === 'number' && Number.isFinite(frameTimestampMs)
      ? frameTimestampMs
      : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.updateSampleRate(timestamp);
    this.maybeAdaptBackpressure(timestamp);

    const endRoi = ppgPerf.start('roi');
    const roi = this.extractROI(imageData);
    endRoi();

    this.roiRedPulseRing.push(roi.rawRed);
    const Fpulse = VITAL_THRESHOLDS.FINGER;
    const nPulse = this.roiRedPulseRing.copyTailInto(this.statScratch, Fpulse.ROI_PULSE_BUFFER);
    this.lastRoiRedCv =
      nPulse >= Fpulse.ROI_PULSE_MIN_SAMPLES
        ? redSeriesCoefficientOfVariation(this.statScratch, nPulse)
        : 0;

    // Calibrar ZLO en primeros frames (sin flash/flash apagado)
    if (!getZlo().calibrated && this.zloFrameCount < this.ZLO_CALIBRATION_FRAMES) {
      const sum = roi.rawRed + roi.rawGreen + roi.rawBlue;
      if (sum < 30 && this.zloFrameCount === 0) {
        calibrateZlo(roi.rawRed, roi.rawGreen, roi.rawBlue);
      }
      this.zloFrameCount++;
    }

    // Gray buffer para histograma + varianza temporal (ensemble detection)
    const endGray = ppgPerf.start('gray');
    if (!this.grayBuffer || this.grayBuffer.length !== imageData.width * imageData.height) {
      this.grayBuffer = new Uint8ClampedArray(imageData.width * imageData.height);
    }
    for (let i = 0; i < imageData.data.length; i += 4) {
      this.grayBuffer[i / 4] = (imageData.data[i] * 77 + imageData.data[i + 1] * 150 + imageData.data[i + 2] * 29) >> 8;
    }
    endGray();

    this.updateContactState(roi);

    const motionArtifact =
      this.motionScore > this.MOTION_THRESHOLD ||
      roi.displacementPenalty >= 0.85;
    const fingerEnsemble = updateFingerDetection(
      { red: roi.rawRed, green: roi.rawGreen, blue: roi.rawBlue, coverage: roi.coverageRatio, fingerScore: roi.fingerScore },
      { red: this.smoothedRed, green: this.smoothedGreen, blue: this.smoothedBlue, coverage: this.smoothedCoverage, fingerScore: this.smoothedFingerScore },
      { coverageRatio: roi.coverageRatio, fingerScore: roi.fingerScore, fingerTileCount: roi.fingerTileCount },
      this.grayBuffer,
      this.lastEnsembleScore,
    );
    this.lastEnsembleScore = fingerEnsemble.ensemble.ensembleScore;
    const liveFinger = this.isLiveFingerFrame(roi, this.lastEnsembleScore);

    if (this.contactState !== 'NO_CONTACT' && !liveFinger) {
      this.liveFingerMissStreak++;
      const grace = this.cameraHints.liveFingerMissGrace;
      if (this.liveFingerMissStreak >= grace && !this.cameraHints.constrained) {
        this.setNoContact(/* hardReset */ true);
      } else {
        this.contactState = 'UNSTABLE_CONTACT';
        this.fingerDetected =
          this.fingerConfidenceCount >= this.getFingerConfirmFrames() || this.fingerDetected;
      }
    } else {
      this.liveFingerMissStreak = 0;
    }

    if (this.contactState === 'NO_CONTACT') {
      this.consecutiveNoContactFrames++;
      this.signalQuality = 0;
      this.displaySqiEma = 0;
      // Sin dedo no hay evidencia vigente: nunca dejar un veredicto de presión
      // viejo alimentando el gauge ni los hápticos.
      this.lastPlacementEvidence = null;
      Object.assign(this.diagStatusState, createDiagnosticStatusState());
      this.stepAcquisition(false);
      this.onSignalReady({
        timestamp,
        rawValue: 0,
        filteredValue: 0,
        quality: 0,
        fingerDetected: false,
        contactState: 'NO_CONTACT',
        motionArtifact,
        roi: this.signalRoiFromMetrics(roi),
        perfusionIndex: 0,
        rawRed: roi.rawRed,
        rawGreen: roi.rawGreen,
        rawBlue: roi.rawBlue,
        diagnostics: this.buildFingerDiagnostics(roi, motionArtifact, "NO_FINGER"),
      });
      return;
    }

    // GATES DE RECHAZO ESTRICTOS (Phase 3C)
    let rejectionStatus: MeasurementStatus | null = null;
    const r = this.smoothedRed;
    const g = this.smoothedGreen;
    const _b = this.smoothedBlue;

    const underInstant = r < 12 && g < 10 ? 1 : 0;
    this.underexposureEma = this.underexposureEma * 0.92 + underInstant * 0.08;
    
    if (r > 253 && g > 252) rejectionStatus = "SATURATED";
    else if (
      r < (this.cameraHints.constrained ? 8 : 15) &&
      g < (this.cameraHints.constrained ? 6 : 10)
    ) {
      rejectionStatus = "UNDEREXPOSED";
    }
    else if (motionArtifact) rejectionStatus = "MOTION_ARTIFACT";
    else if (this.pixelStride > 6) rejectionStatus = "LOW_FPS";
    else if (this.frameCount < 28) rejectionStatus = "WARMUP";

    if (rejectionStatus && rejectionStatus !== "WARMUP" && rejectionStatus !== "MOTION_ARTIFACT") {
      this.lastPlacementEvidence = null;
      this.onSignalReady({
        timestamp,
        rawValue: 0, filteredValue: 0, quality: 0,
        fingerDetected: true, contactState: this.contactState,
        motionArtifact,
        roi: this.signalRoiFromMetrics(roi),
        perfusionIndex: this.cachedPI,
        rawRed: roi.rawRed,
        rawGreen: roi.rawGreen,
        rawBlue: roi.rawBlue,
        diagnostics: this.buildFingerDiagnostics(roi, motionArtifact, rejectionStatus, {
          message: `RECHAZADO: ${rejectionStatus}`,
        }),
      });
      // No retornamos aquÃ­ para permitir que los buffers sigan llenÃ¡ndose, pero la UI sabrÃ¡ que no es vÃ¡lido
      return;
    }

    // Tenemos contacto (UNSTABLE o STABLE)
    this.updateChannelBaselines(roi.rawRed, roi.rawGreen, roi.rawBlue, motionArtifact);

    const zlo = getZlo();
    const zloAdjR = zlo.calibrated ? Math.max(0, roi.rawRed - zlo.r) : roi.rawRed;
    const zloAdjG = zlo.calibrated ? Math.max(0, roi.rawGreen - zlo.g) : roi.rawGreen;
    const zloAdjB = zlo.calibrated ? Math.max(0, roi.rawBlue - zlo.b) : roi.rawBlue;
    this.redBuffer.push(zloAdjR);
    this.greenBuffer.push(zloAdjG);
    this.blueBuffer.push(zloAdjB);

    this.updateSignalMotion(
      roi.rawRed,
      Math.max(roi.centroidMotion, roi.displacementPenalty),
    );

    // ACDC: mÃ¡s frecuente con dedo para que PI/SQI no queden en 0 varios segundos
    if (this.redBuffer.length >= 36 && this.frameCount % 2 === 0) {
      this.calculateACDCPrecise();
    }
    const acPi = this.calculatePerfusionIndex();
    const pulsePi = this.estimatePulsePiFromRoi();
    this.cachedPI = Math.max(acPi, pulsePi);

    // Evidencia de colocacion fisica REAL (presion, ubicacion, movimiento,
    // pulso) — alimenta la ventana 3D y la guia de UI. Cada frame con dedo.
    // `sealRatio` es el sellado por tejido (no la máscara AC/DC): con el flash
    // encendido el rojo satura y la máscara fisiológica colapsa, lo que hacía
    // que el modelo leyera "poco dedo" con el dedo bien apoyado.
    this.lastPlacementEvidence = computePlacementEvidence({
      sealRatio: roi.sealRatio,
      perfusedFraction: roi.perfusedFraction,
      centroidX: roi.centroidX,
      centroidY: roi.centroidY,
      motionScore: Math.max(this.motionScore, this.signalMotionScore),
      perfusionIndex: this.cachedPI,
      dcLevel: roi.tissueRed > 0 ? roi.tissueRed : this.redDC > 0 ? this.redDC : this.smoothedRed,
      roiRedCv: this.lastRoiRedCv,
    });

    const placementInstant = classifyFingerPlacement({
      coverageRatio: this.smoothedCoverage || roi.coverageRatio,
      roiRedCv: this.lastRoiRedCv,
      perfusionIndex: this.cachedPI,
    });
    const smoothedPlacement = smoothPlacementMode(
      this.placementMode,
      placementInstant,
      this.placementStreak,
    );
    this.placementMode = smoothedPlacement.mode;
    this.placementStreak = smoothedPlacement.streak;

    this.reconcileStableContact();

    // Multi-source extraction
    const pulseSource = this.extractBestPulseSignal(
      roi.rawRed,
      roi.rawGreen,
      roi.rawBlue,
      motionArtifact,
      this.placementMode,
    );
    const morphSource = this.extractMorphologySignal(
      roi.rawRed,
      roi.rawGreen,
      roi.rawBlue,
      this.placementMode,
    );

    const jitterScale =
      1 -
      VITAL_THRESHOLDS.PIXEL_ROI.JITTER_ATTENUATION *
        roi.displacementPenalty;
    const pulseValue = pulseSource.value * jitterScale;
    const morphValue = morphSource * jitterScale;

    this.rawBuffer.push(pulseValue);

    const endFilt = ppgPerf.start('bandpass');
    // ACONDICIONAMIENTO ACTIVO en vivo: estabiliza la lÃ­nea base (quita deriva) y
    // hace denoise que PRESERVA los picos sistÃ³licos, ANTES del bandpass â†’ la seÃ±al
    // que se mide y se muestra es genuinamente mÃ¡s limpia y firme (no recorta el pulso).
    const stabilizedInput = stabilizeSample(this.activeStabilizer, pulseValue);
    const filtered = this.bandpassFilter.filter(stabilizedInput);
    const morphFiltered = this.morphBandpassFilter.filter(morphValue);
    const enhanced = applyPulseAgc(
      this.pulseAgcState,
      filtered,
      this.cachedPeriodicity > 0 ? this.cachedPeriodicity : this.periodicityEma,
      Math.max(this.motionScore, this.signalMotionScore),
      DEFAULT_PULSE_AGC,
      this.contactState === 'STABLE_CONTACT',
    );
    endFilt();
    this.filteredBuffer.push(enhanced);

    // === BANCO DE FILTROS POR CANAL VITAL (PPGSignalSplitter) ===
    // Cada signo vital recibe la seÃ±al pre-procesada con los requisitos DSP de su canal.
    const splitOut = this.signalSplitter.process(
      roi.rawRed,
      roi.rawGreen,
      roi.rawBlue,
      this.lastKnownBpm,
    );

    const endSqi = ppgPerf.start('sqi');
    this.periodicitySkip++;
    if (this.periodicitySkip >= 4 || this.filteredBuffer.length < 90) {
      this.periodicitySkip = 0;
      const pInstant = this.calculatePeriodicity();
      this.periodicityEma =
        this.periodicityEma <= 0
          ? pInstant
          : this.periodicityEma * 0.72 + pInstant * 0.28;
    }
    this.cachedPeriodicity = this.periodicityEma;

    this.sqiMetricsCounter++;
    if (this.sqiMetricsCounter >= 8 && this.filteredBuffer.length >= 60) {
      this.sqiMetricsCounter = 0;
      const fLen = this.filteredBuffer.length;
      const fTail = this.filteredBuffer.tail(fLen);
      if (fTail.length >= 30) {
        const n = fTail.length;
        let s1 = 0, s2 = 0, s3 = 0, s4 = 0;
        for (let i = 0; i < n; i++) {
          const v = fTail[i];
          s1 += v;
          s2 += v * v;
          s3 += v * v * v;
          s4 += v * v * v * v;
        }
        const mean = s1 / n;
        const var_ = s2 / n - mean * mean;
        const std = Math.sqrt(var_);
        if (std > 1e-8) {
          this.cachedSkewness = (s3 / n - 3 * mean * (s2 / n) + 2 * mean * mean * mean) / (std * std * std);
          this.cachedKurtosis = (s4 / n - 4 * mean * (s3 / n) + 6 * mean * mean * (s2 / n) - 3 * mean * mean * mean * mean) / (var_ * var_);
          this.cachedRelativePower = this.cachedPeriodicity;
        }
      }
    }

    const snapPerf = ppgPerf.snapshot();
    const metrics: SignalQualityMetrics = {
      sqi: 0,
      perfusionIndex: this.cachedPI,
      snr: pulseSource.strength,
      periodicity: this.cachedPeriodicity,
      motionScore: Math.max(this.motionScore, this.signalMotionScore),
      saturationRatio: roi.rawRed > 250 ? 1 : 0,
      underexposureRatio: this.underexposureEma,
      frameDropRatio: snapPerf.droppedEstimate / Math.max(1, this.frameCount),
      fpsEffective: this.estimatedSampleRate,
      timestampJitterMs: snapPerf.jitterMs,
      skewness: this.cachedSkewness,
      relativePower: this.cachedRelativePower,
    };

    this.cachedSqi = SignalQualityIndex.calculate(metrics);
    this.signalQuality = this.cachedSqi;

    const rejectionScale =
      rejectionStatus === 'MOTION_ARTIFACT'
        ? 0.78
        : rejectionStatus && rejectionStatus !== 'WARMUP'
          ? 0.45
          : 1;
    this.displaySqiEma = SignalQualityIndex.smoothDisplayedSqi(
      this.displaySqiEma,
      this.signalQuality,
      this.contactState,
      rejectionScale,
    );
    endSqi();

    const perfusionIndex = this.cachedPI;
    const snapHb = this.rgbSnapshotFromSmoothed();
    const hemoglobinScene =
      hasFingerHemoglobinSignature(snapHb) && !isOpenFlashWithoutContact(snapHb);
    const ensembleScene = this.lastEnsembleScore > VITAL_THRESHOLDS.FINGER.ENSEMBLE_FINGER_THRESHOLD;
    const fingerUi =
      this.fingerDetected &&
      liveFinger &&
      (hemoglobinScene || ensembleScene) &&
      (this.lastInstantFinger || this.contactState === 'STABLE_CONTACT');

    // Post-motion hold-off: despues de que el motion cesa, el BPF 4Â° orden aun
    // tiene ringing (~0.5s). Suprimimos la salida durante ese tiempo.
    if (motionArtifact) {
      this.postMotionSuppression = 20; // ~670ms a 30fps
    } else if (this.postMotionSuppression > 0) {
      this.postMotionSuppression--;
    }

    const signalPathActive =
      (fingerUi ||
      (this.lastInstantFinger &&
        (hemoglobinScene || ensembleScene) &&
        this.smoothedCoverage >= VITAL_THRESHOLDS.FINGER.MIN_COVERAGE * 0.85)) &&
      !motionArtifact &&
      this.postMotionSuppression <= 0;
    const displayQuality = signalPathActive
      ? fingerUi
        ? this.displaySqiEma
        : Math.round(this.displaySqiEma * 0.55)
      : 0;
    const rawSqiOut = signalPathActive ? this.signalQuality : 0;

    this.stepAcquisition(fingerUi);

    const now = timestamp;
    if (now - this.lastLogTime >= 2000) {
      this.lastLogTime = now;
      const snap = ppgPerf.snapshot();
      log.info(
        `[${pulseSource.label}] Filt=${enhanced.toFixed(3)} agc=${this.pulseAgcState.scale.toFixed(2)} Q=${displayQuality} raw=${this.signalQuality} ` +
        `PI=${perfusionIndex.toFixed(4)} P=${this.cachedPeriodicity.toFixed(2)} Contact=${this.contactState} ` +
        `FPS=${snap.fps.toFixed(1)} jitter=${snap.jitterMs.toFixed(1)}ms ` +
        `roi=${(snap.stages.roi?.p95 ?? 0).toFixed(2)}ms ` +
        `filt=${(snap.stages.bandpass?.p95 ?? 0).toFixed(2)}ms ` +
        `sqi=${(snap.stages.sqi?.p95 ?? 0).toFixed(2)}ms ` +
        `dropEst=${snap.droppedEstimate}`
      );
    }

    const displayStatus = SignalQualityIndex.resolveDiagnosticDisplayStatus(
      this.diagStatusState,
      {
        rejectionStatus,
        rawSqi: rawSqiOut,
        pi: perfusionIndex,
        fingerDetected: fingerUi,
        contactState: this.contactState,
      },
    );

    // Refresca (throttled) la estimaciÃ³n respiratoria del acelerÃ³metro antes de emitir.
    this.updateAccelRespEstimate(timestamp);

    this.onSignalReady({
      timestamp,
      rawValue: signalPathActive ? pulseSource.value : 0,
      filteredValue: signalPathActive ? enhanced : 0,
      morphologyValue: signalPathActive ? morphFiltered : 0,
      // Canales del banco de filtros especializado por signo vital
      morphologyFiltered: signalPathActive ? splitOut.morphology : 0,
      respirationFiltered: signalPathActive ? splitOut.respiration : 0,
      arrhythmiaFiltered: signalPathActive ? splitOut.arrhythmia : 0,
      spo2Channels: signalPathActive ? splitOut.spo2 : undefined,
      placementMode: this.placementMode,
      quality: displayQuality,
      fingerDetected: fingerUi,
      contactState: this.contactState,
      motionArtifact,
      roi: this.signalRoiFromMetrics(roi),
      perfusionIndex,
      rawRed: roi.rawRed,
      rawGreen: roi.rawGreen,
      rawBlue: roi.rawBlue,
      accelRespiration: this.accelRespEstimate ?? undefined,
      diagnostics: {
        ...this.buildFingerDiagnostics(roi, motionArtifact, displayStatus, {
          message:
            `${pulseSource.label}:${pulseSource.strength.toFixed(1)} ` +
            `PI:${perfusionIndex.toFixed(2)} SQI:${Math.round(this.diagStatusState.smoothedSqi)} ` +
            `C:${(roi.coverageRatio * 100).toFixed(0)}% ${this.placementMode} ${this.contactState}${motionArtifact ? ' MOV' : ''}`,
          placementMode: this.placementMode,
          placementHint: placementHintText(this.placementMode),
          hasPulsatility:
            fingerUi &&
            (SignalQualityIndex.isClinicallyValid(rawSqiOut, perfusionIndex) ||
              SignalQualityIndex.isAdequateForLiveVitals(rawSqiOut, perfusionIndex)),
          pulsatilityValue:
            this.contactState === 'STABLE_CONTACT'
              ? Math.max(perfusionIndex, pulseSource.strength * 0.02)
              : 0,
        }),
        sqm: {
          sqi: rawSqiOut,
          perfusionIndex: perfusionIndex,
          snr: pulseSource.strength,
          periodicity: this.cachedPeriodicity,
          // Movimiento efectivo = max(IMU, micro-movimiento del dedo desde la seÃ±al).
          motionScore: Math.max(this.motionScore, this.signalMotionScore),
          saturationRatio: (roi.rawRed > 250 ? 1 : 0),
          underexposureRatio: this.underexposureEma,
          fpsEffective: this.estimatedSampleRate,
          frameDropRatio: ppgPerf.snapshot().droppedEstimate / Math.max(1, this.frameCount),
          timestampJitterMs: ppgPerf.snapshot().jitterMs,
        } as SignalQualityMetrics,
      },
    });
  }

  private getFingerConfirmFrames(): number {
    return this.cameraHints.fingerConfirmFrames;
  }

  /**
   * Avanza la estabilizaciÃ³n de adquisiciÃ³n un frame con las mÃ©tricas ya
   * calculadas. Cuando no hay contacto usable, la confianza decae sola.
   */
  private stepAcquisition(fingerDetected: boolean): void {
    updateAcquisition(this.acquisitionState, {
      fingerDetected,
      contactState: this.contactState,
      perfusionIndex: this.cachedPI,
      periodicity: this.cachedPeriodicity,
      sqi: this.signalQuality,
      motionScore: Math.max(this.motionScore, this.signalMotionScore),
      coverageRatio: this.smoothedCoverage,
    });
  }

  // === ESTADO DE CONTACTO UNIFICADO ===
  private updateContactState(roi: ROIMetrics): void {
    const previousState = this.contactState;
    const hints = this.cameraHints;
    const confirmFrames = this.getFingerConfirmFrames();
    const instantDetected = this.detectFingerInstant(roi);
    this.lastInstantFinger = instantDetected;

    if (instantDetected) {
      this.instantLostStreak = 0;
      this.noContactHardStreak = 0;
      this.fingerLostCount = 0;
      this.fingerConfidenceCount = Math.min(this.fingerConfidenceCount + 1, 100);
      this.stableContactCount++;

      if (this.fingerConfidenceCount >= confirmFrames) {
        this.fingerDetected = true;
        this.contactState = 'UNSTABLE_CONTACT';
      }
    } else {
      this.instantLostStreak++;
      const decay = hints.constrained ? 1 : 3;
      this.fingerConfidenceCount = Math.max(0, this.fingerConfidenceCount - decay);
      this.fingerLostCount++;
      this.stableContactCount = Math.max(0, this.stableContactCount - (hints.constrained ? 1 : 2));

      const rawSnap = this.rawRgbSnapshotFromRoi(roi);
      const smoothSnap = this.rgbSnapshotFromSmoothed();
      const flashOpen =
        !this.fingerDetected &&
        (isOpenFlashWithoutContact(rawSnap) || isOpenFlashWithoutContact(smoothSnap));

      if (flashOpen) {
        this.setNoContact(true);
      } else if (this.fingerDetected) {
        if (this.instantLostStreak <= hints.instantLostToUnstable) {
          this.contactState = 'UNSTABLE_CONTACT';
        } else if (this.instantLostStreak <= hints.instantLostToNoContact) {
          this.contactState = 'NO_CONTACT';
          this.noContactHardStreak++;
           this.lastPlacementEvidence = null;
          if (this.noContactHardStreak >= hints.bufferResetAfterNoContact) {
            this.setNoContact(true);
          }
        } else {
          this.setNoContact(true);
        }
      } else if (this.instantLostStreak <= hints.instantLostToUnstable && this.isLiveFingerFrame(roi)) {
        this.contactState = 'UNSTABLE_CONTACT';
      } else if (this.instantLostStreak <= hints.instantLostToNoContact) {
        this.contactState = 'NO_CONTACT';
        this.lastPlacementEvidence = null;
      } else {
        this.setNoContact(true);
      }
    }

    if (previousState === 'NO_CONTACT' && this.contactState !== 'NO_CONTACT') {
      // Siempre resetear al salir de NO_CONTACT: si el gap fue corto (p. ej.
      // dedo se pierde 1-2 frames y se recoloca), los filtros llevan estado
      // sucio que produce ringing al heartbeat processor.
      this.resetSignalTrackingBuffers();
      this.resetBaselines();
      this.consecutiveNoContactFrames = 0;
      this.noContactHardStreak = 0;
    } else if (this.contactState !== 'NO_CONTACT') {
      this.consecutiveNoContactFrames = 0;
      this.noContactHardStreak = 0;
    }
  }

/**
 * STABLE solo con PI real ya calculado en este frame (no en updateContactState).
 *
 * ANTI FALSO-POSITIVO "posicion perfecta":
 *  - Se exige PI >= STABLE_MIN_PI (0.0020) Y evidencia de pulso (firma de
 *    hemoglobina + CV del rojo) â€” ambos, no el OR destructivo anterior: con
 *    flash encendido el ruido del AE superaba MIN_PI*0.75 solo y bastaba para
 *    declarar STABLE sin pulso real.
 *  - Se exige cobertura >= STABLE_MIN_COVERAGE (0.35) â€” un dedo rozando el lente
 *    cubria el 9% (MIN_COVERAGE) y pasaba como "perfecto".
 *  - Sin pulso evidenciado durante STABLE_MAX_NO_PULSE_FRAMES consecutivos (~1 s)
 *    el estado degrada a UNSTABLE: la validacion es CONTINUA, no solo al adquirir.
 */
  private reconcileStableContact(): void {
    if (!this.fingerDetected || !this.lastInstantFinger) {
      if (this.contactState === 'STABLE_CONTACT') {
        this.contactState = 'UNSTABLE_CONTACT';
      }
      return;
    }
    const Q = VITAL_THRESHOLDS.QUALITY;
    const F = VITAL_THRESHOLDS.FINGER;
    const snap = this.rgbSnapshotFromSmoothed();
    const padLike = this.placementMode === 'pad';
    const pulseOk =
      hasFingerHemoglobinSignature(snap) &&
      !isOpenFlashWithoutContact(snap) &&
      this.smoothedCoverage >= F.MIN_COVERAGE * (padLike ? 0.82 : 0.92) &&
      (padLike ||
        this.lastRoiRedCv >= F.ROI_RED_CV_MIN * 0.88);
    // Pulso REAL: PI sobre el piso anti-ruido Y (firma RGB+CV, o periodicidad
    // espectral cardiaca sostenida como via alternativa cuando la firma RGB
    // fluctua frame a frame con el AE).
    const piOk = this.cachedPI >= Q.STABLE_MIN_PI;
    const periodicOk = this.cachedPeriodicity >= Q.WAVE_PERIODICITY_REF && piOk;
    const pulseEvidenced = piOk && (pulseOk || periodicOk);
    const covOk = this.smoothedCoverage >= Q.STABLE_MIN_COVERAGE * (padLike ? 0.82 : 1);

    if (pulseEvidenced) {
      this.stableNoPulseStreak = 0;
    } else if (this.contactState === 'STABLE_CONTACT' || this.stableNoPulseStreak > 0) {
      this.stableNoPulseStreak++;
    }

    const stable =
      this.stableContactCount >= Q.STABLE_FRAMES_REQ &&
      pulseEvidenced &&
      covOk;

    if (this.contactState === 'STABLE_CONTACT') {
      // REVERSION continua: sin pulso sostenido degrada, aunque la escena
      // siga "roja" (dedo apoyado sin flujo util = medicion invalida).
      this.contactState =
        stable || this.stableNoPulseStreak < Q.STABLE_MAX_NO_PULSE_FRAMES
          ? 'STABLE_CONTACT'
          : 'UNSTABLE_CONTACT';
    } else {
      this.contactState = stable ? 'STABLE_CONTACT' : 'UNSTABLE_CONTACT';
    }
  }

  /** PÃ©rdida de contacto; en modo tolerante evita reset de buffers hasta racha larga. */
  private setNoContact(hardReset: boolean): void {
    this.contactState = 'NO_CONTACT';
    this.fingerDetected = false;
    this.fingerConfidenceCount = 0;
    this.stableContactCount = 0;
    this.instantLostStreak = 0;
    this.lastInstantFinger = false;
    this.liveFingerMissStreak = 0;
    this.stableNoPulseStreak = 0;
    resetPlacementEvidence();

    if (hardReset) {
      this.decaySmoothedRgbFast();
      this.resetSignalTrackingBuffers();
      this.resetBaselines();
      this.roiRedPulseRing.reset();
      this.lastRoiRedCv = 0;
    }
  }

  private decaySmoothedRgbFast(): void {
    const k = 0.55;
    this.smoothedRed *= 1 - k;
    this.smoothedGreen *= 1 - k;
    this.smoothedBlue *= 1 - k;
    this.smoothedCoverage *= 1 - k;
    this.smoothedFingerScore *= 1 - k;
    if (this.smoothedRed < 2) this.smoothedRed = 0;
    if (this.smoothedCoverage < 0.02) this.smoothedCoverage = 0;
  }

  private rawRgbSnapshotFromRoi(roi: ROIMetrics) {
    return {
      red: roi.rawRed,
      green: roi.rawGreen,
      blue: roi.rawBlue,
      coverage: roi.coverageRatio,
      fingerScore: roi.fingerScore,
    };
  }



  private fingerSpatial(roi: ROIMetrics) {
    return {
      coverageRatio: roi.coverageRatio,
      fingerScore: roi.fingerScore,
      fingerTileCount: roi.fingerTileCount,
    };
  }

  private isLiveFingerFrame(roi: ROIMetrics, ensembleScore = 0): boolean {
    const raw = this.rawRgbSnapshotFromRoi(roi);
    const smoothed = this.rgbSnapshotFromSmoothed();
    const spatial = this.fingerSpatial(roi);
    const F = VITAL_THRESHOLDS.FINGER;

    if (this.fingerDetected) {
      if (ensembleScore > F.ENSEMBLE_FINGER_THRESHOLD * 0.8) return true;
      if (passesFingerMaintain(raw, smoothed, spatial, ensembleScore)) return true;
      if (
        this.cachedPI >= F.PULSE_HOLD_MIN_PI &&
        raw.red >= F.PULSE_HOLD_MIN_RED &&
        raw.red / Math.max(1, raw.green) >= F.PULSE_HOLD_RG &&
        raw.red / Math.max(1, raw.blue) >= F.PULSE_HOLD_RB &&
        spatial.coverageRatio >= F.PULSE_HOLD_COVERAGE &&
        this.motionScore <= F.PULSE_HOLD_MAX_MOTION
      ) {
        return true;
      }
    }

    return passesLiveFingerContact(raw, smoothed, spatial, ensembleScore);
  }

  private rgbSnapshotFromSmoothed() {
    return {
      red: this.smoothedRed,
      green: this.smoothedGreen,
      blue: this.smoothedBlue,
      coverage: this.smoothedCoverage,
      fingerScore: this.smoothedFingerScore,
    };
  }

  private detectFingerInstant(roi: ROIMetrics): boolean {
    const F = VITAL_THRESHOLDS.FINGER;
    const { rawRed, rawGreen, rawBlue, coverageRatio, fingerScore } = roi;

    if (this.smoothedRed === 0) {
      this.smoothedRed = rawRed;
      this.smoothedGreen = rawGreen;
      this.smoothedBlue = rawBlue;
      this.smoothedCoverage = coverageRatio;
      this.smoothedFingerScore = fingerScore;
    } else {
      const a = this.RGB_SMOOTH_ALPHA;
      const ca = this.COVERAGE_SMOOTH_ALPHA;
      this.smoothedRed = this.smoothedRed * (1 - a) + rawRed * a;
      this.smoothedGreen = this.smoothedGreen * (1 - a) + rawGreen * a;
      this.smoothedBlue = this.smoothedBlue * (1 - a) + rawBlue * a;
      this.smoothedCoverage = this.smoothedCoverage * (1 - ca) + coverageRatio * ca;
      this.smoothedFingerScore = this.smoothedFingerScore * (1 - ca) + fingerScore * ca;
    }

    const raw = this.rawRgbSnapshotFromRoi(roi);
    const smoothed = this.rgbSnapshotFromSmoothed();
    const spatial = this.fingerSpatial(roi);

    if (this.motionScore > F.ACQUIRE_MAX_MOTION_SOFT) return false;
    if (raw.red > 254 && raw.green > 254 && raw.blue > 254) return false;

    const placementInstant = classifyFingerPlacement({
      coverageRatio: spatial.coverageRatio,
      roiRedCv: this.lastRoiRedCv,
      perfusionIndex: this.cachedPI,
    });
    // VÃ­a UNIVERSAL por pulsatilidad: un pulso real del rojo confirma dedo aunque
    // la firma de color estricta falle (cÃ¡mara con otro balance de blancos/flash).
    const pulsatileContact = passesPulsatileAcquire(
      raw, smoothed, spatial, this.lastRoiRedCv, this.lastEnsembleScore,
    );

    if (
      !this.fingerDetected &&
      !this.cameraHints.constrained &&
      placementInstant !== 'pad' &&
      // El guard de flicker usa el umbral R/B LAXO de la vÃ­a pulsÃ¡til (no el estricto):
      // asÃ­ no descarta un dedo que pulsa pero con rojo moderado en otra cÃ¡mara.
      isExposureFlickerNotFingerPulse(this.lastRoiRedCv, smoothed, F.PULSATILE_ACQUIRE_RB) &&
      !pulsatileContact &&
      this.lastEnsembleScore < F.ENSEMBLE_FINGER_THRESHOLD * 0.7
    ) {
      return false;
    }

    // Contacto: vÃ­a COLOR (hemoglobina) o vÃ­a PULSATILIDAD (universal).
    // La vÃ­a pulsÃ¡til es prioritaria: un pulso claro + brillo mÃ­nimo = dedo, incluso
    // si la firma de color falla por balance de blancos/presiÃ³n/colocaciÃ³n.
    const fingerByPulse =
      (pulsatileContact || this.lastEnsembleScore > F.ENSEMBLE_FINGER_THRESHOLD * 0.7) &&
      spatial.coverageRatio >= F.MIN_COVERAGE * 0.5;
    if (!passesLiveFingerContact(raw, smoothed, spatial, this.lastEnsembleScore)) {
      return fingerByPulse;
    }
    if (this.fingerDetected) return true;
    return (
      passesFingerAcquire(raw, smoothed, spatial, {
        roiRedCv: this.lastRoiRedCv,
        perfusionIndex: this.cachedPI,
        ensembleScore: this.lastEnsembleScore,
      }) || fingerByPulse
    );
  }

  private signalRoiFromMetrics(roi: ROIMetrics) {
    return { x: roi.roiX, y: roi.roiY, width: roi.roiW, height: roi.roiH };
  }

  private buildFingerDiagnostics(
    roi: ROIMetrics,
    motionArtifact: boolean,
    status: MeasurementStatus,
    extras?: {
      message?: string;
      hasPulsatility?: boolean;
      pulsatilityValue?: number;
      placementMode?: FingerPlacementMode;
      placementHint?: string;
    },
  ) {
    const coverageRatio = roi.coverageRatio;
    return {
      placementEvidence: this.lastPlacementEvidence ?? undefined,
      message:
        extras?.message ??
        `BUSCANDO DEDO · cobertura ${(coverageRatio * 100).toFixed(0)}%`,
      hasPulsatility: extras?.hasPulsatility ?? false,
      pulsatilityValue: extras?.pulsatilityValue ?? 0,
      coverageRatio,
      sealRatio: roi.sealRatio,
      perfusedFraction: roi.perfusedFraction,
      placementMode: extras?.placementMode,
      placementHint: extras?.placementHint,
      status,
      acquisitionStage: this.acquisitionState.stage,
      acquisitionConfidence: this.acquisitionState.confidence,
      acquisitionProgress: this.acquisitionState.progress,
    };
  }

  private updateSampleRate(timestamp: number): void {
    if (this.lastFrameTimestamp === 0) {
      this.lastFrameTimestamp = timestamp;
      return;
    }

    const delta = timestamp - this.lastFrameTimestamp;
    this.lastFrameTimestamp = timestamp;

    if (delta < 10 || delta > 200) return;

    this.frameIntervalBuffer.push(delta);

    if (this.frameIntervalBuffer.length < 8) return;

    // Median FPS drifts slowly â€” recompute every 10 frames.
    if (this.frameCount % 10 !== 0) return;

    const fiTail = this.frameIntervalBuffer.tail(this.frameIntervalBuffer.length);
    fiTail.sort((a, b) => a - b);
    const median = fiTail[Math.floor(fiTail.length / 2)] ?? 33;
    const estimatedFps = clamp(1000 / median, 10, 40);

    if (Math.abs(estimatedFps - this.estimatedSampleRate) > 2) {
      this.estimatedSampleRate = estimatedFps;
      this.bandpassFilter.setSampleRate(this.estimatedSampleRate);
      this.morphBandpassFilter.setSampleRate(this.estimatedSampleRate);
      this.signalSplitter.setSampleRate(this.estimatedSampleRate);
    }
  }

  private extractROI(imageData: ImageData): ROIMetrics {
    const frame = this.pixelRoi.processFrame(imageData, this.pixelStride);
    return {
      rawRed: frame.rawRed,
      rawGreen: frame.rawGreen,
      rawBlue: frame.rawBlue,
      coverageRatio: frame.coverageRatio,
      fingerScore: frame.fingerScore,
      fingerTileCount: frame.fingerRegionCount,
      sealRatio: frame.tissueRatio,
      perfusedFraction: frame.perfusionRatio,
      tissueRed: frame.tissueRed,
      roiX: frame.roiX,
      roiY: frame.roiY,
      roiW: frame.roiW,
      roiH: frame.roiH,
      centroidMotion: frame.centroidMotion,
      centroidX: frame.centroidX,
      centroidY: frame.centroidY,
      maskCorrelation: frame.maskCorrelation,
      displacementPenalty: frame.displacementPenalty,
    };
  }

  private updateChannelBaselines(rawRed: number, rawGreen: number, rawBlue: number, motionArtifact: boolean): void {
    if (this.redBaseline === 0) {
      this.redBaseline = rawRed;
      this.greenBaseline = rawGreen;
      this.blueBaseline = rawBlue;
      return;
    }

    // Durante motion el DC salta â€” aceleramos el tracking para evitar que el
    // bandpass reciba una senal mal normalizada que genera ringing post-motion.
    // Ademas, si salimos de motion saltamos la baseline al valor actual (el DC
    // ya cambio y no tiene sentido converger lentamente).
    const motionAlpha = this.motionScore > 0.3 ? 0.20 : motionArtifact ? 0.12 : 0;
    const alpha = motionArtifact
      ? motionAlpha
      : this.contactState === 'STABLE_CONTACT'
        ? 0.02
        : 0.04;
    const redBlPrev = this.redBaseline;
    this.redBaseline = this.redBaseline * (1 - alpha) + rawRed * alpha;
    this.greenBaseline = this.greenBaseline * (1 - alpha) + rawGreen * alpha;
    this.blueBaseline = this.blueBaseline * (1 - alpha) + rawBlue * alpha;
    // Si el baseline previo era muy distinto al raw y el nuevo alpha se quedo
    // corto, aproximamos en un solo salto: el DC ya cambio y la convergencia
    // lenta solo prolonga el ringing.
    if (motionArtifact && this.motionScore > 0.3) {
      const step = Math.abs(rawRed - redBlPrev) / Math.max(1, redBlPrev);
      if (step > 0.03) {
        const fastAlpha = clamp(step * 2, 0.15, 0.6);
        this.redBaseline = this.redBaseline * (1 - fastAlpha) + rawRed * fastAlpha;
        this.greenBaseline = this.greenBaseline * (1 - fastAlpha) + rawGreen * fastAlpha;
        this.blueBaseline = this.blueBaseline * (1 - fastAlpha) + rawBlue * fastAlpha;
      }
    }
  }

  // === MULTI-SOURCE COMPETITIVE EXTRACTION ===
  private extractMorphologySignal(
    rawRed: number,
    rawGreen: number,
    rawBlue: number,
    placement: FingerPlacementMode,
  ): number {
    const gNorm =
      this.greenBaseline > 0 ? (this.greenBaseline - rawGreen) / this.greenBaseline : 0;
    const rNorm = this.redBaseline > 0 ? (this.redBaseline - rawRed) / this.redBaseline : 0;
    const clampMorph = (v: number) => clamp(v, -0.08, 0.08);
    const gPulse = clampMorph(gNorm);
    const rPulse = clampMorph(rNorm * 0.35);
    const greenWeight = placement === 'pad' ? 0.88 : placement === 'tip' ? 0.62 : 0.78;
    return (gPulse * greenWeight + rPulse * (1 - greenWeight)) * 4000;
  }

  private extractBestPulseSignal(
    rawRed: number,
    rawGreen: number,
    rawBlue: number,
    motionArtifact: boolean,
    placement: FingerPlacementMode,
  ): { value: number; label: string; strength: number } {
    const rNorm = this.redBaseline > 0 ? (this.redBaseline - rawRed) / this.redBaseline : 0;
    const gNorm = this.greenBaseline > 0 ? (this.greenBaseline - rawGreen) / this.greenBaseline : 0;
    const bNorm = this.blueBaseline > 0 ? (this.blueBaseline - rawBlue) / this.blueBaseline : 0;

    const clampMax = placement === 'pad' ? 0.07 : placement === 'tip' ? 0.05 : 0.06;
    const clampPulse = (v: number) => clamp(v, -clampMax, clampMax);
    const rPulse = clampPulse(rNorm);
    const gPulse = clampPulse(gNorm);
    const bPulse = clampPulse(bNorm);
    const amp = 4400;

    // Plane-Orthogonal-to-Skin (POS) Projection â€” con alpha adaptativo suavizado.
    // stdX/stdY estima el Ã¡ngulo del plano piel; se suaviza con EMA y se pondera
    // por confianza estadÃ­stica (stdY grande â†’ estimaciÃ³n fiable; stdY pequeÃ±o â†’
    // se blend hacia el prior suavizado para evitar inestabilidad por divisiÃ³n).
    const X = gPulse - bPulse;
    const Y = gPulse + bPulse - 2 * rPulse;
    this.xBuffer.push(X);
    this.yBuffer.push(Y);

    const stdX = this.calculateStdDev(this.xBuffer);
    const stdY = this.calculateStdDev(this.yBuffer);
    const rawAlpha = stdY > 1e-9 ? stdX / stdY : this.smoothedPosAlpha;
    const reliability = clamp(stdY / Math.max(1, stdX * 0.5 + stdY), 0, 1);
    const blendedAlpha = rawAlpha * reliability + this.smoothedPosAlpha * (1 - reliability);
    this.smoothedPosAlpha = this.smoothedPosAlpha * 0.9 + blendedAlpha * 0.1;
    const posVal = X + this.smoothedPosAlpha * Y;

    // Source candidates (CHROM removed â€” amplifica ruido sin dedo)
    const sources: { [key: string]: number } = {
      R: rPulse * amp,
      G: gPulse * amp,
      RG: this.blendRG(rPulse, gPulse, rawRed, rawGreen, motionArtifact) * amp,
      POS: posVal * amp,
    };

    // Update per-source buffers (ring auto-evicts mÃ¡s viejo)
    this.sourceBuffers.R.push(sources.R);
    this.sourceBuffers.G.push(sources.G);
    this.sourceBuffers.RG.push(sources.RG);
    this.sourceBuffers.POS.push(sources.POS);

    // Rank sources every ~1 second (30 frames)
    if (this.frameCount % 30 === 0 && this.redBuffer.length >= 60) {
      this.rankSources();
    }

    const value = clamp(sources[this.activeSource] ?? sources['RG'], -95, 95);
    const strength = Math.max(Math.abs(rPulse), Math.abs(gPulse)) * 1000;

    return { value, label: this.activeSource, strength };
  }

  private blendRG(rPulse: number, gPulse: number, rawRed: number, rawGreen: number, motionArtifact: boolean): number {
    const redPI = this.redDC > 0 ? this.redAC / this.redDC : 0;
    const greenPI = this.greenDC > 0 ? this.greenAC / this.greenDC : 0;
    const piSum = redPI + greenPI;

    // Verde tiene mejor SNR para HR en PPG por cÃ¡mara (Tyapochkin 2019, OpenPPG 2025)
    let greenWeight = 0.75;
    let redWeight = 0.25;

    if (piSum > 0) {
      greenWeight = clamp(greenPI / piSum, 0.65, 0.92);
      redWeight = 1 - greenWeight;
    }

    // Clipping: reducir peso del canal saturado sin invertir completamente la mezcla
    if (rawGreen > 248) { greenWeight = clamp(greenWeight * 0.25, 0.15, 0.5); redWeight = 1 - greenWeight; }
    else if (rawRed > 248) { redWeight = clamp(redWeight * 0.25, 0.15, 0.5); greenWeight = 1 - redWeight; }
    
    if (this.placementMode === 'pad') {
      greenWeight = clamp(greenWeight + 0.12, 0.72, 0.95);
      redWeight = 1 - greenWeight;
    } else if (this.placementMode === 'tip') {
      greenWeight = clamp(greenWeight - 0.08, 0.38, 0.72);
      redWeight = 1 - greenWeight;
    } else if (this.contactState === 'STABLE_CONTACT' && !motionArtifact) {
      greenWeight = clamp(greenWeight + 0.15, 0.6, 0.95);
      redWeight = 1 - greenWeight;
    }

    return rPulse * redWeight + gPulse * greenWeight;
  }

  private rankSources(): void {
    const now = Date.now();
    // Hysteresis: don't switch too often
    if (now - this.lastSourceSwitch < this.SOURCE_HYSTERESIS_MS) return;

    let bestSource = this.activeSource;
    let bestScore = -1;

    for (const key of Object.keys(this.sourceBuffers)) {
      const buf = this.sourceBuffers[key];
      if (buf.length < 45) continue;

      const recent = buf.tail(90);
      const score = this.computeSourceScore(recent);
      this.sourceScores[key] = score;

      if (score > bestScore) {
        bestScore = score;
        bestSource = key;
      }
    }

    // Solo cambia si la nueva fuente es CLARAMENTE mejor (>50%). Umbral alto +
    // histÃ©resis larga (4 s) â†’ el switching R/G/RG es raro: evita los saltos de
    // escala/offset al alternar fuente, que se veÃ­an como onda inestable/ruidosa.
    const currentScore = this.sourceScores[this.activeSource] ?? 0;
    if (bestSource !== this.activeSource && bestScore > currentScore * 1.5) {
      this.activeSource = bestSource;
      this.lastSourceSwitch = now;
    }
  }

  private calculateStdDev(ring: RingF32): number {
    const len = ring.length;
    if (len < 2) return 0;
    const arr = ring.tail(len);
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < len; i++) {
      const v = arr[i];
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / len;
    const variance = (sumSq / len) - (mean * mean);
    return Math.sqrt(Math.max(0, variance));
  }

  private computeSourceScore(buffer: number[]): number {
    if (buffer.length < 30) return 0;

    const sorted = [...buffer].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
    const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    const range = p90 - p10;
    if (range < 0.3) return 0;

    const mean = buffer.reduce((a, b) => a + b, 0) / buffer.length;
    const variance = buffer.reduce((a, v) => a + (v - mean) ** 2, 0) / buffer.length;
    const snr = range / (Math.sqrt(variance) + 0.1);

    // Check for clipping
    const clipped = buffer.filter(v => Math.abs(v) > 70).length / buffer.length;
    const clipPenalty = clipped * 30;

    return Math.max(0, snr * 15 - clipPenalty);
  }

  private calculateACDCPrecise(): void {
    const windowSize = Math.min(this.ACDC_WINDOW, this.redBuffer.length);
    if (windowSize < 36) return;

    // Copia zero-alloc de la cola de cada canal a scratch reutilizable (mismo
    // patrÃ³n que calculatePeriodicity). Antes se asignaban 3 number[] por llamada
    // (~15 Hz con dedo) vÃ­a tail() â†’ GC churn que provoca jitter/frames perdidos.
    const redW = this.acdcRedScratch;
    const greenW = this.acdcGreenScratch;
    const blueW = this.acdcBlueScratch;
    this.redBuffer.copyTailInto(redW, windowSize);
    this.greenBuffer.copyTailInto(greenW, windowSize);
    this.blueBuffer.copyTailInto(blueW, windowSize);

    // DC = media de la ventana. Suma en el MISMO orden (oldestâ†’newest) que el
    // tail()+reduce previo â†’ resultado numÃ©ricamente idÃ©ntico, sin alocar.
    let rSum = 0, gSum = 0, bSum = 0;
    for (let i = 0; i < windowSize; i++) {
      rSum += redW[i];
      gSum += greenW[i];
      bSum += blueW[i];
    }
    this.redDC = rSum / windowSize;
    this.greenDC = gSum / windowSize;
    this.blueDC = bSum / windowSize;

    if (this.redDC < 5 || this.greenDC < 5) return;

    const sortedScratch = this.sortedScratch;
    // `n` se pasa explÃ­cito: el scratch mide ACDC_WINDOW, no windowSize. Usar
    // window.length leerÃ­a datos viejos del resto del buffer.
    const computeAC = (window: Float32Array, n: number, dc: number): number => {
      let sumSq = 0;
      for (let i = 0; i < n; i++) {
        const d = window[i] - dc;
        sumSq += d * d;
        sortedScratch[i] = window[i];
      }
      const rms = Math.sqrt(sumSq / n);
      // In-place sort sobre la porciÃ³n usada del scratch (sin alocar).
      const view = sortedScratch.subarray(0, n);
      view.sort();
      const p5 = view[Math.floor(n * 0.05)] ?? 0;
      const p95 = view[Math.floor(n * 0.95)] ?? 0;
      const p2p = p95 - p5;
      return (rms * Math.sqrt(2) + p2p * 0.5) / 2;
    };

    this.redAC = computeAC(redW, windowSize, this.redDC);
    this.greenAC = computeAC(greenW, windowSize, this.greenDC);
    this.blueAC = computeAC(blueW, windowSize, this.blueDC);

    const redPI = this.redAC / this.redDC;
    const greenPI = this.greenAC / this.greenDC;

    if (redPI < 0.0001) this.redAC = 0;
    if (greenPI < 0.0001) this.greenAC = 0;
  }

  /**
   * Calcula la periodicidad de la seÃ±al mediante autocorrelaciÃ³n simplificada.
   * Un valor cercano a 1 indica una seÃ±al rÃ­tmica (pulso cardÃ­aco).
   * ZERO-ALLOCATION: Usa copyTailInto para evitar alocar number[] en cada frame.
   */
  private calculatePeriodicity(): number {
    const nReq = 90;
    if (this.filteredBuffer.length < nReq) return 0;
    
    // Usamos sortedScratch como buffer temporal para no alocar
    const n = this.filteredBuffer.copyTailInto(this.periodicityScratch, nReq);
    const data = this.periodicityScratch;
    
    // AutocorrelaciÃ³n: lags escalados por sample rate real (36-180 bpm @30fps)
    const sr = clamp(this.estimatedSampleRate, 10, 60);
    const minLag = Math.max(5, Math.round((sr * 60) / 180));
    const maxLag = Math.min(n - 8, Math.round((sr * 60) / 36));
    let maxCorr = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let dot = 0;
      let magA = 0;
      let magB = 0;
      for (let i = 0; i < n - lag; i++) {
        dot += data[i] * data[i + lag];
        magA += data[i] * data[i];
        magB += data[i + lag] * data[i + lag];
      }
      if (magA > 0 && magB > 0) {
        const corr = dot / Math.sqrt(magA * magB);
        if (corr > maxCorr) maxCorr = corr;
      }
    }
    return maxCorr;
  }

  private calculatePerfusionIndex(): number {
    // PI como ratio (0.0-1.0), NO porcentaje. La UI multiplica *100 para display.
    if (this.greenDC > 0) return this.greenAC / this.greenDC;
    if (this.redDC > 0) return this.redAC / this.redDC;
    return 0;
  }

  /** PI proxy desde CV temporal del ROI (antes de que ACDC llene la ventana). */
  private estimatePulsePiFromRoi(): number {
    const snap = this.rgbSnapshotFromSmoothed();
    if (isOpenFlashWithoutContact(snap)) return 0;
    if (
      isExposureFlickerNotFingerPulse(
        this.lastRoiRedCv,
        snap,
        VITAL_THRESHOLDS.FINGER.ACQUIRE_RB_STRICT,
      )
    ) {
      return 0;
    }
    const cv = this.lastRoiRedCv;
    if (cv < VITAL_THRESHOLDS.FINGER.ROI_RED_CV_MIN * 0.75) return 0;
    if (this.lastEnsembleScore < VITAL_THRESHOLDS.FINGER.ENSEMBLE_FINGER_THRESHOLD * 0.6) {
      if (!hasFingerHemoglobinSignature(snap)) return 0;
    }
    return clamp(cv * 0.016, 0.00012, 0.01);
  }

  private resetBaselines(): void {
    this.redBaseline = 0;
    this.greenBaseline = 0;
    this.blueBaseline = 0;
  }

  private resetSignalTrackingBuffers(): void {
    this.rawBuffer.reset();
    this.filteredBuffer.reset();
    this.redBuffer.reset();
    this.greenBuffer.reset();
    this.blueBuffer.reset();
    this.redDC = 0; this.redAC = 0;
    this.greenDC = 0; this.greenAC = 0;
    this.blueDC = 0; this.blueAC = 0;
    this.sourceBuffers.R.reset();
    this.sourceBuffers.G.reset();
    this.sourceBuffers.RG.reset();
    this.sourceBuffers.POS.reset();
    this.xBuffer.reset();
    this.yBuffer.reset();
    this.smoothedPosAlpha = 0.5;
    this.bandpassFilter.reset();
    this.morphBandpassFilter.reset();
    this.signalSplitter.reset();
    this.lastKnownBpm = 0;
    resetPulseAgc(this.pulseAgcState);
    this.roiRedPulseRing.reset();
    this.lastRoiRedCv = 0;
    this.signalMotionScore = 0;
    this.lastRawRedForMotion = 0;
    this.pixelRoi.reset();
    resetActiveStabilizer(this.activeStabilizer);
    this.placementMode = 'hybrid';
    this.placementStreak = { mode: 'hybrid', count: 0 };
    // Resetear contadores y caches para que el WARMUP gate (frameCount < 28)
    // se reactive y los caches no arrastren estado sucio de la sesion anterior.
    this.frameCount = 0;
    this.cachedSqi = 0;
    this.cachedPI = 0;
    this.cachedPeriodicity = 0;
    this.periodicityEma = 0;
    this.displaySqiEma = 0;
    this.signalQuality = 0;
    this.motionScore = 0;
    this.postMotionSuppression = 0;
    this.lastFrameTimestamp = 0;
    this.lastLogTime = 0;
    this.underexposureEma = 0;
    this.consecutiveNoContactFrames = 0;
    this.periodicitySkip = 0;
    this.fingerConfidenceCount = 0;
    this.smoothedRed = 0;
    this.smoothedGreen = 0;
    this.smoothedBlue = 0;
    this.smoothedCoverage = 0;
    this.smoothedFingerScore = 0;
    this.liveFingerMissStreak = 0;
    this.lastEnsembleScore = 0;
    this.lastRoiRedCv = 0;
    Object.assign(this.diagStatusState, createDiagnosticStatusState());
    resetZlo();
  }

  reset(): void {
    resetPlacementEvidence();
    this.lastPlacementEvidence = null;
    this.resetSignalTrackingBuffers();
    this.frameIntervalBuffer.reset();
    this.estimatedSampleRate = DSP_CONSTANTS.DEFAULT_SAMPLE_RATE;
    this.fingerDetected = false;
    this.contactState = 'NO_CONTACT';
    this.fingerLostCount = 0;
    this.stableContactCount = 0;
    this.instantLostStreak = 0;
    this.lastInstantFinger = false;
    this.accelRespRing.reset();
    this.gravityEmaInit = false;
    this.accelRespEstimate = null;
    this.lastAccelRespPushMs = 0;
    this.lastAccelRespComputeMs = 0;
    this.lastAcceleration = { x: 0, y: 0, z: 0 };
    this.sourceScores = { R: 0, G: 0, RG: 0, POS: 0 };
    this.activeSource = 'RG';
    this.lastSourceSwitch = 0;
    this.bandpassFilter.setSampleRate(this.estimatedSampleRate);
    this.morphBandpassFilter.setSampleRate(this.estimatedSampleRate);
    Object.assign(this.acquisitionState, createAcquisitionState());
  }

  /**
   * Score de micro-movimiento del dedo derivado de la SEÃ‘AL (no del IMU).
   * Un escalÃ³n brusco del DC del rojo crudo entre frames = el dedo se moviÃ³/
   * deslizÃ³ sobre el lente. El pulso es lento (<1% del DC por frame), asÃ­ que un
   * salto grande del DC delata movimiento. EMA lenta â†’ solo el movimiento
   * sostenido eleva el score; un Ãºnico frame no alcanza el umbral de supresiÃ³n.
   */
  private updateSignalMotion(rawRed: number, centroidMotion = 0): void {
    if (this.lastRawRedForMotion === 0) {
      this.lastRawRedForMotion = rawRed;
      return;
    }
    const Q = VITAL_THRESHOLDS.QUALITY;
    const dcRef = this.redDC > 1 ? this.redDC : rawRed;
    const jumpFrac = Math.abs(rawRed - this.lastRawRedForMotion) / Math.max(1, dcRef);
    this.lastRawRedForMotion = rawRed;
    const inst = clamp((jumpFrac - Q.MOTION_DC_JUMP_DEADZONE) / Q.MOTION_DC_JUMP_SCALE, 0, 1);
    const combinedInst = Math.max(inst, centroidMotion);
    this.signalMotionScore =
      this.signalMotionScore * (1 - Q.MOTION_SIGNAL_EMA_ALPHA) + combinedInst * Q.MOTION_SIGNAL_EMA_ALPHA;
  }

  private handleMotionEvent = (event: DeviceMotionEvent) => {
    const acc = event.accelerationIncludingGravity;
    if (!acc || acc.x === null || acc.y === null || acc.z === null) return;

    const dx = (acc.x ?? 0) - this.lastAcceleration.x;
    const dy = (acc.y ?? 0) - this.lastAcceleration.y;
    const dz = (acc.z ?? 0) - this.lastAcceleration.z;

    const ax = acc.x ?? 0;
    const ay = acc.y ?? 0;
    const az = acc.z ?? 0;
    this.lastAcceleration = { x: ax, y: ay, z: az };

    // --- Captura de respiraciÃ³n por acelerÃ³metro (modalidad ACC) ---
    // Gravedad â‰ˆ EMA lento (corte muy por debajo de la banda respiratoria).
    if (!this.gravityEmaInit) {
      this.gravityEma = { x: ax, y: ay, z: az };
      this.gravityEmaInit = true;
    } else {
      const gA = 0.02;
      this.gravityEma.x += gA * (ax - this.gravityEma.x);
      this.gravityEma.y += gA * (ay - this.gravityEma.y);
      this.gravityEma.z += gA * (az - this.gravityEma.z);
    }
    const gMag = Math.hypot(this.gravityEma.x, this.gravityEma.y, this.gravityEma.z) || 1;
    // ProyecciÃ³n del vector AC (accel âˆ’ gravedad) sobre la direcciÃ³n de gravedad:
    // la aceleraciÃ³n "vertical" cuya oscilaciÃ³n lenta porta la respiraciÃ³n.
    const vertAccel =
      ((ax - this.gravityEma.x) * this.gravityEma.x +
        (ay - this.gravityEma.y) * this.gravityEma.y +
        (az - this.gravityEma.z) * this.gravityEma.z) /
      gMag;
    const nowMotion = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (nowMotion - this.lastAccelRespPushMs >= 1000 / this.ACCEL_RESP_HZ) {
      this.lastAccelRespPushMs = nowMotion;
      this.accelRespRing.push(vertAccel);
    }

    const accelRMS = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const rot = event.rotationRate;
    let gyroRMS = 0;

    if (rot && rot.alpha !== null && rot.beta !== null && rot.gamma !== null) {
      gyroRMS = Math.sqrt((rot.alpha ?? 0) ** 2 + (rot.beta ?? 0) ** 2 + (rot.gamma ?? 0) ** 2) / 120;
    }

    const rawScore = accelRMS * 0.5 + gyroRMS * 0.3;
    this.motionScore = this.motionScore * 0.85 + rawScore * 0.15;
  };

  /**
   * Recalcula (cada ~1 s) la estimaciÃ³n de FR del acelerÃ³metro por periodograma
   * sobre el buffer respiratorio. Cachea {rpm, quality} o null si no hay seÃ±al
   * periÃ³dica clara. La Smart Fusion (en VitalSignsProcessor) decide si fusiona.
   */
  private updateAccelRespEstimate(nowMs: number): void {
    if (nowMs - this.lastAccelRespComputeMs < 1000) return;
    this.lastAccelRespComputeMs = nowMs;
    if (this.accelRespRing.length < this.ACCEL_RESP_HZ * 8) {
      this.accelRespEstimate = null;
      return;
    }
    const series = this.accelRespRing.tail(this.accelRespRing.length);
    const { freqHz, quality } = bandLimitedDominantFreq(
      series,
      this.ACCEL_RESP_HZ,
      RESPIRATION_DEFAULTS.minRpm / 60,
      RESPIRATION_DEFAULTS.maxRpm / 60,
    );
    const rpm = freqHz * 60;
    this.accelRespEstimate =
      quality >= RESP_SMART_FUSION.MIN_MODALITY_QUALITY &&
      rpm >= RESPIRATION_DEFAULTS.minRpm &&
      rpm <= RESPIRATION_DEFAULTS.maxRpm
        ? { rpm, quality }
        : null;
  }

  private startMotionListener(): void {
    if (this.motionListenerActive) return;
    // No-op in Web Worker: motion arrives via postMessage
    if (typeof window === 'undefined') return;
    try {
      if (typeof DeviceMotionEvent !== 'undefined') {
        const dme = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
        if (typeof dme.requestPermission === 'function') {
          dme.requestPermission()
            .then((state: string) => {
              if (state === 'granted') {
                window.addEventListener('devicemotion', this.handleMotionEvent, { passive: true });
                this.motionListenerActive = true;
              }
            })
            .catch(() => { log.warn('DeviceMotion permission denied'); });
        } else {
          window.addEventListener('devicemotion', this.handleMotionEvent, { passive: true });
          this.motionListenerActive = true;
        }
      }
    } catch { log.debug('DeviceMotion not supported on this device'); }
  }

  private stopMotionListener(): void {
    if (!this.motionListenerActive) return;
    if (typeof window === 'undefined') return;
    window.removeEventListener('devicemotion', this.handleMotionEvent);
    this.motionListenerActive = false;
    this.motionScore = 0;
    this.accelRespRing.reset();
    this.gravityEmaInit = false;
    this.accelRespEstimate = null;
  }

  // clamp() importado desde utils/math.ts

  /**
   * Backpressure: si el fps real cae por debajo de 20 durante > 3s, sube el
   * stride espacial a 4 (â‰ˆ1.78Ã— mÃ¡s rÃ¡pido el bucle de pÃ­xeles). Cuando el fps
   * vuelve a >= 25 sostenido > 3s, restaura stride 3. No toca el resto del
   * pipeline ni la frecuencia temporal de muestreo.
   */
  private maybeAdaptBackpressure(nowMs: number): void {
    if (nowMs - this.lastBackpressureCheck < this.BACKPRESSURE_CHECK_MS) return;
    this.lastBackpressureCheck = nowMs;
    const cfg = this.backpressureConfig;

    // Stride forzado (modo manual / test) â€” bypass total.
    if (typeof cfg.forceStride === 'number') {
      if (this.pixelStride !== cfg.forceStride) {
        this.pixelStride = cfg.forceStride;
        log.info(`Backpressure FORCED stride=${this.pixelStride}`);
      }
      this.lowFpsSinceMs = 0; this.highFpsSinceMs = 0;
      return;
    }

    // AdaptaciÃ³n deshabilitada â†’ vuelve a baseline (3) y no toca mÃ¡s.
    if (!cfg.enabled) {
      if (this.pixelStride !== 3) {
        this.pixelStride = 3;
        log.info('Backpressure DISABLED â€” stride reset to 3');
      }
      this.lowFpsSinceMs = 0; this.highFpsSinceMs = 0;
      return;
    }

    const fps = ppgPerf.snapshot().fps;
    if (fps <= 0) return;

    if (fps < cfg.lowFpsThreshold) {
      this.highFpsSinceMs = 0;
      if (this.lowFpsSinceMs === 0) this.lowFpsSinceMs = nowMs;
      else if (this.pixelStride < cfg.maxStride && nowMs - this.lowFpsSinceMs >= cfg.sustainMs) {
        this.pixelStride = Math.min(cfg.maxStride, this.pixelStride + 1);
        log.warn(`Backpressure ON â€” fps=${fps.toFixed(1)} stride=${this.pixelStride}`);
      }
    } else if (fps >= cfg.highFpsThreshold) {
      this.lowFpsSinceMs = 0;
      if (this.highFpsSinceMs === 0) this.highFpsSinceMs = nowMs;
      else if (this.pixelStride > 3 && nowMs - this.highFpsSinceMs >= cfg.sustainMs) {
        this.pixelStride = Math.max(3, this.pixelStride - 1);
        log.info(`Backpressure OFF â€” fps=${fps.toFixed(1)} stride=${this.pixelStride}`);
      }
    } else {
      this.lowFpsSinceMs = 0;
      this.highFpsSinceMs = 0;
    }
  }

  getRGBStats() {
    return {
      redAC: this.redAC, redDC: this.redDC,
      greenAC: this.greenAC, greenDC: this.greenDC,
      blueAC: this.blueAC, blueDC: this.blueDC,
      rgRatio: this.greenDC > 0 ? this.redDC / this.greenDC : 0,
      ratioOfRatios: this.greenDC > 0 && this.greenAC > 0 && this.redDC > 0
        ? (this.redAC / this.redDC) / (this.greenAC / this.greenDC)
        : 0,
    };
  }

  /** Estado actual del backpressure adaptativo (para telemetrÃ­a). */
  getBackpressureState() {
    return {
      pixelStride: this.pixelStride,
      estimatedSampleRate: this.estimatedSampleRate,
      activeSource: this.activeSource,
      config: { ...this.backpressureConfig },
    };
  }

  /** Aplica una nueva configuraciÃ³n de backpressure (saneada). */
  setBackpressureConfig(partial: Partial<BackpressureConfig>): BackpressureConfig {
    this.backpressureConfig = sanitizeBackpressureConfig({ ...this.backpressureConfig, ...partial });
    // Forzar re-evaluaciÃ³n inmediata
    this.lastBackpressureCheck = 0;
    this.maybeAdaptBackpressure(typeof performance !== 'undefined' ? performance.now() : Date.now());
    return { ...this.backpressureConfig };
  }

  getBackpressureConfig(): BackpressureConfig {
    return { ...this.backpressureConfig };
  }
}
