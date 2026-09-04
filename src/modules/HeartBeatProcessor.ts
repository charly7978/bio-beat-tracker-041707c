/**
 * HEARTBEAT PROCESSOR — detección Elgendi optimizada.
 * BPM y hápticos solo desde picos emitidos.
 */
import { clamp } from '../utils/math';
import { triggerHeartbeatHaptic } from '../utils/haptics';
import { robustBounds } from '../utils/stats';
import { PEAK_DETECTION_DEFAULTS, DSP_CONSTANTS } from '../config/signalProcessing';
import { VITAL_THRESHOLDS } from '../config/vitalThresholds';
import { PeakDetectionEnsemble } from './signal-processing/detectors/PeakDetectionEnsemble';
import { autocorrDominantLag } from './signal-processing/shared/dsp';
import { computeRrHrv } from '../utils/physio';
import {
  inferCameraRuntimeHints,
  type CameraRuntimeHints,
} from '../lib/device/cameraDeviceProfile';
import { bpmFromEmittedRr, decidePeakEmit } from '../lib/measurement/peakEmitPolicy';
import type { FingerPlacementMode } from '../types/signal';

export interface HeartBeatProcessDiagnostics {
  ensemble?: Record<string, unknown>;
  lastPeakTime?: number;
  consensusReason?: string;
}

/**
 * Circular typed buffer O(1) push / O(1) access — reemplaza Array con shift O(n).
 * Pre-aloca la capacidad y nunca genera asignaciones GC en el hot-path.
 */
class CircularFloat64 {
  private readonly data: Float64Array;
  private readonly cap: number;
  private head = 0;
  private len = 0;

  constructor(capacity: number) {
    this.cap = capacity;
    this.data = new Float64Array(capacity);
  }

  get length(): number { return this.len; }

  push(value: number): void {
    this.data[(this.head + this.len) % this.cap] = value;
    if (this.len < this.cap) {
      this.len++;
    } else {
      this.head = (this.head + 1) % this.cap;
    }
  }

  /** Acceso indexado (0 = más antiguo, length-1 = más reciente). */
  at(index: number): number {
    return this.data[(this.head + index) % this.cap];
  }

  /** Copia las últimas `count` muestras a un array destino (sin crear array nuevo). */
  copyTailTo(dest: number[] | Float64Array, count: number): number {
    const n = Math.min(count, this.len);
    const start = this.len - n;
    for (let i = 0; i < n; i++) {
      dest[i] = this.at(start + i);
    }
    return n;
  }

  /** Devuelve las últimas `count` muestras como un array nativo (solo para APIs que lo requieren). */
  tail(count: number): number[] {
    const n = Math.min(count, this.len);
    const result: number[] = new Array(n);
    const start = this.len - n;
    for (let i = 0; i < n; i++) result[i] = this.at(start + i);
    return result;
  }

  clear(): void {
    this.head = 0;
    this.len = 0;
  }
}

// Buffers de trabajo estáticos para evitar allocations en el hot path
const GATE_WORK_BUF = new Float64Array(64);
const MEDIAN_WORK_BUF = new Float64Array(64);
const SR_INTERVALS_BUF = new Float64Array(64);

export class HeartBeatProcessor {
  private readonly MIN_PEAK_INTERVAL_MS = VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS;
  private readonly MAX_PEAK_INTERVAL_MS = VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS;

  private signalBuffer = new CircularFloat64(DSP_CONSTANTS.BUFFER_SIZE);
  private timestampBuffer = new CircularFloat64(DSP_CONSTANTS.BUFFER_SIZE);

  private lastPeakTime = 0;
  private rrIntervals: number[] = [];
  private smoothBPM = 0;

  private audioContext: AudioContext | null = null;
  private audioUnlocked = false;
  private lastBeepTime = 0;

  private consecutivePeaks = 0;
  /** Picos emitidos (independiente de si el BPM aceptó el outlier). */
  private emittedPeakCount = 0;
  private signalQualityIndex = 0;
  private gateRelaxUntilMs = 0;
  private reacquireModeUntilMs = 0;

  private frameTick = 0;
  private cachedGateRange = 0;
  private cachedSampleRate: number = DSP_CONSTANTS.DEFAULT_SAMPLE_RATE;
  private cachedPeriodicity: { bpm: number; score: number } = { bpm: 0, score: 0 };

