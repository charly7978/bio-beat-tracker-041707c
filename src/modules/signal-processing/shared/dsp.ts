/**
 * Utilidades DSP puras compartidas (sin estado).
 * Los filtros IIR en streaming siguen viviendo en `BandpassFilter`.
 */
import { PEAK_DETECTION_DEFAULTS } from '../../../config/signalProcessing';
import { clamp } from '../../../utils/math';
import { median } from '../../../utils/stats';

const TWO_PI_DSP = Math.PI * 2;

export function detrendLinear(y: number[]): number[] {
  const n = y.length;
  if (n < 2) return [...y];
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += y[i];
    sxx += i * i;
    sxy += i * y[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return [...y];
  const a = (n * sxy - sx * sy) / denom;
  const b = (sy - a * sx) / n;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = y[i] - (a * i + b);
  return out;
}

export function robustPercentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = clamp(Math.floor((sorted.length - 1) * q), 0, sorted.length - 1);
  return sorted[idx] ?? 0;
}

export function robustNormalizeZeroCenter(y: number[]): number[] {
  if (y.length === 0) return [];
  const s = [...y].sort((a, b) => a - b);
  const low = robustPercentile(s, 0.1);
  const high = robustPercentile(s, 0.9);
  const range = Math.max(1e-9, high - low);
  return y.map((v) => (clamp(v, low, high) - low) / range - 0.5);
}

export function movingAverage(x: number[], win: number): number[] {
  const n = x.length;
  if (n === 0 || win < 1) return [];
  const half = Math.floor(win / 2);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let c = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < n) {
        sum += x[j];
        c++;
      }
    }
    out[i] = c > 0 ? sum / c : x[i];
  }
  return out;
}

export function hampel1D(y: number[], window: number, nSigma = 3): number[] {
  const n = y.length;
  const out = [...y];
  const half = Math.floor(window / 2);
  for (let i = 0; i < n; i++) {
    const slice: number[] = [];
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < n) slice.push(y[j]);
    }
    if (slice.length < 3) continue;
    const med = median(slice);
    const mad =
      [...slice].reduce((s, v) => s + Math.abs(v - med), 0) / slice.length || 1e-9;
    if (Math.abs(y[i] - med) > nSigma * 1.4826 * mad) {
      out[i] = med;
    }
  }
  return out;
}

/** Re-muestreo lineal a timestamps uniformes en [0, durationMs] */
export function resampleToUniformTimeline(
  values: number[],
  timestampsMs: number[],
  targetCount: number
): { y: number[]; fs: number; t0: number; t1: number } {
  const n = Math.min(values.length, timestampsMs.length);
  if (n < 2 || targetCount < 4) {
    return { y: values.slice(), fs: 30, t0: timestampsMs[0] ?? 0, t1: timestampsMs[n - 1] ?? 0 };
  }
  const t0 = timestampsMs[0];
  const t1 = timestampsMs[n - 1];
  const duration = Math.max(1, t1 - t0);
  const fs = ((targetCount - 1) / duration) * 1000;
  const y = new Array<number>(targetCount);
  for (let k = 0; k < targetCount; k++) {
    const t = t0 + (duration * k) / (targetCount - 1);
    let j = 0;
    while (j < n - 2 && timestampsMs[j + 1] < t) j++;
    const tA = timestampsMs[j];
    const tB = timestampsMs[j + 1];
    const vA = values[j];
    const vB = values[j + 1];
    const u = tB > tA ? (t - tA) / (tB - tA) : 0;
    y[k] = vA + u * (vB - vA);
  }
  return { y, fs, t0, t1 };
}

