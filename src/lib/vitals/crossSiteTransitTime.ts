/**
 * CROSS-SITE TRANSIT TIME (CSTT) — Estimador del retardo inter-sitio cara→dedo
 * ============================================================================
 * Módulo puro (sin estado global, sin cámara, sin dependencias de runtime)
 * que estima el tiempo de tránsito del pulso (τ) entre dos series de PPG
 * capturadas en el mismo intervalo de tiempo: una proximal-ish (rPPG facial)
 * y otra distal (PPG de dedo, contacto con flash).
 *
 * Base científica (verificada en docs/nexus-vitals-blueprint.md):
 *  - Knapp & Carter 1976: Generalized Cross Correlation (GCC-PHAT). La
 *    ponderación de fase tolera diferencias de amplitud y color de canal,
 *    exactamente lo que separa a la señal facial de la digital.
 *  - EMBC 2025 (PMID 41337391): PTT entre oreja y dedo con las dos cámaras de
 *    UN smartphone → MAE SBP/DBP 3.74/2.73 mmHg con calibración personal.
 *  - JMIR mHealth 2023 (AlwaysBP, PMID 37694382): PTT por cámara+IMU como
 *    instrumento validado; la relación inversa PTT↔PA exige calibración.
 *  - Moens–Korteweg: la velocidad del pulso crece con la presión → forma
 *    clásica SBP ≈ k/τ² + c con coeficientes personales.
 *
 * Dos caminos independientes se fusionan:
 *  1) GCC-PHAT con refinamiento parabólico sub-muestra.
 *  2) Pie de onda por latido: onset por intersección de la tangente de máxima
 *     pendiente con el nivel del valle previo (método clásico de PTT).
 *
 * Políticas de honestidad (coherentes con `check:no-sim` y `waveHonesty`):
 *  - Evidencia insuficiente → τ = null con `reason` técnico explícito.
 *  - Fuera del rango fisiológico → RECHAZO (nunca recorte).
 *  - La divergencia entre estimadores se publica, no se esconde.
 */

import { detrendLinear } from '@/modules/signal-processing/shared/dsp';
import { median } from '@/utils/stats';
import { clamp } from '@/utils/math';

/** Banda espectral útil del pulso humano para coherencia/contenido (Hz). */
const PULSE_BAND_HZ_MIN = 0.7;
const PULSE_BAND_HZ_MAX = 4.5;
/** Divergencia máxima tolerada entre estimadores antes de marcar desacuerdo (ms). */
const DEFAULT_MAX_DIVERGENCE_MS = 15;
/** Residuo máximo de un latido respecto a la mediana para contar coherente (ms). */
const BEAT_RESIDUAL_TOLERANCE_MS = 25;
/** Duración mínima de la ventana común (s). */
const MIN_WINDOW_SECONDS = 4;
/** Fracción mínima de energía espectral en banda de pulso (por sitio). */
const MIN_BAND_ENERGY_RATIO = 0.25;
/** Latidos mínimos coherentes para que el pie de onda participe. */
const MIN_BEATS_FOR_ONSET = 2;

export interface CrossSiteTimingOptions {
  /** Frecuencia de muestreo común de ambas series (Hz). */
  sampleRateHz: number;
  /** τ mínimo plausible cara→dedo (ms). Default 10. */
  minTauMs?: number;
  /** τ máximo plausible cara→dedo (ms). Default 350. */
  maxTauMs?: number;
  /** Divergencia máxima entre estimadores antes de degradar (ms). Default 15. */
  maxEstimatorDivergenceMs?: number;
  /**
   * Índices (muestras) de picos sistólicos del sitio proximal (opcional).
   * Presencia de ambos arrays activa el camino de pie de onda por latido.
   */
  proximalPeakIndices?: readonly number[];
  /** Índices (muestras) de picos sistólicos del sitio distal (opcional). */
  distalPeakIndices?: readonly number[];
}