  private lastDiagnostics: HeartBeatProcessDiagnostics = {};
  private lastEmittedPeakTime = 0;
  /** Mantener BPM publicado entre latidos (~3 s a 45 BPM). */
  private readonly BPM_PUBLISH_HOLD_MS = 4200;
  private readonly GATE_RANGE_MIN = 0.022;
  private cameraHints: CameraRuntimeHints = inferCameraRuntimeHints();
  private placementMode: FingerPlacementMode = 'hybrid';
  private fingerContactConfirmed = false;
  /** SQI del pipeline PPG (SignalQualityIndex canónico) — ruta externa */
  private ppgSqi = 0;
  private ppgPerfusionIndex = 0;
  /** Movimiento IMU (EMA) del pipeline — suprime emisión de latidos durante movimiento. */
  private ppgMotionScore = 0;
  /** SQI auto-calculado por {@link calculateSQI} (ruta interna) */
  private internalSqi = 0;

  private unlockHandler = async () => {
    if (this.audioUnlocked) return;
    try {
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioContext = new AudioContextClass();
      await this.audioContext.resume();
      this.audioUnlocked = true;
      this.removeAudioUnlockListeners();
    } catch {
      /* AudioContext unlock may fail in non-interactive contexts */
    }
  };

  private removeAudioUnlockListeners() {
    if (typeof document !== 'undefined') {
      document.removeEventListener('touchstart', this.unlockHandler);
      document.removeEventListener('click', this.unlockHandler);
    }
  }

  constructor() {
    this.setupAudio();
  }

  private setupAudio() {
    if (typeof document === 'undefined') return;
    document.addEventListener('touchstart', this.unlockHandler, { passive: true });
    document.addEventListener('click', this.unlockHandler, { passive: true });
  }

  getDiagnostics(): HeartBeatProcessDiagnostics & { internalSqi: number; externalSqi: number } {
    return { ...this.lastDiagnostics, internalSqi: this.internalSqi, externalSqi: this.ppgSqi };
  }

  setRuntimeHints(hints: CameraRuntimeHints): void {
    this.cameraHints = hints;
  }

  setFingerPlacementMode(mode: FingerPlacementMode): void {
    this.placementMode = mode;
  }

  setFingerContactConfirmed(confirmed: boolean): void {
    this.fingerContactConfirmed = confirmed;
  }

  /** Alinea ensemble/detectores con el SQI central del PPG (evita doble escala). */
  setPpgQualityMetrics(sqi: number, perfusionIndex?: number, motionScore?: number): void {
    if (Number.isFinite(sqi) && sqi >= 0) this.ppgSqi = sqi;
    if (
      typeof perfusionIndex === 'number' &&
      Number.isFinite(perfusionIndex) &&
      perfusionIndex >= 0
    ) {
      this.ppgPerfusionIndex = perfusionIndex;
    }
    if (typeof motionScore === 'number' && Number.isFinite(motionScore) && motionScore >= 0) {
      this.ppgMotionScore = motionScore;
    }
  }

  /** Fusiona SQI interno (auto-calculado) con SQI externo (canónico del pipeline PPG).
   *  {@link internalSqi} refleja la consistencia local del pico.
   *  {@link ppgSqi} refleja la calidad global del PPG (PI, SNR, periodicidad).
   *  La fusión da mayor peso al canónico cuando es fiable, pero no anula al interno. */
  private ensembleInputSqi(localSqi: number): number {
    this.internalSqi = localSqi;
    if (this.ppgSqi < 3) return localSqi;
    const blended = this.ppgSqi * 0.65 + localSqi * 0.35;
    return clamp(Math.max(localSqi, blended), 0, 100);
  }