/** Re-muestrea a timeline uniforme si los Δt son irregulares (cámara / backpressure). */
export function prepareUniformPpgWindow(
  signal: number[],
  timestampsMs: number[],
  samplingRateHz: number,
): { signal: number[]; timestampsMs: number[]; samplingRateHz: number; resampled: boolean } {
  if (signal.length !== timestampsMs.length || signal.length < 2) {
    return { signal, timestampsMs, samplingRateHz, resampled: false };
  }
  const cfg = PEAK_DETECTION_DEFAULTS;
  const gaps: number[] = [];
  for (let i = 1; i < timestampsMs.length; i++) gaps.push(timestampsMs[i]! - timestampsMs[i - 1]!);
  const sortedG = [...gaps].sort((a, b) => a - b);
  const med = median(gaps);
  const jitterP95 = sortedG[Math.floor(sortedG.length * 0.95)] ?? med;
  const needsResample =
    jitterP95 > med * cfg.RESAMPLE_JITTER_FACTOR ||
    med < cfg.RESAMPLE_DT_MIN_MS ||
    med > cfg.RESAMPLE_DT_MAX_MS;
  if (!needsResample) {
    return { signal, timestampsMs, samplingRateHz, resampled: false };
  }
  const targetN = clamp(
    Math.round(((timestampsMs[timestampsMs.length - 1]! - timestampsMs[0]!) / 1000) * samplingRateHz),
    cfg.RESAMPLE_TARGET_MIN,
    cfg.RESAMPLE_TARGET_MAX,
  );
  const r = resampleToUniformTimeline(signal, timestampsMs, targetN);
  const ts = new Array<number>(r.y.length);
  for (let i = 0; i < r.y.length; i++) {
    ts[i] = r.t0 + (i * (r.t1 - r.t0)) / Math.max(1, r.y.length - 1);
  }
  return { signal: r.y, timestampsMs: ts, samplingRateHz: r.fs, resampled: true };
}

/**
 * Autocorrelación (media de productos, no normalizada) de una señal a un lag fijo.
 * Primitiva compartida: la usa el ratio-of-ratios de SpO2 (r0/rLag por canal) y
 * cualquier consumidor que necesite el valor en un lag específico.
 */
export function autocorrAtLag(sig: readonly number[], lag: number): number {
  const n = sig.length;
  if (lag < 0 || n <= lag) return 0;
  let sum = 0;
  for (let i = 0; i < n - lag; i++) sum += sig[i]! * sig[i + lag]!;
  return sum / (n - lag);
}

export function autocorrDominantLag(
  centered: number[],
  minLag: number,
  maxLag: number
): { lag: number; score: number } {
  let bestLag = 0;
  let best = 0;
  const n = centered.length;
  for (let lag = minLag; lag <= maxLag && lag < n - 2; lag++) {
    let cross = 0;
    let eA = 0;
    let eB = 0;
    for (let i = lag; i < n; i++) {
      cross += centered[i] * centered[i - lag];
      eA += centered[i] * centered[i];
      eB += centered[i - lag] * centered[i - lag];
    }
    if (eA <= 0 || eB <= 0) continue;
    const c = cross / Math.sqrt(eA * eB);
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }
  return { lag: bestLag, score: best };
}

/**
 * Frecuencia dominante (Hz) de una serie uniformemente muestreada dentro de la
 * banda [fMinHz, fMaxHz], por PERIODOGRAMA (DFT por recurrencia de rotación, sin
 * trig por muestra). Frente a la autocorrelación, elige el fundamental por
 * energía espectral → sin ambigüedad de sub-armónico. La serie se centra por su
 * media internamente (pásela ya detrended si tiene tendencia lineal). Devuelve
 * la frecuencia del pico y su concentración espectral normalizada (0–1; ≈1 para
 * una onda pura, ≈0 para ruido sin periodicidad).
 */