export interface CrossSiteTimingResult {
  /** τ estimado en ms (distal después de proximal) o null sin evidencia. */
  tauMs: number | null;
  /** Calidad 0–100 (calculada incluso cuando τ es null). */
  quality: number;
  /** Nivel verbal derivado de la calidad (null si τ no se emite). */
  confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  /** Motivo técnico ('OK', 'OK_DIVERGENCE_FLAGGED', o causa del rechazo). */
  reason: string;
  /** Lag del camino GCC-PHAT si participó (ms). */
  gccLagMs: number | null;
  /** τ (mediana de latidos) del camino de pie de onda si participó (ms). */
  onsetLagMs: number | null;
  /** Latidos aceptados por el pie de onda. */
  beatsAgreed: number;
  /** Coherencia espectral media (MSC) en banda de pulso 0–1. */
  spectralCoherence: number;
  /** Índices proximal de los latidos usados por el pie de onda. */
  matchedProximalPeakIndices: number[];
  /** τ individual por latido aceptado (ms), en el orden de matchedProximalPeakIndices. */
  tauByBeatMs: number[];
}

interface TimingCandidate {
  tau: number;
  source: 'onset' | 'gcc';
}

/* ─────────────────────────── Utilidades numéricas ─────────────────────────── */

function meanStd(values: readonly number[]): { mean: number; std: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, std: 0 };
  let s = 0;
  for (let i = 0; i < n; i++) s += values[i];
  const mean = s / n;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean;
    v += d * d;
  }
  return { mean, std: Math.sqrt(v / n) };
}