  /**
   * Beat-window (W2 de Elgendi) adaptado al ritmo YA detectado: a baja HR se
   * ensancha para que el umbral se asiente bajo el pico sistólico lento/ancho.
   * Usa la mediana RR emitida; sin ritmo aún (<3 RR) devuelve el default → a HR
   * alta queda en 667 ms (no cambia lo que ya anda bien).
   */
  private adaptiveBeatWindowMs(): number {
    const rr = this.rrIntervals;
    let medRr = 0;
    if (rr.length >= 3) {
      // Mediana in-place en buffer estático (sin crear array nuevo con spread+sort)
      const n = Math.min(rr.length, MEDIAN_WORK_BUF.length);
      for (let i = 0; i < n; i++) MEDIAN_WORK_BUF[i] = rr[rr.length - n + i];
      MEDIAN_WORK_BUF.subarray(0, n).sort();
      medRr = MEDIAN_WORK_BUF[Math.floor(n / 2)] ?? 0;
    } else if (this.cachedPeriodicity.bpm > 0 && this.cachedPeriodicity.score >= 0.3) {
      // Aún sin RR emitidos: usa la estimación espectral (autocorr) para que la
      // ventana se ensanche desde el ARRANQUE a baja frecuencia (no solo al sostener).
      medRr = 60000 / this.cachedPeriodicity.bpm;
    }
    if (medRr <= 0) return PEAK_DETECTION_DEFAULTS.beatWindowMs;
    return clamp(
      medRr * PEAK_DETECTION_DEFAULTS.beatWindowRrFactor,
      PEAK_DETECTION_DEFAULTS.beatWindowMs,
      PEAK_DETECTION_DEFAULTS.beatWindowMsMax,
    );
  }

  private gateRangeMin(): number {
    const base = this.GATE_RANGE_MIN * this.cameraHints.gateRangeScale;
    if (this.placementMode === 'pad') return base * 0.9;
    return base;
  }

  private minNormalizeRange(): number {
    const base = PEAK_DETECTION_DEFAULTS.HEARTBEAT_NORM_MIN_RANGE;
    return this.cameraHints.constrained ? base * 2.2 : base;
  }

  processSignal(filteredValue: number, timestamp?: number): {
    bpm: number;
    confidence: number;
    isPeak: boolean;
    filteredValue: number;
    sqi: number;
    internalSqi: number;
    externalSqi: number;
    consensusReason?: string;
    rrData?: {
      intervals: number[];
      lastPeakTime: number;
    };
    ensembleDiagnostics?: Record<string, unknown>;
  } {
    const now = timestamp ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());

    if (Math.abs(filteredValue) > 1e-6) {
      // CircularFloat64: push O(1), sin shift, sin GC
      this.signalBuffer.push(filteredValue);
      this.timestampBuffer.push(now);
    } else if (
      this.fingerContactConfirmed &&
      this.signalBuffer.length > 0
    ) {
      const hold = this.signalBuffer.at(this.signalBuffer.length - 1) * 0.999;
      this.signalBuffer.push(hold);
      this.timestampBuffer.push(now);
    }

    if (this.signalBuffer.length < 20) {
      return { bpm: 0, confidence: 0, isPeak: false, filteredValue: 0, sqi: 0, internalSqi: 0, externalSqi: 0, ensembleDiagnostics: {} };
    }

    this.frameTick++;

    if (this.frameTick % 4 === 0 || this.cachedGateRange === 0) {
      // Gate range con buffer estático (sin slice + spread + sort)
      const gn = this.signalBuffer.copyTailTo(GATE_WORK_BUF, 60);
      if (gn > 0) {
        GATE_WORK_BUF.subarray(0, gn).sort();
        this.cachedGateRange =
          (GATE_WORK_BUF[Math.floor(gn * 0.9)] ?? 0) -
          (GATE_WORK_BUF[Math.floor(gn * 0.1)] ?? 0);
      }
    }

    const windowLen = this.consecutivePeaks < 3 ? 90 : 150;
    const { normalizedValue, range } = this.normalizeSignal(filteredValue, windowLen);

    if (this.frameTick % 6 === 0) {
      this.cachedPeriodicity = this.estimatePeriodicity();
    }
    this.internalSqi = this.calculateSQI(range, this.cachedPeriodicity.score);
    this.signalQualityIndex = this.internalSqi;

    let isPeak = false;
    let emitReason = 'WAITING';
    const sampleRate = this.estimateSampleRate();
    let ensembleConf = 0;

    const peakStallMs =
      this.lastEmittedPeakTime > 0 ? now - this.lastEmittedPeakTime : 0;
    const autoGateRelax =
      this.fingerContactConfirmed && peakStallMs > 1600
        ? clamp(1 - (peakStallMs - 1600) / 7000, 0.45, 1)
        : 1;
    const manualRelax = now < this.gateRelaxUntilMs ? 0.5 : 1;
    const gateScale =
      Math.min(autoGateRelax, manualRelax) *
      (this.ppgPerfusionIndex > 0 && this.ppgPerfusionIndex < 0.004 ? 0.68 : 1);
    const gateOk =
      this.cachedGateRange >= this.gateRangeMin() * gateScale;
    const runEnsemble =
      this.signalBuffer.length >= PEAK_DETECTION_DEFAULTS.minSamplesEnsemble &&
      (gateOk || this.fingerContactConfirmed);