export function bandLimitedDominantFreq(
  series: number[],
  fsHz: number,
  fMinHz: number,
  fMaxHz: number,
): { freqHz: number; quality: number } {
  const n = series.length;
  const fMax = Math.min(fMaxHz, fsHz * 0.5 - 1e-6); // respeta Nyquist
  if (n < 8 || fsHz <= 0 || fMax <= fMinHz) return { freqHz: 0, quality: 0 };

  let mean = 0;
  for (let i = 0; i < n; i++) mean += series[i];
  mean /= n;
  const centered = new Array<number>(n);
  let totalPower = 0;
  for (let i = 0; i < n; i++) {
    const c = series[i] - mean;
    centered[i] = c;
    totalPower += c * c;
  }
  if (totalPower < 1e-12) return { freqHz: 0, quality: 0 };

  // Resolución ≈0.004 Hz (~0.25 rpm), acotada para limitar el coste.
  const steps = clamp(Math.round((fMax - fMinHz) / 0.004), 64, 2048);
  let bestMag = 0;
  let bestF = 0;
  for (let s = 0; s <= steps; s++) {
    const f = fMinHz + ((fMax - fMinHz) * s) / steps;
    const w = (TWO_PI_DSP * f) / fsHz;
    const cosW = Math.cos(w);
    const sinW = Math.sin(w);
    let cw = 1;
    let sw = 0;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      re += centered[i] * cw;
      im += centered[i] * sw;
      const nextCw = cw * cosW - sw * sinW;
      sw = sw * cosW + cw * sinW;
      cw = nextCw;
    }
    const mag = re * re + im * im;
    if (mag > bestMag) {
      bestMag = mag;
      bestF = f;
    }
  }

  const quality = clamp((2 * bestMag) / (n * totalPower), 0, 1);
  return { freqHz: bestF, quality };
}

/**
 * Momentos estadísticos de una ventana de señal (una sola pasada, sin allocations).
 *
 * Convenciones (idénticas a `src/utils/stats.ts`, fuente única de semántica):
 *  - `skewness`  = asimetría de Fisher-Pearson g1 = m3 / m2^{3/2} (0 = simétrica).
 *  - `kurtosis`  = EXCESO de kurtosis (β₂ − 3; 0 = gaussiana, >0 = leptocúrtica
 *    con picos agudos, <0 = platicúrtica/aplanada). NUNCA devuelve la kurtosis
 *    cruda de Pearson β₂: los umbrales de scoring SQI
 *    (VITAL_THRESHOLDS.QUALITY.KURTOSIS_SQI_LOW/HIGH, Elgendi 2016) están
 *    definidos sobre el EXCESO. Alimentar β₂ cruda (≥0 siempre, ≈3 para ruido
 *    gaussiano) saturaba el término en puntuación máxima para cualquier ventana,
 *    incluido ruido puro → inflaba el SQI de señales inválidas.
 *
 * Ventana degenerada (varianza ≈ 0): devuelve todos los momentos en 0.
 */
export function computeWindowMoments(values: readonly number[]): {
  mean: number;
  variance: number;
  std: number;
  skewness: number;
  kurtosis: number;
} {
  const n = values.length;
  if (n < 3) {
    return { mean: 0, variance: 0, std: 0, skewness: 0, kurtosis: 0 };
  }
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    s1 += v;
    s2 += v * v;
    s3 += v * v * v;
    s4 += v * v * v * v;
  }
  const mean = s1 / n;
  const m2 = s2 / n - mean * mean;
  if (!(m2 > 1e-18)) {
    return { mean, variance: Math.max(0, m2), std: 0, skewness: 0, kurtosis: 0 };
  }
  const m3 = s3 / n - 3 * mean * (s2 / n) + 2 * mean * mean * mean;
  const m4 =
    s4 / n - 4 * mean * (s3 / n) + 6 * mean * mean * (s2 / n) - 3 * mean * mean * mean * mean;
  const std = Math.sqrt(m2);
  return {
    mean,
    variance: m2,
    std,
    skewness: m3 / (std * std * std),
    // Exceso de kurtosis (β₂ − 3): convención compartida con stats.ts y con los
    // umbrales KURTOSIS_SQI_* de vitalThresholds.
    kurtosis: m4 / (m2 * m2) - 3,
  };
}

