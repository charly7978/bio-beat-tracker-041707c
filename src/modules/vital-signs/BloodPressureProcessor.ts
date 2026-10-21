import { PPGFeatureExtractor, CycleFeatures } from './PPGFeatureExtractor';
import { VITAL_THRESHOLDS } from '../../config/vitalThresholds';
import { DSP_CONSTANTS } from '../../config/signalProcessing';
import { isPhysiologicalRR, RR_MIN_MS } from '../../utils/physio';
import { median } from '../../utils/stats';
import type { FingerPlacementMode } from '../../types/signal';
import {
  estimatePhysiologicalBp,
  isPhysiologicalBp,
  enforceHemodynamicCoherence,
  type AnthropometricProfile,
  type PwaMedianFeatures,
} from '@/lib/vitals/pwaPhysiologicalBpEngine';
import { CalibrationManager } from './CalibrationManager';

export interface BPEstimate {
  systolic: number;
  diastolic: number;
  map: number;
  pulsePressure: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  cyclesUsed: number;
  featureQuality: number;
}

const BUFFER_MAX = 12;
const STALE_FRAMES_MAX = 90; // ~3 segundos a 30fps

export class BloodPressureProcessor {
  private readonly MIN_CYCLES = VITAL_THRESHOLDS.BP.MIN_CYCLES;
  private placementMode: FingerPlacementMode = 'hybrid';

  private cycleBuffer: CycleFeatures[] = [];
  private lastSBP = 0;
  private lastDBP = 0;
  // (lastConfidence removed - unused)
  private staleFrames = 0;
  private anthropometric: AnthropometricProfile | null = null;

  setPlacementMode(mode: FingerPlacementMode): void {
    this.placementMode = mode;
  }

  setAnthropometric(profile: AnthropometricProfile | null): void {
    this.anthropometric = profile;
  }

  getAnthropometric(): AnthropometricProfile | null {
    return this.anthropometric;
  }

  private minCycleQuality(): number {
    const P = VITAL_THRESHOLDS.PLACEMENT;
    if (this.placementMode === 'tip') return P.BP_CYCLE_QUALITY_TIP;
    if (this.placementMode === 'pad') return P.BP_CYCLE_QUALITY_PAD;
    return P.BP_CYCLE_QUALITY_HYBRID;
  }

  estimate(
    signalBuffer: number[],
    rrIntervals: number[],
    sampleRate: number = DSP_CONSTANTS.DEFAULT_SAMPLE_RATE,
    externalHr?: number,
  ): BPEstimate {
    const insufficient: BPEstimate = {
      systolic: 0,
      diastolic: 0,
      map: 0,
      pulsePressure: 0,
      confidence: 'INSUFFICIENT',
      cyclesUsed: 0,
      featureQuality: 0,
    };

    if (signalBuffer.length < VITAL_THRESHOLDS.BP.MIN_BUFFER_SAMPLES || rrIntervals.length < 1) {
      return this.staleOrInsufficient(insufficient);
    }

    const cycles = PPGFeatureExtractor.detectCardiacCycles(signalBuffer, sampleRate);
    const validCycles: CycleFeatures[] = [];
    for (const cycle of cycles) {
      const features = PPGFeatureExtractor.extractCycleFeatures(signalBuffer, cycle, sampleRate);
      if (features && features.quality >= this.minCycleQuality()) {
        validCycles.push(features);
      }
    }

    // Si encontramos ciclos válidos en la ventana actual, actualizamos el buffer móvil
    if (validCycles.length >= 1) {
      this.cycleBuffer = validCycles.slice(-BUFFER_MAX);
    }

    if (this.cycleBuffer.length < this.MIN_CYCLES) {
      return this.staleOrInsufficient(insufficient);
    }

    const mf = this.medianFeatures(this.cycleBuffer);

    const validRR = rrIntervals.filter((i) => isPhysiologicalRR(i) && i <= 1800);
    const avgRR = validRR.length > 0
      ? validRR.reduce((a, b) => a + b, 0) / validRR.length
      : 800;
    const hr = typeof externalHr === 'number' && externalHr > 0
      ? externalHr
      : 60000 / avgRR;
    const rrVar = PPGFeatureExtractor.extractRRVariability(validRR.length >= 2 ? validRR : [avgRR, avgRR]);
    const cyclePeriodMs = Math.max(RR_MIN_MS, mf.sutMs + mf.diastolicPhaseMs);

    const calibrationOffsets = CalibrationManager.getInstance().getActiveBpOffsets();

    const raw = estimatePhysiologicalBp(
      mf,
      { hr, rmssd: rrVar.rmssd, cyclePeriodMs },
      this.anthropometric,
      calibrationOffsets
    );

    const coherent = enforceHemodynamicCoherence(raw.systolic, raw.diastolic);
    const sbp = coherent.sbp;
    const dbp = coherent.dbp;

    if (!isPhysiologicalBp(sbp, dbp)) {
      return this.staleOrInsufficient(insufficient);
    }

    const fq = this.assessFeatureQuality(mf, this.cycleBuffer.length);
    let confidence: BPEstimate['confidence'] = 'LOW';
    if (fq >= VITAL_THRESHOLDS.BP.FEATURE_QUALITY_HIGH) confidence = 'HIGH';
    else if (fq >= VITAL_THRESHOLDS.BP.FEATURE_QUALITY_MEDIUM) confidence = 'MEDIUM';

    this.lastSBP = sbp;
    this.lastDBP = dbp;
    this.staleFrames = 0;

    return {
      systolic: Math.round(sbp),
      diastolic: Math.round(dbp),
      map: Math.round(dbp + (sbp - dbp) / 3),
      pulsePressure: Math.round(sbp - dbp),
      confidence,
      cyclesUsed: this.cycleBuffer.length,
      featureQuality: fq,
    };
  }