    if (runEnsemble) {
      const win = Math.min(DSP_CONSTANTS.BUFFER_SIZE, this.signalBuffer.length);
      // Extraer arrays nativos para el ensemble (requiere number[] por la API de PeakDetectionEnsemble)
      const sigRaw = this.signalBuffer.tail(win);
      const ts = this.timestampBuffer.tail(win);
      const sig = this.normalizeWindow(sigRaw, Math.min(150, sigRaw.length));
      const ensSqi = this.ensembleInputSqi(this.signalQualityIndex);
      const ens = PeakDetectionEnsemble.analyze({
        signal: sig,
        timestampsMs: ts,
        samplingRateHz: sampleRate,
        sqi: ensSqi,
        perfusionIndex: this.ppgPerfusionIndex,
        beatWindowMs: this.adaptiveBeatWindowMs(),
      });
      ensembleConf = ens.confidence;

      const minPeakConf =
        VITAL_THRESHOLDS.QUALITY.MIN_ENSEMBLE_CONF_FOR_PEAK *
        (this.cameraHints.constrained ? 0.42 : 0.52);

      const decision = decidePeakEmit({
        ens,
        lastEmittedPeakMs: this.lastEmittedPeakTime,
        minPeakConf,
        sampleRateHz: sampleRate,
        windowSamples: win,
        fingerContactConfirmed: this.fingerContactConfirmed,
        nowMs: now,
        emittedPeakCount: this.emittedPeakCount,
        peakStallMs,
        reacquireMode: now < this.reacquireModeUntilMs || peakStallMs >= 1800,
        recentRrMs: this.rrIntervals,
        sqi: ensSqi,
        perfusionIndex: this.ppgPerfusionIndex,
      });

      // Gate de movimiento: durante movimiento claro (IMU) la señal está
      // corrupta → no emitir latidos (evita latidos erráticos por micro-movimiento).
      const motionSuppressed =
        this.ppgMotionScore > PEAK_DETECTION_DEFAULTS.peakEmitMotionSuppress;

      if (decision.emit && motionSuppressed) {
        emitReason = 'MOTION_SUPPRESSED';
      } else if (decision.emit) {
        isPeak = true;
        emitReason = decision.reason;
        const wScore = decision.weightedScore ?? 0;
        const prevEmitted = this.lastEmittedPeakTime;
        this.lastEmittedPeakTime = decision.peakTimeMs;
        this.lastPeakTime = decision.peakTimeMs;
        this.emittedPeakCount += 1;
        this.reacquireModeUntilMs = 0;
        this.gateRelaxUntilMs = 0;

        if (prevEmitted > 0) {
          const rrMs = decision.peakTimeMs - prevEmitted;
          if (rrMs >= this.MIN_PEAK_INTERVAL_MS && rrMs <= this.MAX_PEAK_INTERVAL_MS) {
            this.rrIntervals.push(rrMs);
            // Truncar sin crear array nuevo: splice in-place desde el inicio
            if (this.rrIntervals.length > DSP_CONSTANTS.MAX_RR_INTERVALS) {
              this.rrIntervals.splice(0, this.rrIntervals.length - DSP_CONSTANTS.MAX_RR_INTERVALS);
            }
          }
        }

        const instantBpm = bpmFromEmittedRr(this.rrIntervals);
        this.consecutivePeaks += 1;

        if (instantBpm > 0) {
          const acceptOutlier =
            this.smoothBPM <= 0 ||
            Math.abs(instantBpm - this.smoothBPM) / Math.max(1, this.smoothBPM) <= 0.4;
          if (acceptOutlier) {
            if (this.smoothBPM === 0) {
              this.smoothBPM = instantBpm;
            } else {
              const rel = Math.abs(instantBpm - this.smoothBPM) / Math.max(1, this.smoothBPM);
              const trust = clamp(0.18 + wScore * 0.32, 0.18, 0.50);
              // A menor desviación, más suavizado (alpha bajo)
              // A mayor desviación, más seguimiento (alpha alto)
              const alpha = rel > 0.22 ? trust : rel > 0.12 ? trust * 0.75 : trust * 0.45;
              this.smoothBPM = this.smoothBPM * (1 - alpha) + instantBpm * alpha;
            }
          }
        }

        if (wScore >= 0.4 && this.rrIntervals.length >= 1) {
          this.vibrate();
          this.playBeep();
        }
      }

      this.lastDiagnostics = {
        ensemble: {
          ...ens.diagnostics,
          agreement: ens.agreement,
          confidence: ens.confidence,
          rejectedPeaks: ens.rejectedPeaks,
          fusedPeakCount: ens.peaks.length,
          emitReason,
          weightedScore: decision.weightedScore,
          gateRange: this.cachedGateRange,
        },
        lastPeakTime: this.lastPeakTime,
        consensusReason: emitReason,
      };
    } else {
      this.lastDiagnostics = {
        ensemble: { gateRange: this.cachedGateRange, gateOk },
        consensusReason: gateOk ? 'BUFFERING' : 'LOW_AMPLITUDE',
      };
    }