/** Ventana de Hann in-situ (mitiga fugas de borde en la FFT). */
function applyHannWindow(x: number[]): void {
  const n = x.length;
  for (let i = 0; i < n; i++) {
    x[i] *= 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * FFT radix-2 iterativa (Cooley–Tukey, bit-reversal). Longitud potencia de 2.
 */
function fftRadix2(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  if (n <= 1) return;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const a2Re = re[i + k + half];
        const a2Im = im[i + k + half];
        const bRe = a2Re * curRe - a2Im * curIm;
        const bIm = a2Re * curIm + a2Im * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + half] = aRe - bRe;
        im[i + k + half] = aIm - bIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** Espectro de una serie (con ceros hasta padN). */
function spectrumOf(series: readonly number[], padN: number): { re: Float64Array; im: Float64Array } {
  const re = new Float64Array(padN);
  const im = new Float64Array(padN);
  for (let i = 0; i < series.length; i++) re[i] = series[i];
  fftRadix2(re, im, false);
  return { re, im };
}

/** Refinamiento parabólico de un máximo discreto (δ ∈ [−0.5, 0.5]). */
function parabolicRefine(a: number, b: number, c: number): number {
  const den = a - 2 * b + c;
  if (Math.abs(den) < 1e-12) return 0;
  return clamp((0.5 * (a - c)) / den, -0.5, 0.5);
}

/* ───────────────── Camino de pie de onda (onset por latido) ───────────────── */

/**
 * Onset de un latido: intersección de la tangente de máxima pendiente del
 * frente sistólico con el nivel base del valle previo. Escala-invariante.
 */
export function onsetIndexNearPeak(
  smoothed: readonly number[],
  peakIdx: number,
  beatPeriodSamples: number,
): number {
  const n = smoothed.length;
  const from = Math.max(1, peakIdx - Math.round(0.45 * beatPeriodSamples));
  const to = Math.max(from + 1, peakIdx - Math.round(0.04 * beatPeriodSamples));
  let base = Number.POSITIVE_INFINITY;
  for (let i = from; i <= to; i++) base = Math.min(base, smoothed[i]);
  let bestSlope = 0;
  let bestIdx = -1;
  for (let i = from + 1; i < to; i++) {
    const slope = (smoothed[i + 1] - smoothed[i - 1]) / 2;
    if (slope > bestSlope) {
      bestSlope = slope;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestSlope <= 1e-9) return peakIdx;
  const yS = smoothed[bestIdx];
  const t0 = bestIdx - (yS - base) / bestSlope;
  return Math.max(0, Math.min(n - 1, Math.round(t0)));
}

/** Suavizado MA3 sin estado (para el frente de onda). */
function smoothMa3(series: readonly number[]): number[] {
  const out = new Array<number>(series.length);
  for (let i = 0; i < series.length; i++) {
    const a = series[Math.max(0, i - 1)];
    const b = series[i];
    const c = series[Math.min(series.length - 1, i + 1)];
    out[i] = (a + b + c) / 3;
  }
  return out;
}

interface BeatPair {
  proximalPeakIdx: number;
  tauSamples: number;
}

/** Pareo picos proximal→distal y τ por latido con pie de onda. */
function onsetPairs(
  proximal: readonly number[],
  distal: readonly number[],
  proximalPeaks: readonly number[],
  distalPeaks: readonly number[],
  fs: number,
  minTauSamples: number,
  maxTauSamples: number,
): BeatPair[] {
  const pairs: BeatPair[] = [];
  if (proximalPeaks.length < MIN_BEATS_FOR_ONSET || distalPeaks.length < MIN_BEATS_FOR_ONSET) return pairs;

  const diffs: number[] = [];
  for (let i = 1; i < proximalPeaks.length; i++) {
    const d = proximalPeaks[i] - proximalPeaks[i - 1];
    if (d > 0) diffs.push(d);
  }
  const beatPeriod = diffs.length > 0 ? median(diffs) : Math.round(0.8 * fs);
  const smoothedProx = smoothMa3(proximal);
  const smoothedDist = smoothMa3(distal);
  const halfPeriod = Math.max(3, Math.round(0.35 * beatPeriod));
  const midTau = (minTauSamples + maxTauSamples) / 2;

  for (const pIdx of proximalPeaks) {
    if (pIdx <= 2 || pIdx >= proximal.length - 2) continue;
    const lo = pIdx + minTauSamples - halfPeriod;
    const hi = pIdx + maxTauSamples + halfPeriod;
    let bestJ = -1;
    let bestDist = Number.MAX_SAFE_INTEGER;
    for (const dIdx of distalPeaks) {
      if (dIdx < lo || dIdx > hi || dIdx <= 2 || dIdx >= distal.length - 2) continue;
      const dist = Math.abs(dIdx - (pIdx + midTau));
      if (dist < bestDist) {
        bestDist = dist;
        bestJ = dIdx;
      }
    }
    if (bestJ < 0) continue;
    const onProx = onsetIndexNearPeak(smoothedProx, pIdx, beatPeriod);
    const onDist = onsetIndexNearPeak(smoothedDist, bestJ, beatPeriod);
    pairs.push({ proximalPeakIdx: pIdx, tauSamples: onDist - onProx });
  }
  return pairs;
}

/* ────────────────── Puntuación de calidad (una sola definición) ───────────── */

function qualityScore(
  msc: number,
  agreement01: number,
  beatsAgreed: number,
  windowSeconds: number,
  divergenceFlagged: boolean,
  singleSource: boolean,
): number {
  let q = 30;
  q += clamp((msc - 0.4) / 0.4, 0, 1) * 30;      // coherencia 0.4→0.8
  q += agreement01 * 25;                          // concordancia entre estimadores
  q += (Math.min(6, beatsAgreed) / 6) * 10;       // latidos coherentes
  q += windowSeconds >= 8 ? 5 : clamp(windowSeconds / 8, 0, 1) * 5;
  if (divergenceFlagged) q = Math.min(q, 55);
  if (singleSource && !divergenceFlagged) q = Math.min(q, 55);
  return Math.round(clamp(q, 0, 100));
}

/* ───────────────────────────── API principal ─────────────────────────────── */

/**
 * Estima el retardo inter-sitio τ (cara→dedo). Devuelve τ = null con `reason`
 * técnico si la evidencia es insuficiente o fuera del rango fisiológico.
 */
export function estimateCrossSiteTransitTime(
  proximalInput: readonly number[],
  distalInput: readonly number[],
  options: CrossSiteTimingOptions,
): CrossSiteTimingResult {
  const base: CrossSiteTimingResult = {
    tauMs: null,
    quality: 0,
    confidenceLevel: null,
    reason: 'OK',
    gccLagMs: null,
    onsetLagMs: null,
    beatsAgreed: 0,
    spectralCoherence: 0,
    matchedProximalPeakIndices: [],
    tauByBeatMs: [],
  };

  const fs = options.sampleRateHz;
  const minTauMs = options.minTauMs ?? 10;
  const maxTauMs = options.maxTauMs ?? 350;
  const maxDivMs = options.maxEstimatorDivergenceMs ?? DEFAULT_MAX_DIVERGENCE_MS;

  if (!Number.isFinite(fs) || fs <= 1) return { ...base, reason: 'INVALID_SAMPLE_RATE' };
  const n = Math.min(proximalInput.length, distalInput.length);
  if (n < Math.ceil(MIN_WINDOW_SECONDS * fs)) return { ...base, reason: 'TOO_SHORT_WINDOW' };

  let proxSeries = detrendLinear(proximalInput.slice(0, n));
  let distSeries = detrendLinear(distalInput.slice(0, n));
  applyHannWindow(proxSeries);
  applyHannWindow(distSeries);
  const sProx = meanStd(proxSeries);
  const sDist = meanStd(distSeries);
  if (sProx.std < 1e-6 || sDist.std < 1e-6) return { ...base, reason: 'DEGENERATE_SIGNAL' };
  proxSeries = proxSeries.map((v) => v / sProx.std);
  distSeries = distSeries.map((v) => v / sDist.std);

  const padN = nextPow2(2 * n);
  const X = spectrumOf(proxSeries, padN);
  const Y = spectrumOf(distSeries, padN);

  // Contenido en banda de pulso por sitio (retención mínima de fuente real)
  const binHz = fs / padN;
  let bandProx = 0, totalProx = 0, bandDist = 0, totalDist = 0;
  for (let f = 1; f < Math.floor(padN / 2); f++) {
    const fHz = f * binHz;
    const inBand = fHz >= PULSE_BAND_HZ_MIN && fHz <= PULSE_BAND_HZ_MAX;
    const pP = X.re[f] * X.re[f] + X.im[f] * X.im[f];
    const pD = Y.re[f] * Y.re[f] + Y.im[f] * Y.im[f];
    totalProx += pP;
    totalDist += pD;
    if (inBand) {
      bandProx += pP;
      bandDist += pD;
    }
  }
  if (totalProx < 1e-12 || totalDist < 1e-12) return { ...base, reason: 'DEGENERATE_SPECTRUM' };
  if (bandProx / totalProx < MIN_BAND_ENERGY_RATIO || bandDist / totalDist < MIN_BAND_ENERGY_RATIO) {
    return { ...base, reason: 'LOW_PULSE_BAND_ENERGY' };
  }

  // ── Camino 1: GCC-PHAT ──
  const reR = new Float64Array(padN);
  const imR = new Float64Array(padN);
  for (let f = 0; f < padN; f++) {
    const crossRe = X.re[f] * Y.re[f] + X.im[f] * Y.im[f];   // X·conj(Y)
    const crossIm = Y.re[f] * X.im[f] - X.re[f] * Y.im[f];
    const mag = Math.sqrt(crossRe * crossRe + crossIm * crossIm) + 1e-12;
    reR[f] = crossRe / mag;
    imR[f] = crossIm / mag;
  }
  fftRadix2(reR, imR, true); // cc[k] = Σ x[n+k]·y[n]
  // Convención de lag: y[n] = x[n−d] (la señaria distal llega d muestras DESPUÉS
  // de la proximal en cada latido) ⇒ cc pic@score en k=−d. Buscamos en lags
  // negativos y reportamos τ = |k| (positivo: distal tras proximal).

  const lagMinS = Math.max(1, Math.round((minTauMs / 1000) * fs));
  const lagMaxS = Math.min(Math.floor((maxTauMs / 1000) * fs), Math.floor(padN / 2) - 2);
  // Magnitudes del rango de búsqueda + suelo de confianza espectral
  const searchMags: number[] = [];
  let sumMag = 0;
  for (let k = lagMinS; k <= lagMaxS; k++) {
    const idx = padN - k; // lag circular −k
    const mag = Math.sqrt(reR[idx] * reR[idx] + imR[idx] * imR[idx]);
    searchMags.push(mag);
    sumMag += mag;
  }
  const meanMag = searchMags.length > 0 ? sumMag / searchMags.length : 0;
  let bestOffset = -1;
  let bestMag = -1;
  for (let i = 0; i < searchMags.length; i++) {
    if (searchMags[i] > bestMag) {
      bestMag = searchMags[i];
      bestOffset = i;
    }
  }
  let gccLagMs: number | null = null;
  const GCC_ANCHOR_RATIO = 2.5; // pico dominante sobre el suelo del rango
  if (
    bestOffset >= 0 &&
    bestOffset >= 1 &&
    bestOffset <= searchMags.length - 2 &&
    bestMag >= GCC_ANCHOR_RATIO * meanMag
  ) {
    const bestKNeg = -(lagMinS + bestOffset); // lag circular −k
    const magAt = searchMags[bestOffset];
    const magBefore = searchMags[bestOffset - 1];
    const magAfter = searchMags[bestOffset + 1];
    const deltaK = parabolicRefine(magBefore, magAt, magAfter);
    gccLagMs = ((-bestKNeg + deltaK) / fs) * 1000;
  }

  // Coherencia espectral media (MSC) en banda de pulso
  let cohSum = 0;
  let cohCount = 0;
  for (let f = 1; f < Math.floor(padN / 2); f++) {
    const fHz = f * binHz;
    if (fHz < PULSE_BAND_HZ_MIN || fHz > PULSE_BAND_HZ_MAX) continue;
    const crossRe = X.re[f] * Y.re[f] + X.im[f] * Y.im[f];
    const crossIm = Y.re[f] * X.im[f] - X.re[f] * Y.im[f];
    const num = crossRe * crossRe + crossIm * crossIm;
    const den =
      (X.re[f] * X.re[f] + X.im[f] * X.im[f]) *
      (Y.re[f] * Y.re[f] + Y.im[f] * Y.im[f]) +
      1e-12;
    cohSum += num / den;
    cohCount++;
  }
  const mscMean = cohCount > 0 ? clamp(cohSum / cohCount, 0, 1) : 0;

  // ── Camino 2: pie de onda por latido ──
  const lagMinS2 = Math.max(1, Math.round((minTauMs / 1000) * fs));
  const lagMaxS2 = Math.min(Math.round((maxTauMs / 1000) * fs), n - 3);
  let onsetLagMs: number | null = null;
  let beatsAgreed = 0;
  let tauByBeatMsOut: number[] = [];
  const matchedProximal: number[] = [];
  if (
    Array.isArray(options.proximalPeakIndices) &&
    Array.isArray(options.distalPeakIndices) &&
    options.proximalPeakIndices.length > 0 &&
    options.distalPeakIndices.length > 0
  ) {
    const pairs = onsetPairs(
      proxSeries,
      distSeries,
      options.proximalPeakIndices,
      options.distalPeakIndices,
      fs,
      lagMinS2,
      lagMaxS2,
    );
    const taus = pairs.map((p) => p.tauSamples);
    if (taus.length >= MIN_BEATS_FOR_ONSET) {
      const center = median(taus);
      const tolS = (BEAT_RESIDUAL_TOLERANCE_MS / 1000) * fs;
      const acceptedTaumS: number[] = [];
      for (let i = 0; i < pairs.length; i++) {
        if (Math.abs(taus[i] - center) <= tolS) {
          acceptedTaumS.push(taus[i]);
          matchedProximal.push(pairs[i].proximalPeakIdx);
        }
      }
      beatsAgreed = acceptedTaumS.length;
      if (beatsAgreed >= MIN_BEATS_FOR_ONSET) {
        tauByBeatMsOut = acceptedTaumS.map((s) => (s / fs) * 1000);
        onsetLagMs = (median(acceptedTaumS) / fs) * 1000;
      }
    }
  }

  // ── Fusión de estimadores ──
  const candidates: TimingCandidate[] = [];
  if (onsetLagMs !== null) candidates.push({ tau: onsetLagMs, source: 'onset' });
  if (gccLagMs !== null) candidates.push({ tau: gccLagMs, source: 'gcc' });

  const windowSeconds = n / fs;
  const rejectionResult = (reason: string): CrossSiteTimingResult => ({
    ...base,
    quality: qualityScore(mscMean, 0, beatsAgreed, windowSeconds, false, true),
    reason,
    spectralCoherence: mscMean,
    gccLagMs,
    onsetLagMs,
    beatsAgreed,
    matchedProximalPeakIndices: matchedProximal,
    tauByBeatMs: tauByBeatMsOut,
  });

  if (candidates.length === 0) return rejectionResult('NO_TIMING_EVIDENCE');

  let divergenceFlagged = false;
  let agreement01 = 1;
  let finalTauMs: number;
  if (candidates.length >= 2) {
    const delta = Math.abs(candidates[0].tau - candidates[1].tau);
    if (delta <= maxDivMs / 3) {
      agreement01 = clamp(1 - delta / maxDivMs, 0, 1);
      finalTauMs = median(candidates.map((c) => c.tau));
    } else if (delta <= maxDivMs) {
      agreement01 = clamp(1 - delta / maxDivMs, 0, 1);
      finalTauMs = median(candidates.map((c) => c.tau));
      divergenceFlagged = true;
    } else {
      // Divergencia fuerte: gana el camino con evidencia morfológica por latido
      agreement01 = 0;
      finalTauMs = candidates[0].source === 'onset' ? candidates[0].tau : candidates[1].tau;
      // El 'gcc' salvo onset: si el ganador es gcc, continuar igual (deducida arriba)
      divergenceFlagged = true;
    }
  } else {
    finalTauMs = candidates[0].tau;
    agreement01 = 0.5;
  }

  if (finalTauMs < minTauMs || finalTauMs > maxTauMs) {
    return rejectionResult('PHYSIOLOGICAL_RANGE');
  }

  const q = qualityScore(mscMean, agreement01, beatsAgreed, windowSeconds, divergenceFlagged, candidates.length < 2);
  if (q < 35) {
    return {
      ...base,
      quality: q,
      reason: 'LOW_EVIDENCE_QUALITY',
      spectralCoherence: mscMean,
      gccLagMs,
      onsetLagMs,
      beatsAgreed,
      matchedProximalPeakIndices: matchedProximal,
      tauByBeatMs: tauByBeatMsOut,
    };
  }
  const confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW' = q >= 75 ? 'HIGH' : q >= 55 ? 'MEDIUM' : 'LOW';
  return {
    tauMs: finalTauMs,
    quality: q,
    confidenceLevel,
    reason: divergenceFlagged ? 'OK_DIVERGENCE_FLAGGED' : 'OK',
    gccLagMs,
    onsetLagMs,
    beatsAgreed,
    spectralCoherence: mscMean,
    matchedProximalPeakIndices: matchedProximal,
    tauByBeatMs: tauByBeatMsOut,
  };
}