  private staleOrInsufficient(insufficient: BPEstimate): BPEstimate {
    this.staleFrames++;

    if (this.lastSBP <= 0 || this.lastDBP <= 0) {
      return insufficient;
    }

    if (this.staleFrames >= STALE_FRAMES_MAX) {
      this.lastSBP = 0;
      this.lastDBP = 0;
      return insufficient;
    }

    return {
      systolic: Math.round(this.lastSBP),
      diastolic: Math.round(this.lastDBP),
      map: Math.round(this.lastDBP + (this.lastSBP - this.lastDBP) / 3),
      pulsePressure: Math.round(this.lastSBP - this.lastDBP),
      confidence: 'LOW',
      cyclesUsed: this.cycleBuffer.length,
      featureQuality: 0,
    };
  }

  private medianFeatures(cycles: CycleFeatures[]): PwaMedianFeatures {
    const take = cycles.slice(-BUFFER_MAX);
    return {
      bDivA: median(take.map((c) => c.apg.bDivA)),
      dDivA: median(take.map((c) => c.apg.dDivA)),
      agi: median(take.map((c) => c.apg.agi)),
      sutMs: median(take.map((c) => c.sutMs)),
      diastolicPhaseMs: median(take.map((c) => c.diastolicPhaseMs)),
      stiffnessIndex: median(take.map((c) => c.stiffnessIndex)),
      augmentationIndex: median(take.map((c) => c.augmentationIndex)),
      dicroticDepth: median(take.map((c) => c.dicroticDepth)),
      areaRatio: median(take.map((c) => c.areaRatio)),
      pw50Ms: median(take.map((c) => c.pw50Ms)),
      kValue: median(take.map((c) => c.kValue)),
      vMax: median(take.map((c) => c.vMax)),
      harmonicDistortion: median(take.map((c) => c.harmonicDistortion)),
      reflectionIndex: median(take.map((c) => c.reflectionIndex ?? 0)),
      elasticModulusProxy: median(take.map((c) => c.elasticModulusProxy ?? 0)),
    };
  }

  private assessFeatureQuality(f: PwaMedianFeatures, cycleCount: number): number {
    let score = 0;
    score += Math.min(25, cycleCount * 5);
    if (f.sutMs > 40 && f.sutMs < 400) score += 16;
    if (f.diastolicPhaseMs > 50 && f.diastolicPhaseMs < 800) score += 14;
    if (f.stiffnessIndex > 0.5 && f.stiffnessIndex < 25) score += 12;
    if (f.augmentationIndex > 2 && f.augmentationIndex < 45) score += 10;
    if (f.dicroticDepth > 0 && f.dicroticDepth < 0.8) score += 8;
    if (f.pw50Ms > 60 && f.pw50Ms < 600) score += 7;
    if (f.harmonicDistortion > 0.05 && f.harmonicDistortion < 1) score += 4;
    if (typeof f.reflectionIndex === 'number' && f.reflectionIndex > 5 && f.reflectionIndex < 95) score += 4;
    return Math.min(100, score);
  }

  reset(): void {
    this.lastSBP = 0;
    this.lastDBP = 0;
    this.cycleBuffer = [];
    this.staleFrames = 0;
  }
}