    const peakAgeMs = this.lastPeakTime > 0 ? now - this.lastPeakTime : Number.POSITIVE_INFINITY;
    if (!isPeak && peakAgeMs > this.BPM_PUBLISH_HOLD_MS) {
      this.consecutivePeaks = 0;
      if (peakAgeMs > this.BPM_PUBLISH_HOLD_MS * 2) {
        this.smoothBPM = 0;
      }
    }

    const rrBpm = bpmFromEmittedRr(this.rrIntervals);
    let publishBpm = 0;
    if (
      this.fingerContactConfirmed &&
      peakAgeMs < this.BPM_PUBLISH_HOLD_MS
    ) {
      if (this.smoothBPM > 0 && rrBpm > 0) {
        const agree = Math.abs(this.smoothBPM - rrBpm) / Math.max(1, rrBpm) < 0.08;
        publishBpm = Math.round(agree ? this.smoothBPM : rrBpm);
      } else if (this.smoothBPM > 0) {
        publishBpm = Math.round(this.smoothBPM);
      } else if (rrBpm > 0) {
        publishBpm = Math.round(rrBpm);
      }
    }

    const confidence = this.calculateConfidence(ensembleConf, isPeak);

    return {
      bpm: publishBpm,
      confidence,
      isPeak,
      filteredValue: normalizedValue,
      sqi: this.signalQualityIndex,
      internalSqi: this.internalSqi,
      externalSqi: this.ppgSqi,
      consensusReason: emitReason,
      rrData: {
        intervals: [...this.rrIntervals],
        lastPeakTime: this.lastPeakTime,
      },
      ensembleDiagnostics: this.lastDiagnostics.ensemble as Record<string, unknown> | undefined,
    };
  }

  // Objeto reutilizable para normalizeSignal (evita crear objeto nuevo cada frame)
  private readonly normResult = { normalizedValue: 0, range: 0 };

  private normalizeSignal(value: number, windowLen: number = 150): { normalizedValue: number; range: number } {
    const recent = this.signalBuffer.tail(windowLen);
    const { low, high, range } = robustBounds(recent);
    const scale = PEAK_DETECTION_DEFAULTS.HEARTBEAT_NORM_SCALE;
    if (range < this.minNormalizeRange()) {
      this.normResult.normalizedValue = value * PEAK_DETECTION_DEFAULTS.HEARTBEAT_NORM_FALLBACK_GAIN;
      this.normResult.range = range;
      return this.normResult;
    }
    const clipped = Math.min(high, Math.max(low, value));
    this.normResult.normalizedValue = ((clipped - low) / range - 0.5) * scale;
    this.normResult.range = range;
    return this.normResult;
  }

  private normalizeWindow(values: number[], windowLen: number = 150): number[] {
    const refWindow = this.signalBuffer.tail(windowLen);
    const { low, high, range } = robustBounds(refWindow);
    const scale = PEAK_DETECTION_DEFAULTS.HEARTBEAT_NORM_SCALE;
    const n = values.length;
    // Normalización in-place para evitar .map() que crea array nuevo
    if (range < this.minNormalizeRange()) {
      const gain = PEAK_DETECTION_DEFAULTS.HEARTBEAT_NORM_FALLBACK_GAIN;
      for (let i = 0; i < n; i++) values[i] = values[i] * gain;
      return values;
    }
    for (let i = 0; i < n; i++) {
      const c = Math.min(high, Math.max(low, values[i]));
      values[i] = ((c - low) / range - 0.5) * scale;
    }
    return values;
  }

  private estimateSampleRate(): number {
    const tsLen = this.timestampBuffer.length;
    if (tsLen < 10) return this.cachedSampleRate || DSP_CONSTANTS.DEFAULT_SAMPLE_RATE;
    if (this.frameTick % 30 !== 0 && this.cachedSampleRate > 0) {
      return this.cachedSampleRate;
    }
    // Calcular intervalos directamente del circular buffer (sin slice ni arrays nuevos)
    const lookback = Math.min(50, tsLen);
    const start = tsLen - lookback;
    let count = 0;
    for (let i = 1; i < lookback; i++) {
      const d = this.timestampBuffer.at(start + i) - this.timestampBuffer.at(start + i - 1);
      if (d >= 10 && d <= 100) SR_INTERVALS_BUF[count++] = d;
    }
    if (count < 6) return this.cachedSampleRate || DSP_CONSTANTS.DEFAULT_SAMPLE_RATE;
    SR_INTERVALS_BUF.subarray(0, count).sort();
    const median = SR_INTERVALS_BUF[Math.floor(count / 2)] ?? 33;
    this.cachedSampleRate = clamp(1000 / median, 20, 40);
    return this.cachedSampleRate;
  }

  // Resultado reutilizable para estimatePeriodicity (evita crear objeto cada 6 frames)
  private readonly periodicityResult = { bpm: 0, score: 0 };

  private estimatePeriodicity(): { bpm: number; score: number } {
    if (this.signalBuffer.length < 60) {
      this.periodicityResult.bpm = 0;
      this.periodicityResult.score = 0;
      return this.periodicityResult;
    }

    const sampleRate = this.estimateSampleRate();
    const windowLen =
      this.consecutivePeaks < 3
        ? PEAK_DETECTION_DEFAULTS.HEARTBEAT_WINDOW_WARMUP
        : PEAK_DETECTION_DEFAULTS.HEARTBEAT_WINDOW_STABLE;
    // tail() crea el array (necesario para normalizeWindow que muta in-place)
    const recentSignal = this.normalizeWindow(this.signalBuffer.tail(windowLen), windowLen);
    // Centrar y calcular energía in-place (sin .map ni .reduce)
    let mean = 0;
    const rLen = recentSignal.length;
    for (let i = 0; i < rLen; i++) mean += recentSignal[i];
    mean /= rLen;
    let energy = 0;
    for (let i = 0; i < rLen; i++) {
      recentSignal[i] -= mean;
      energy += recentSignal[i] * recentSignal[i];
    }

    if (energy < 400) {
      this.periodicityResult.bpm = 0;
      this.periodicityResult.score = 0;
      return this.periodicityResult;
    }

    const minLag = Math.max(5, Math.round((sampleRate * 60) / 200));
    const maxLag = Math.min(rLen - 8, Math.round((sampleRate * 60) / 38));
    // Autocorrelación compartida (dsp.autocorrDominantLag) — sin duplicar el bucle.
    const { lag, score } = autocorrDominantLag(recentSignal, minLag, maxLag);

    if (lag === 0 || score < 0.18) {
      this.periodicityResult.bpm = 0;
      this.periodicityResult.score = Math.max(0, score);
      return this.periodicityResult;
    }
    this.periodicityResult.bpm = (60 * sampleRate) / lag;
    this.periodicityResult.score = clamp(score, 0, 1);
    return this.periodicityResult;
  }

  private calculateSQI(range: number, periodicityScore: number): number {
    if (this.signalBuffer.length < 30) return 0;

    const rangeFactor = Math.min(1, range / 4) * 24;
    const nSig = this.signalBuffer.length;
    let meanAbsDeriv = 0;
    let derivCount = 0;
    const derivStart = Math.max(0, nSig - 61);
    for (let i = derivStart + 1; i < nSig; i++) {
      meanAbsDeriv += Math.abs(this.signalBuffer.at(i) - this.signalBuffer.at(i - 1));
      derivCount++;
    }
    if (derivCount > 0) meanAbsDeriv /= derivCount;
    const slopeFactor = Math.min(1, meanAbsDeriv / 0.8) * 14;

    let rrFactor = 0;
    if (this.rrIntervals.length >= 3) {
      const cv = computeRrHrv(this.rrIntervals).cv;
      rrFactor = Math.max(0, 1 - cv * 2) * 24;
    }

    const peakFactor = Math.min(1, this.consecutivePeaks / 4) * 22;
    const periodicityFactor = periodicityScore * 16;

    let sqi = clamp(rangeFactor + slopeFactor + rrFactor + peakFactor + periodicityFactor, 0, 100);
    const agree = (this.lastDiagnostics.ensemble?.agreement as { elgendi?: number } | undefined)?.elgendi;
    if (typeof agree === 'number' && agree > 0) {
      sqi = clamp(sqi + agree * 10, 0, 100);
    }
    return sqi;
  }

  private calculateConfidence(ensembleConf: number, isPeak: boolean): number {
    const effectiveSqi = this.signalQualityIndex;
    const sqiFactor = effectiveSqi / 100;
    const peakSupport = Math.min(1, this.consecutivePeaks / 5);
    const ens = clamp(ensembleConf, 0, 1);
    const peakBoost = isPeak ? 0.12 : 0;

    if (this.rrIntervals.length < 2) {
      return clamp(sqiFactor * 0.22 + peakSupport * 0.22 + ens * 0.36 + peakBoost, 0, 0.85);
    }

    // Media y varianza con for-loop (sin .reduce que crea closures por llamada)
    const rr = this.rrIntervals;
    const rrLen = rr.length;
    let rrSum = 0;
    for (let i = 0; i < rrLen; i++) rrSum += rr[i];
    const mean = rrSum / rrLen;
    let varAcc = 0;
    for (let i = 0; i < rrLen; i++) { const d = rr[i] - mean; varAcc += d * d; }
    const cv = Math.sqrt(varAcc / rrLen) / Math.max(1, mean);
    const rrStability = clamp(1 - cv * 1.5, 0, 1);

    return clamp(
      rrStability * 0.32 + peakSupport * 0.22 + sqiFactor * 0.2 + ens * 0.16 + peakBoost,
      0,
      1,
    );
  }

  private vibrate(): void {
    triggerHeartbeatHaptic().catch(() => undefined);
  }

  private async playBeep(): Promise<void> {
    if (!this.audioContext || !this.audioUnlocked) return;
    const t0 = Date.now();
    if (t0 - this.lastBeepTime < 280) return;
    try {
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();
      const t = this.audioContext.currentTime;
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      osc.frequency.setValueAtTime(820, t);
      osc.frequency.exponentialRampToValueAtTime(460, t + 0.08);
      gain.gain.setValueAtTime(0.14, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      osc.connect(gain);
      gain.connect(this.audioContext.destination);
      osc.start(t);
      osc.stop(t + 0.12);
      this.lastBeepTime = t0;
    } catch {
      /* Audio beep may fail if AudioContext is in a closed state */
    }
  }

  getRRIntervals(): number[] { return [...this.rrIntervals]; }
  getLastPeakTime(): number { return this.lastPeakTime; }

  /**
   * Reabre detección sin vaciar buffers (dedo quieto que dejó de latir).
   */
  softReacquirePeaks(nowMs?: number): void {
    const t = nowMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.gateRelaxUntilMs = t + 6500;
    this.reacquireModeUntilMs = t + 6500;
    this.consecutivePeaks = 0;
  }

  /** Limpia estado de picos/RR al quitar el dedo o al volver a colocarlo. */
  resetPeakTracking(): void {
    this.signalBuffer.clear();
    this.timestampBuffer.clear();
    this.rrIntervals = [];
    this.smoothBPM = 0;
    this.lastPeakTime = 0;
    this.lastEmittedPeakTime = 0;
    this.consecutivePeaks = 0;
    this.emittedPeakCount = 0;
    this.frameTick = 0;
    this.cachedGateRange = 0;
    this.gateRelaxUntilMs = 0;
    this.reacquireModeUntilMs = 0;
    this.lastDiagnostics = {};
  }

  reset(): void {
    this.resetPeakTracking();
    this.signalQualityIndex = 0;
    this.internalSqi = 0;
    this.cachedSampleRate = DSP_CONSTANTS.DEFAULT_SAMPLE_RATE;
    this.cachedPeriodicity = { bpm: 0, score: 0 };
    this.fingerContactConfirmed = false;
    this.ppgSqi = 0;
    this.ppgPerfusionIndex = 0;
    this.ppgMotionScore = 0;
  }

  dispose(): void {
    this.removeAudioUnlockListeners();
    if (this.audioContext) {
      this.audioContext.close().catch(() => {
        // Ignore audio context close failures
      });
    }
  }
}
