/**
 * Estadística robusta compartida (mediana, percentiles).
 */
import { clamp } from './math';

export type NumericSequence = number[] | Float32Array | Float64Array;

export function median(values: NumericSequence): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function percentile(values: NumericSequence, p: number): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const idx = clamp(Math.floor((sorted.length - 1) * (p / 100)), 0, sorted.length - 1);
  return sorted[idx] ?? 0;
}

export function robustBounds(
  values: NumericSequence,
  lowQ = 0.1,
  highQ = 0.9,
): { low: number; high: number; range: number } {
  if (values.length === 0) return { low: 0, high: 0, range: 0 };
  const sorted = Array.from(values).sort((a, b) => a - b);
  const lowIdx = clamp(Math.floor((sorted.length - 1) * lowQ), 0, sorted.length - 1);
  const highIdx = clamp(Math.floor((sorted.length - 1) * highQ), 0, sorted.length - 1);
  const low = sorted[lowIdx] ?? 0;
  const high = sorted[highIdx] ?? 0;
  return { low, high, range: Math.max(0, high - low) };
}

export function robustDynamicRange(values: NumericSequence, lowQ = 0.1, highQ = 0.9): number {
  const { range } = robustBounds(values, lowQ, highQ);
  return Math.max(0.008, range);
}

/**
 * Desviación estándar canónica (muestral/poblacional consistente).
 */
export function stdDev(values: NumericSequence): number {
  const n = values.length;
  if (n < 2) return 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  const variance = (sumSq / n) - (mean * mean);
  return Math.sqrt(Math.max(0, variance));
}

/**
 * Skewness (asimetría de Fisher-Pearson) de una ventana de señal.
 */
export function skewness(values: NumericSequence): number {
  const n = values.length;
  if (n < 3) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += values[i]!;
  mean /= n;
  let m2 = 0;
  let m3 = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i]!;
    const diff = d - mean;
    m2 += diff * diff;
    m3 += diff * diff * diff;
  }
  m2 /= n;
  m3 /= n;
  const sd = Math.sqrt(m2);
  if (sd < 1e-9) return 0;
  return m3 / (sd * sd * sd);
}


/**
 * Kurtosis (excess, Fisher-Pearson): 0 for normal distribution.
 * Detects heavy-tailed signals (artifacts, saturation) vs clean PPG (~0-3).
 */
export function kurtosis(values: NumericSequence): number {
  const n = values.length;
  if (n < 3) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += values[i]!;
  mean /= n;
  let m2 = 0;
  let m4 = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i]! - mean;
    const d2 = d * d;
    m2 += d2;
    m4 += d2 * d2;
  }
  m2 /= n;
  m4 /= n;
  if (m2 < 1e-18) return 0;
  return m4 / (m2 * m2) - 3;
}

/**
 * Shannon entropy (nats) of a quantized signal window.
 * High entropy = noise / random impulse; low entropy = periodic signal.
 */
export function shannonEntropy(values: NumericSequence, bins = 64): number {
  const n = values.length;
  if (n < 2) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi - lo < 1e-12) return 0;
  const counts = new Float64Array(bins);
  const inv = (bins - 1) / (hi - lo);
  for (let i = 0; i < n; i++) {
    const b = Math.min(bins - 1, Math.floor((values[i]! - lo) * inv));
    counts[b]++;
  }
  let entropy = 0;
  for (let b = 0; b < bins; b++) {
    if (counts[b] > 0) {
      const p = counts[b] / n;
      entropy -= p * Math.log(p);
    }
  }
  return entropy;
}

/**
 * Hjorth metrics: activity, mobility, complexity for a window.
 * Activity = variance; Mobility = var(gradient) / var(signal);
 * Complexity = mobility(signal) / mobility(gradient).
 */
export function hjorthMetrics(values: NumericSequence): {
  activity: number;
  mobility: number;
  complexity: number;
} {
  const n = values.length;
  if (n < 2) return { activity: 0, mobility: 0, complexity: 1 };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += values[i]!;
  mean /= n;
  let varSig = 0;
  let varGrad = 0;
  let prev = values[0]! - mean;
  for (let i = 1; i < n; i++) {
    const cur = values[i]! - mean;
    varSig += cur * cur;
    const grad = cur - prev;
    varGrad += grad * grad;
    prev = cur;
  }
  varSig /= n;
  varGrad /= (n - 1);
  const activity = varSig;
  const mobility = varGrad > 1e-18 ? Math.sqrt(varGrad / varSig) : 0;
  const complexity = varSig > 1e-18 ? mobility / Math.sqrt(varGrad / varSig) : 1;
  return { activity, mobility, complexity };
}
