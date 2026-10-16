import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

export interface FingerRgbSnapshot {
  red: number;
  green: number;
  blue: number;
  coverage: number;
  fingerScore: number;
}

export interface FingerEnsembleMetrics {
  brightnessScore: number;
  coverageScore: number;
  histogramScore: number;
  temporalScore: number;
  ensembleScore: number;
}

export interface HistogramStats {
  binsOccupied: number;
  peakHeight: number;
}

let prevFrameGray: Uint8ClampedArray | null = null;
let zloR = 0;
let zloG = 0;
let zloB = 0;
let zloCalibrated = false;

export function resetZlo(): void {
  zloCalibrated = false;
}

export function calibrateZlo(r: number, g: number, b: number): void {
  zloR = r;
  zloG = g;
  zloB = b;
  zloCalibrated = true;
}

export function getZlo(): { r: number; g: number; b: number; calibrated: boolean } {
  return { r: zloR, g: zloG, b: zloB, calibrated: zloCalibrated };
}

export function computeHistogramStats(grayPixels: Uint8ClampedArray): HistogramStats {
  const hist = new Uint32Array(256);
  for (let i = 0; i < grayPixels.length; i++) {
    hist[grayPixels[i]]++;
  }
  let binsOccupied = 0;
  let peakHeight = 0;
  const total = grayPixels.length;
  for (let i = 0; i < 256; i++) {
    if (hist[i] > 0) binsOccupied++;
    const h = hist[i] / total;
    if (h > peakHeight) peakHeight = h;
  }
  return { binsOccupied, peakHeight };
}

export function computeTemporalVariance(
  currentGray: Uint8ClampedArray,
): number {
  if (!prevFrameGray || prevFrameGray.length !== currentGray.length) {
    prevFrameGray = new Uint8ClampedArray(currentGray);
    return 1;
  }
  let sumDelta = 0;
  for (let i = 0; i < currentGray.length; i++) {
    sumDelta += Math.abs(currentGray[i] - prevFrameGray[i]);
  }
  prevFrameGray = new Uint8ClampedArray(currentGray);
  const meanDelta = sumDelta / currentGray.length;
  return meanDelta / 255;
}

export function computeFingerEnsemble(
  snapshot: FingerRgbSnapshot,
  grayPixels: Uint8ClampedArray | null,
  temporalVariance: number,
): FingerEnsembleMetrics {
  const E = VITAL_THRESHOLDS.FINGER.ENSEMBLE;
  const total = snapshot.red + snapshot.green + snapshot.blue;

  const brightnessNorm = Math.min(total / 255, E.BRIGHTNESS_NORM_DIVISOR) / E.BRIGHTNESS_NORM_DIVISOR;
  const brightScore =
    brightnessNorm > E.BRIGHTNESS_FULL
      ? 1.0
      : brightnessNorm > E.BRIGHTNESS_PARTIAL
        ? E.BRIGHTNESS_PARTIAL_SCORE
        : (brightnessNorm / E.BRIGHTNESS_PARTIAL) * E.BRIGHTNESS_LOW_SCALE;

  const covScore =
    snapshot.coverage > E.COVER_FULL
      ? 1.0
      : snapshot.coverage > E.COVER_PARTIAL
        ? E.COVER_PARTIAL_SCORE
        : (snapshot.coverage / E.COVER_PARTIAL) * E.COVER_LOW_SCALE;

  let histScore = E.HIST_SCORE_DEFAULT;
  if (grayPixels) {
    const h = computeHistogramStats(grayPixels);
    if (h.binsOccupied < E.HIST_BINS_STRONG && h.peakHeight > E.HIST_PEAK_STRONG) {
      histScore = 1.0;
    } else if (h.binsOccupied < E.HIST_BINS_MED && h.peakHeight > E.HIST_PEAK_MED) {
      histScore = E.HIST_SCORE_MED;
    }
  }

  const tempScore =
    temporalVariance < E.TEMP_STABLE_MAX
      ? 1.0
      : temporalVariance < E.TEMP_SOFT_MAX
        ? E.TEMP_SCORE_SOFT
        : temporalVariance < E.TEMP_NOISY_MAX
          ? E.TEMP_SCORE_NOISY
          : E.TEMP_SCORE_UNSTABLE;

  const ensemble =
    E.W_BRIGHTNESS * brightScore +
    E.W_COVERAGE * covScore +
    E.W_HISTOGRAM * histScore +
    E.W_TEMPORAL * tempScore;

  return {
    brightnessScore: brightScore,
    coverageScore: covScore,
    histogramScore: histScore,
    temporalScore: tempScore,
    ensembleScore: ensemble,
  };
}

export function isFingerPresentByEnsemble(metrics: FingerEnsembleMetrics): boolean {
  return metrics.ensembleScore > VITAL_THRESHOLDS.FINGER.ENSEMBLE_FINGER_THRESHOLD;
}

export function hasFingerHemoglobinSignature(s: FingerRgbSnapshot): boolean {
  const F = VITAL_THRESHOLDS.FINGER;
  const r = s.red;
  const g = Math.max(1, s.green);
  const b = Math.max(1, s.blue);
  const total = r + g + b;
  if (total < F.ACQUIRE_SOFT_INTENSITY_MIN) return false;

  const redDominance = r - (g + b) / 2;
  const rg = r / g;
  const rb = r / b;

  if (r < F.MIN_RED_INTENSITY) return false;
  if (rg < F.MIN_RG_RATIO) return false;
  if (rb < F.HEMOGLOBIN_MIN_RB) return false;
  if (redDominance < F.MIN_RED_DOMINANCE) return false;

  if (rg < F.HEMOGLOBIN_AMBIGUOUS_RG && rb < F.HEMOGLOBIN_AMBIGUOUS_RB) return false;
  if (g > F.HEMOGLOBIN_BRIGHT_G && b > F.HEMOGLOBIN_BRIGHT_B && redDominance < F.HEMOGLOBIN_BRIGHT_MAX_DOMINANCE) {
    return false;
  }
  if (total > F.HEMOGLOBIN_STRONG_TOTAL && rb < F.HEMOGLOBIN_STRONG_MIN_RB) return false;
  if (total > F.HEMOGLOBIN_MED_TOTAL && rb < F.HEMOGLOBIN_MED_MIN_RB && rg < F.HEMOGLOBIN_MED_MIN_RG) {
    return false;
  }

  return (
    s.coverage >= F.MIN_COVERAGE * 0.95 &&
    s.fingerScore >= F.ACQUIRE_SOFT_FINGER_SCORE_ROI * 0.9
  );
}
