/**
 * HEARTBEAT PROCESSOR — Motor de detección avanzado y optimizado.
 * Implementa buffers circulares tipados, SQI estadístico de alto orden (Skewness),
 * tracking predictivo tipo Kalman y control estricto de períodos refractarios.
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
  internalSqi?: number;
  externalSqi?: number;
}

export class HeartBeatProcessor {
  // Configuración Extensa y Constantes
  private readonly MIN_PEAK_INTERVAL_MS = VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS;
  private readonly MAX_PEAK_INTERVAL_MS = VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS;
  private readonly BPM_PUBLISH_HOLD_MS = 4200;
  private readonly GATE_RANGE_MIN = 0.022;
  private readonly BUFFER_CAPACITY = DSP_CONSTANTS.BUFFER_SIZE; 
  
  // Buffers Circulares Tipados (Optimización de Memoria - Cero GC)
  private signalBuffer = new Float64Array(this.BUFFER_CAPACITY);
  private timestampBuffer = new Float64Array(this.BUFFER_CAPACITY);
  private bufferHead = 0;
  private bufferCount = 0;

  // Seguimiento de Ritmo y Picos
  private lastPeakTime = 0;
  private rrIntervals: number[] = [];
  private smoothBPM = 0;
  private consecutivePeaks = 0;
  private emittedPeakCount = 0;
  private lastEmittedPeakTime = 0;

  // Calidad de Señal y Gate
  private signalQualityIndex = 0; 
  private internalSqi = 0;
  private ppgSqi = 0;
  private ppgPerfusionIndex = 0;
  private ppgMotionScore = 0;
  private gateRelaxUntilMs = 0;
  private reacquireModeUntilMs = 0;
  private cachedGateRange = 0;

  // Sistema de Audio
  private audioContext: AudioContext | null = null;
  private audioUnlocked = false;
  private lastBeepTime = 0;

  // Meta y Estado
  private frameTick = 0;
  private cachedSampleRate: number = DSP_CONSTANTS.DEFAULT_SAMPLE_RATE;
  private cachedPeriodicity: { bpm: number; score: number } = { bpm: 0, score: 0 };
  private lastDiagnostics: HeartBeatProcessDiagnostics = {};
  
  private cameraHints: CameraRuntimeHints = inferCameraRuntimeHints();
  private placementMode: FingerPlacementMode = 'hybrid';
  private fingerContactConfirmed = false;

  private unlockHandler = async () => {
    if (this.audioUnlocked) return;
    try {
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioContext = new AudioContextClass();
      await this.audioContext.resume();
      this.audioUnlocked = true;
      this.removeAudioUnlockListeners();
    } catch {
      /* Silently ignore non-interactive context failures */
    }
  };

  constructor() {
    this.setupAudio();
  }

  private setupAudio() {
    if (typeof document === 'undefined') return;
    document.addEventListener('touchstart', this.unlockHandler, { passive: true });
    document.addEventListener('click', this.unlockHandler, { passive: true });
  }

  private removeAudioUnlockListeners() {
    if (typeof document !== 'undefined') {
      document.removeEventListener('touchstart', this.unlockHandler);
      document.removeEventListener('click', this.unlockHandler);
    }
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

  setPpgQualityMetrics(sqi: number, perfusionIndex?: number, motionScore?: number): void {
    if (Number.isFinite(sqi) && sqi >= 0) this.ppgSqi = sqi;
    if (typeof perfusionIndex === 'number' && Number.isFinite(perfusionIndex) && perfusionIndex >= 0) {
      this.ppgPerfusionIndex = perfusionIndex;
    }
    if (typeof motionScore === 'number' && Number.isFinite(motionScore) && motionScore >= 0) {
      this.ppgMotionScore = motionScore;
    }
  }

  // ---- Utilidades de Buffer Circular ---- //
  private pushSample(value: number, timestamp: number) {
    this.signalBuffer[this.bufferHead] = value;
    this.timestampBuffer[this.bufferHead] = timestamp;
    this.bufferHead = (this.bufferHead + 1) % this.BUFFER_CAPACITY;
    if (this.bufferCount < this.BUFFER_CAPACITY) {
      this.bufferCount++;
    }
  }

  /** Extrae las últimas N muestras cronológicas del buffer circular */
  private getRecentSignal(n: number): Float64Array {
    const count = Math.min(n, this.bufferCount);
    if (count === 0) return new Float64Array(0);
    const result = new Float64Array(count);
    let idx = (this.bufferHead - count + this.BUFFER_CAPACITY) % this.BUFFER_CAPACITY;
    for (let i = 0; i < count; i++) {
      result[i] = this.signalBuffer[idx];
      idx = (idx + 1) % this.BUFFER_CAPACITY;
    }
    return result;
  }

  /** Extrae los últimos N timestamps cronológicos */
  private getRecentTimestamps(n: number): Float64Array {
    const count = Math.min(n, this.bufferCount);
    if (count === 0) return new Float64Array(0);
    const result = new Float64Array(count);
    let idx = (this.bufferHead - count + this.BUFFER_CAPACITY) % this.BUFFER_CAPACITY;
    for (let i = 0; i < count; i++) {
      result[i] = this.timestampBuffer[idx];
      idx = (idx + 1) % this.BUFFER_CAPACITY;
    }
    return result;
  }

  // ---- Procesamiento Core ---- //
  
  processSignal(filteredValue: number, timestamp?: number): {
    bpm: number;
    confidence: number;
    isPeak: boolean;
    filteredValue: number;
    sqi: number;
    internalSqi: number;
    externalSqi: number;
    consensusReason?: string;
    rrData?: { intervals: number[]; lastPeakTime: number };
    ensembleDiagnostics?: Record<string, unknown>;
  } {
    const now = timestamp ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // 1. Inserción Optimizada (Evita latidos retenidos infinitos)
    if (Math.abs(filteredValue) > 1e-6) {
      this.pushSample(filteredValue, now);
    } else if (this.fingerContactConfirmed && this.bufferCount > 0 && this.bufferCount < this.BUFFER_CAPACITY) {
      // Hold zero-drift
      const lastIdx = (this.bufferHead - 1 + this.BUFFER_CAPACITY) % this.BUFFER_CAPACITY;
      const hold = this.signalBuffer[lastIdx] * 0.999;
      this.pushSample(hold, now);
    }

    if (this.bufferCount < 20) {
      return this.emptyResult();
    }

    this.frameTick++;

    // 2. Cálculo de Puerta de Rango (Gate) 
    if (this.frameTick % 4 === 0 || this.cachedGateRange === 0) {
      const recentGate = this.getRecentSignal(60);
      const sorted = Float64Array.from(recentGate).sort();
      this.cachedGateRange = (sorted[Math.floor(sorted.length * 0.9)] ?? 0) - (sorted[Math.floor(sorted.length * 0.1)] ?? 0);
    }

    // 3. Normalización con control de picos
    const windowLen = this.consecutivePeaks < 3 ? 90 : 150;
    const recentNorm = this.getRecentSignal(windowLen);
    const arrNorm = Array.from(recentNorm); 
    const { low, high, range } = robustBounds(arrNorm);
    let normalizedValue = filteredValue;
    
    if (range < this.minNormalizeRange()) {
      normalizedValue = filteredValue * PEAK_DETECTION_DEFAULTS.HEARTBEAT_NORM_FALLBACK_GAIN;
    } else {
      const clipped = Math.min(high, Math.max(low, filteredValue));
      normalizedValue = ((clipped - low) / range - 0.5) * PEAK_DETECTION_DEFAULTS.HEARTBEAT_NORM_SCALE;
    }

    // 4. Actualización de Periodicidad y SQI Estadístico (Skewness/Kurtosis)
    if (this.frameTick % 6 === 0) {
      this.cachedPeriodicity = this.estimatePeriodicity();
    }
    this.internalSqi = this.calculateAdvancedSQI(recentNorm, range, this.cachedPeriodicity.score);
    this.signalQualityIndex = this.internalSqi;

    // 5. Motor de Ensamble y Detección
    let isPeak = false;
    let emitReason = 'WAITING';
    const sampleRate = this.estimateSampleRate();
    let ensembleConf = 0;
    const peakStallMs = this.lastEmittedPeakTime > 0 ? now - this.lastEmittedPeakTime : 0;
    
    // Validar condición de ejecución
    const runEnsemble = this.evaluateEnsembleGate(now, peakStallMs);

    if (runEnsemble) {
      const winCount = Math.min(this.BUFFER_CAPACITY, this.bufferCount);
      const sigRaw = Array.from(this.getRecentSignal(winCount)); // Pasar a nativo solo para el ensemble
      const tsRaw = Array.from(this.getRecentTimestamps(winCount));
      const sig = this.normalizeWindow(sigRaw, Math.min(150, sigRaw.length));
      const ensSqi = this.ensembleInputSqi(this.signalQualityIndex);

      const ens = PeakDetectionEnsemble.analyze({
        signal: sig,
        timestampsMs: tsRaw,
        samplingRateHz: sampleRate,
        sqi: ensSqi,
        perfusionIndex: this.ppgPerfusionIndex,
        beatWindowMs: this.adaptiveBeatWindowMs(),
      });
      ensembleConf = ens.confidence;

      const minPeakConf = VITAL_THRESHOLDS.QUALITY.MIN_ENSEMBLE_CONF_FOR_PEAK * (this.cameraHints.constrained ? 0.42 : 0.52);

      const decision = decidePeakEmit({
        ens,
        lastEmittedPeakMs: this.lastEmittedPeakTime,
        minPeakConf,
        sampleRateHz: sampleRate,
        windowSamples: winCount,
        fingerContactConfirmed: this.fingerContactConfirmed,
        nowMs: now,
        emittedPeakCount: this.emittedPeakCount,
        peakStallMs,
        reacquireMode: now < this.reacquireModeUntilMs || peakStallMs >= 1800,
        recentRrMs: this.rrIntervals,
        sqi: ensSqi,
        perfusionIndex: this.ppgPerfusionIndex,
      });

      const motionSuppressed = this.ppgMotionScore > PEAK_DETECTION_DEFAULTS.peakEmitMotionSuppress;

      // ---- Período Refractario Estricto Dinámico ---- //
      // Bloqueamos la emisión si el tiempo transcurrido es menor a la mitad del RR esperado o absoluto 300ms
      const expectedRR = this.smoothBPM > 0 ? 60000 / this.smoothBPM : 800;
      const refractoryLimit = Math.max(280, expectedRR * 0.4); 
      const inRefractory = decision.emit && (decision.peakTimeMs - this.lastEmittedPeakTime < refractoryLimit) && this.lastEmittedPeakTime > 0;

      if (decision.emit && motionSuppressed) {
        emitReason = 'MOTION_SUPPRESSED';
      } else if (inRefractory) {
        emitReason = 'REFRACTORY_BLOCKED';
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
            if (this.rrIntervals.length > DSP_CONSTANTS.MAX_RR_INTERVALS) {
              this.rrIntervals.shift(); 
            }
          }
        }

        const instantBpm = bpmFromEmittedRr(this.rrIntervals);
        this.consecutivePeaks += 1;

        if (instantBpm > 0) {
          this.updateSmoothBpmPredictive(instantBpm, wScore);
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
      const gateOk = this.cachedGateRange >= this.gateRangeMin();
      this.lastDiagnostics = {
        ensemble: { gateRange: this.cachedGateRange, gateOk },
        consensusReason: gateOk ? 'BUFFERING' : 'LOW_AMPLITUDE',
      };
    }

    // 6. Finalización y Timeout
    const peakAgeMs = this.lastPeakTime > 0 ? now - this.lastPeakTime : Number.POSITIVE_INFINITY;
    if (!isPeak && peakAgeMs > this.BPM_PUBLISH_HOLD_MS) {
      this.consecutivePeaks = 0;
      if (peakAgeMs > this.BPM_PUBLISH_HOLD_MS * 2) {
        this.smoothBPM = 0;
      }
    }

    const publishBpm = this.resolvePublishBpm(peakAgeMs);
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

  // ---- Módulo SQI Estadístico (Asimetría / Curtosis) ---- //
  private calculateAdvancedSQI(data: Float64Array, range: number, periodicityScore: number): number {
    const n = data.length;
    if (n < 30) return 0;

    let sum = 0;
    for (let i = 0; i < n; i++) sum += data[i];
    const mean = sum / n;
    
    let sumDiff2 = 0;
    let sumDiff3 = 0;
    for (let i = 0; i < n; i++) {
      const diff = data[i] - mean;
      sumDiff2 += diff * diff;
      sumDiff3 += diff * diff * diff;
    }
    
    const variance = sumDiff2 / n;
    const std = Math.sqrt(variance);
    const skewness = (variance > 1e-9) ? (sumDiff3 / n) / (std * std * std) : 0;
    
    // Skewness positivo y fuerte (ej > 0.4) o negativo fuerte, típicamente indica morfología no gaussiana pura (un pulso)
    const skewQuality = clamp(Math.abs(skewness) * 25, 0, 30);
    
    const rangeFactor = Math.min(1, range / 4) * 20;
    let rrFactor = 0;
    if (this.rrIntervals.length >= 3) {
      const cv = computeRrHrv(this.rrIntervals).cv;
      rrFactor = Math.max(0, 1 - cv * 2) * 20;
    }
    const peakFactor = Math.min(1, this.consecutivePeaks / 4) * 15;
    const periodicityFactor = periodicityScore * 15;

    let sqi = clamp(skewQuality + rangeFactor + rrFactor + peakFactor + periodicityFactor, 0, 100);
    
    const agree = (this.lastDiagnostics.ensemble?.agreement as { elgendi?: number } | undefined)?.elgendi;
    if (typeof agree === 'number' && agree > 0) {
      sqi = clamp(sqi + agree * 10, 0, 100);
    }
    return sqi;
  }

  // ---- Filtro Predictivo Tipo Kalman para Suavizado ---- //
  private updateSmoothBpmPredictive(instantBpm: number, wScore: number): void {
    if (this.smoothBPM === 0) {
      this.smoothBPM = instantBpm;
      return;
    }
    
    const error = Math.abs(instantBpm - this.smoothBPM);
    const relativeError = error / Math.max(1, this.smoothBPM);
    const acceptOutlier = relativeError <= 0.4;
    
    if (acceptOutlier) {
      // Dinámica del filtro de seguimiento
      const trust = clamp(0.18 + wScore * 0.32, 0.18, 0.50);
      let alpha = trust;
      if (relativeError > 0.22) {
        alpha = trust; // Mayor corrección si el error es significativo pero válido
      } else if (relativeError > 0.12) {
        alpha = trust * 0.75;
      } else {
        alpha = trust * 0.45; // Suavizado fuerte si ya está cerca (seguimiento fino)
      }
      this.smoothBPM = this.smoothBPM * (1 - alpha) + instantBpm * alpha;
    }
  }

  // ---- Cálculos Auxiliares y Lógica Interna ---- //
  private emptyResult() {
    return { bpm: 0, confidence: 0, isPeak: false, filteredValue: 0, sqi: 0, internalSqi: 0, externalSqi: 0 };
  }

  private gateRangeMin(): number {
    const base = this.GATE_RANGE_MIN * this.cameraHints.gateRangeScale;
    return this.placementMode === 'pad' ? base * 0.9 : base;
  }

  private minNormalizeRange(): number {
    const base = PEAK_DETECTION_DEFAULTS.HEARTBEAT_NORM_MIN_RANGE;
    return this.cameraHints.constrained ? base * 2.2 : base;
  }

  private evaluateEnsembleGate(now: number, peakStallMs: number): boolean {
    const autoGateRelax = this.fingerContactConfirmed && peakStallMs > 1600
        ? clamp(1 - (peakStallMs - 1600) / 7000, 0.45, 1) : 1;
    const manualRelax = now < this.gateRelaxUntilMs ? 0.5 : 1;
    const gateScale = Math.min(autoGateRelax, manualRelax) * (this.ppgPerfusionIndex > 0 && this.ppgPerfusionIndex < 0.004 ? 0.68 : 1);
    const gateOk = this.cachedGateRange >= this.gateRangeMin() * gateScale;
    
    return this.bufferCount >= PEAK_DETECTION_DEFAULTS.minSamplesEnsemble && (gateOk || this.fingerContactConfirmed);
  }

  private ensembleInputSqi(localSqi: number): number {
    this.internalSqi = localSqi;
    if (this.ppgSqi < 3) return localSqi;
    const blended = this.ppgSqi * 0.65 + localSqi * 0.35;
    return clamp(Math.max(localSqi, blended), 0, 100);
  }

  private adaptiveBeatWindowMs(): number {
    const rr = this.rrIntervals;
    let medRr = 0;
    if (rr.length >= 3) {
      const sorted = [...rr].sort((a, b) => a - b);
      medRr = sorted[Math.floor(sorted.length / 2)] ?? 0;
    } else if (this.cachedPeriodicity.bpm > 0 && this.cachedPeriodicity.score >= 0.3) {
      medRr = 60000 / this.cachedPeriodicity.bpm;
    }
    if (medRr <= 0) return PEAK_DETECTION_DEFAULTS.beatWindowMs;
    return clamp(
      medRr * PEAK_DETECTION_DEFAULTS.beatWindowRrFactor,
      PEAK_DETECTION_DEFAULTS.beatWindowMs,
      PEAK_DETECTION_DEFAULTS.beatWindowMsMax,
    );
  }

  private resolvePublishBpm(peakAgeMs: number): number {
    const rrBpm = bpmFromEmittedRr(this.rrIntervals);
    if (this.fingerContactConfirmed && peakAgeMs < this.BPM_PUBLISH_HOLD_MS) {
      if (this.smoothBPM > 0 && rrBpm > 0) {
        const agree = Math.abs(this.smoothBPM - rrBpm) / Math.max(1, rrBpm) < 0.08;
        return Math.round(agree ? this.smoothBPM : rrBpm);
      }
      if (this.smoothBPM > 0) return Math.round(this.smoothBPM);
      if (rrBpm > 0) return Math.round(rrBpm);
    }
    return 0;
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

    const mean = this.rrIntervals.reduce((a, b) => a + b, 0) / this.rrIntervals.length;
    const variance = this.rrIntervals.reduce((a, rr) => a + (rr - mean) ** 2, 0) / this.rrIntervals.length;
    const cv = Math.sqrt(variance) / Math.max(1, mean);
    const rrStability = clamp(1 - cv * 1.5, 0, 1);

    return clamp(rrStability * 0.32 + peakSupport * 0.22 + sqiFactor * 0.2 + ens * 0.16 + peakBoost, 0, 1);
  }

  private normalizeWindow(values: number[], windowLen: number = 150): number[] {
    const refWindow = Array.from(this.getRecentSignal(windowLen));
    const { low, high, range } = robustBounds(refWindow);
    const scale = PEAK_DETECTION_DEFAULTS.HEARTBEAT_NORM_SCALE;
    if (range < this.minNormalizeRange()) {
      return values.map((v) => v * PEAK_DETECTION_DEFAULTS.HEARTBEAT_NORM_FALLBACK_GAIN);
    }
    return values.map((v) => {
      const c = Math.min(high, Math.max(low, v));
      return ((c - low) / range - 0.5) * scale;
    });
  }

  private estimateSampleRate(): number {
    if (this.bufferCount < 10) return this.cachedSampleRate || DSP_CONSTANTS.DEFAULT_SAMPLE_RATE;
    if (this.frameTick % 30 !== 0 && this.cachedSampleRate > 0) return this.cachedSampleRate;
    
    const recent = this.getRecentTimestamps(50);
    const intervals: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      const d = recent[i] - recent[i - 1];
      if (d >= 10 && d <= 100) intervals.push(d);
    }
    if (intervals.length < 6) return this.cachedSampleRate || DSP_CONSTANTS.DEFAULT_SAMPLE_RATE;
    const sorted = [...intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 33;
    this.cachedSampleRate = clamp(1000 / median, 20, 40);
    return this.cachedSampleRate;
  }

  private estimatePeriodicity(): { bpm: number; score: number } {
    if (this.bufferCount < 60) return { bpm: 0, score: 0 };
    const sampleRate = this.estimateSampleRate();
    const windowLen = this.consecutivePeaks < 3 ? PEAK_DETECTION_DEFAULTS.HEARTBEAT_WINDOW_WARMUP : PEAK_DETECTION_DEFAULTS.HEARTBEAT_WINDOW_STABLE;
    
    const recentRaw = Array.from(this.getRecentSignal(windowLen));
    const recentSignal = this.normalizeWindow(recentRaw, windowLen);
    const mean = recentSignal.reduce((s, v) => s + v, 0) / recentSignal.length;
    const centered = recentSignal.map((v) => v - mean);
    const energy = centered.reduce((s, v) => s + v * v, 0);

    if (energy < 400) return { bpm: 0, score: 0 };

    const minLag = Math.max(5, Math.round((sampleRate * 60) / 200));
    const maxLag = Math.min(centered.length - 8, Math.round((sampleRate * 60) / 38));
    const { lag, score } = autocorrDominantLag(centered, minLag, maxLag);

    if (lag === 0 || score < 0.18) return { bpm: 0, score: Math.max(0, score) };
    return { bpm: (60 * sampleRate) / lag, score: clamp(score, 0, 1) };
  }

  // ---- Audio y Hápticos ---- //
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
      // Ignorar fallos de audio context
    }
  }

  getRRIntervals(): number[] { return [...this.rrIntervals]; }
  getLastPeakTime(): number { return this.lastPeakTime; }

  softReacquirePeaks(nowMs?: number): void {
    const t = nowMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.gateRelaxUntilMs = t + 6500;
    this.reacquireModeUntilMs = t + 6500;
    this.consecutivePeaks = 0;
  }

  resetPeakTracking(): void {
    this.bufferHead = 0;
    this.bufferCount = 0;
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
      this.audioContext.close().catch(() => {});
    }
  }
}
