/**
 * Detector de picos sistólicos PPG basado en Elgendi et al. (TERMA canónico + bloques de interés).
 * Implementación de vanguardia SOTA:
 *  - Dos medias móviles de eventos (W1 = pico sistólico ~111 ms, W2 = latido ~600 ms).
 *  - Umbral adaptativo: THR = MA_beat + beta * mean(Energy).
 *  - Búsqueda del máximo local exacto dentro de cada bloque de interés.
 *  - Periodo refractario fisiológico de 280 ms sin descarte erróneo por intervalos largos.
 */
import { PEAK_DETECTION_DEFAULTS } from '../../../config/signalProcessing';
import { VITAL_THRESHOLDS } from '../../../config/vitalThresholds';
import { clamp } from '../../../utils/math';
import { skewness } from '../../../utils/stats';
import {
  detrendLinear,
  hampel1D,
  prepareUniformPpgWindow,
  robustNormalizeZeroCenter,
} from '../shared/dsp';

export interface ElgendiPeakDetectorInput {
  signal: number[];
  timestampsMs: number[];
  /** Fs efectivo (Hz); si no coincide con timestamps se re-muestrea de forma conservadora */
  samplingRateHz: number;
  sqi?: number;
  peakWindowMs?: number;
  beatWindowMs?: number;
  offsetWeight?: number;
  minBpm?: number;
  maxBpm?: number;
  minProminence?: number;
}

export interface ElgendiPeakDetectorOutput {
  peaks: number[];
  peakTimes: number[];
  peakValues: number[];
  confidence: number;
  rejectedCandidates: Array<{ index: number; reason: string }>;
  diagnostics: Record<string, unknown>;
  reason: string;
  parametersUsed: Record<string, number>;
}

/** MA deslizante O(n) con suma acumulativa, escribe en `out` pre-asignado. */
function slidingMA(x: number[], win: number, out: number[]): void {
  const n = x.length;
  if (n === 0 || win < 1) return;
  const half = Math.floor(win / 2);
  let sum = 0;
  let c = 0;
  for (let i = -half; i <= half; i++) {
    if (i >= 0 && i < n) { sum += x[i]; c++; }
  }
  out[0] = sum / c;
  for (let i = 1; i < n; i++) {
    const removeIdx = i - half - 1;
    if (removeIdx >= 0) { sum -= x[removeIdx]; c--; }
    const addIdx = i + half;
    if (addIdx < n) { sum += x[addIdx]; c++; }
    out[i] = c > 0 ? sum / c : x[i];
  }
}

export class ElgendiPeakDetector {
  static detect(input: ElgendiPeakDetectorInput): ElgendiPeakDetectorOutput {
    const minBpm = input.minBpm ?? PEAK_DETECTION_DEFAULTS.minBpm;
    const maxBpm = input.maxBpm ?? PEAK_DETECTION_DEFAULTS.maxBpm;
    const peakMs = input.peakWindowMs ?? PEAK_DETECTION_DEFAULTS.peakWindowMs;
    const beatMs = input.beatWindowMs ?? PEAK_DETECTION_DEFAULTS.beatWindowMs;
    const offsetW = input.offsetWeight ?? PEAK_DETECTION_DEFAULTS.offsetWeight;
    const minProm = input.minProminence ?? PEAK_DETECTION_DEFAULTS.minProminence;
    const nSig = input.signal.length;

    if (nSig !== input.timestampsMs.length || nSig < PEAK_DETECTION_DEFAULTS.minSamplesEnsemble) {
      return {
        peaks: [], peakTimes: [], peakValues: [],
        confidence: 0, rejectedCandidates: [],
        diagnostics: { stage: 'insufficient_input' },
        reason: 'INSUFFICIENT_WINDOW',
        parametersUsed: { minBpm, maxBpm, peakMs, beatMs, offsetW, minProm, fs: input.samplingRateHz },
      };
    }

    const uniform = prepareUniformPpgWindow(input.signal, input.timestampsMs, input.samplingRateHz);
    const sig = uniform.signal;
    const ts = uniform.timestampsMs;
    const fs = uniform.samplingRateHz;
    const n = sig.length;

    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(sig[i])) {
        return {
          peaks: [], peakTimes: [], peakValues: [],
          confidence: 0, rejectedCandidates: [],
          diagnostics: { nonFinite: true },
          reason: 'NO_VALID_SIGNAL',
          parametersUsed: { minBpm, maxBpm, peakMs, beatMs, offsetW, minProm, fs },
        };
      }
    }

    // Acondicionamiento canónico Elgendi: filtro Hampel contra spikes + detrending lineal + normalización
    const hampelWin = Math.max(5, Math.round(fs * 0.25) | 1);
    const cleaned = hampel1D(sig, hampelWin, 3);
    const detrended = detrendLinear(cleaned);
    const x = robustNormalizeZeroCenter(detrended);

    const signalSkewness = skewness(x);

    // Ventanas temporales TERMA
    const w1 = Math.max(3, Math.round((peakMs / 1000) * fs));
    const w2 = Math.max(w1 + 2, Math.round((beatMs / 1000) * fs));

    // Cuadrado de la señal positiva (realza los picos sistólicos sobre la línea base)
    const energy = new Array<number>(n);
    let meanEnergy = 0;
    for (let i = 0; i < n; i++) {
      const p = x[i] > 0 ? x[i] : 0;
      const e = p * p;
      energy[i] = e;
      meanEnergy += e;
    }
    meanEnergy = n > 0 ? meanEnergy / n : 0;

    const maPeak = new Array<number>(n);
    const maBeat = new Array<number>(n);
    slidingMA(energy, w1, maPeak);
    slidingMA(energy, w2, maBeat);

    // Umbral adaptativo Elgendi
    const beta = PEAK_DETECTION_DEFAULTS.beatOffset * (offsetW / PEAK_DETECTION_DEFAULTS.offsetWeight);
    const thrOffset = beta * meanEnergy;

    const thr = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      thr[i] = maBeat[i] + thrOffset;
    }

    const minBlock = Math.max(2, Math.round(w1 * 0.8));
    const maxDist = Math.max(minBlock + 2, Math.round((60000 / minBpm / 1000) * fs));
    const maxBlock = Math.ceil(maxDist * 1.5);
    const minDist = Math.max(2, Math.round((60000 / maxBpm / 1000) * fs));
    const maxPeaks = Math.ceil(n / minDist) + 2;

    // Detección de bloques de interés donde maPeak > thr
    const blocks: Array<{ start: number; end: number }> = [];
    let i = 0;
    while (i < n) {
      if (maPeak[i] <= thr[i]) { i++; continue; }
      const start = i;
      while (i < n && maPeak[i] > thr[i]) i++;
      const end = i - 1;
      const len = end - start + 1;
      if (len >= minBlock && len <= maxBlock) {
        blocks.push({ start, end });
      }
    }

    const rejectedCandidates: Array<{ index: number; reason: string }> = [];
    const peaks = new Array<number>(maxPeaks);
    const peakTimes = new Array<number>(maxPeaks);
    const peakValues = new Array<number>(maxPeaks);
    const peakProms = new Array<number>(maxPeaks);
    let pk = 0;

    // Periodo refractario fisiológico fijo (~280 ms)
    const refractorySamples = Math.max(3, Math.round((280 / 1000) * fs));

    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      let best = b.start;
      let bestV = x[b.start];
      for (let j = b.start + 1; j <= b.end; j++) {
        if (x[j] > bestV) {
          bestV = x[j];
          best = j;
        }
      }

      // Cálculo de prominencia local
      const left = Math.max(0, best - minDist);
      const right = Math.min(n - 1, best + minDist);
      let localMin = x[best];
      for (let j = left; j <= right; j++) {
        if (x[j] < localMin) localMin = x[j];
      }
      const prom = bestV - localMin;
      if (prom < minProm * 0.4) continue;

      if (pk > 0) {
        const prev = peaks[pk - 1];
        const dist = best - prev;

        // Comprobación de refractario
        if (dist < refractorySamples) {
          // Si dos candidatos están dentro del refractario, conservar el de mayor altura
          if (x[best] > x[prev]) {
            peaks[pk - 1] = best;
            peakTimes[pk - 1] = ts[best] ?? ts[ts.length - 1];
            peakValues[pk - 1] = sig[best] ?? 0;
            peakProms[pk - 1] = prom;
          }
          continue;
        }
      }

      peaks[pk] = best;
      peakTimes[pk] = ts[best] ?? ts[ts.length - 1];
      peakValues[pk] = sig[best] ?? 0;
      peakProms[pk] = prom;
      pk++;
    }

    // Filtrado de picos por amplitud relativa sólo ante artefactos evidentes
    if (pk >= 4) {
      const promsSorted = peakProms.slice(0, pk).sort((a, b) => a - b);
      const medProm = promsSorted[Math.floor(promsSorted.length / 2)] ?? 0;
      const promFloor = medProm * 0.20;
      const promCeil = medProm * 3.8;

      if (medProm > 0) {
        let w = 0;
        for (let r = 0; r < pk; r++) {
          if (peakProms[r] >= promFloor && peakProms[r] <= promCeil) {
            peaks[w] = peaks[r];
            peakTimes[w] = peakTimes[r];
            peakValues[w] = peakValues[r];
            w++;
          } else {
            rejectedCandidates.push({
              index: peaks[r],
              reason: peakProms[r] > promCeil ? 'HIGH_REL_AMPLITUDE' : 'LOW_REL_AMPLITUDE',
            });
          }
        }
        pk = w;
      }
    }

    const outPeaks = peaks.slice(0, pk);
    const outPeakTimes = peakTimes.slice(0, pk);
    const outPeakValues = peakValues.slice(0, pk);

    // RR intervals
    const maxRR = pk > 0 ? pk - 1 : 0;
    const rr = new Array<number>(maxRR);
    let rrCount = 0;
    for (let k = 1; k < pk; k++) {
      const d = outPeakTimes[k] - outPeakTimes[k - 1];
      if (d >= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS && d <= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS) {
        rr[rrCount++] = d;
      }
    }
    const rrTrim = rr.slice(0, rrCount);

    let rrRegularity = 0;
    if (rrCount >= 3) {
      let m = 0;
      for (let k = 0; k < rrCount; k++) m += rrTrim[k];
      m /= rrCount;
      let v = 0;
      for (let k = 0; k < rrCount; k++) v += (rrTrim[k] - m) ** 2;
      v /= rrCount;
      const cv = Math.sqrt(v) / Math.max(1, m);
      rrRegularity = clamp(1 - cv / 0.40, 0, 1);
    }

    let confidence = rrCount > 0
      ? clamp(rrCount / 4, 0, 1) * 0.45 +
        clamp(pk / 5, 0, 1) * 0.35 +
        rrRegularity * 0.20
      : (pk > 0 ? 0.65 : 0);

    if (typeof input.sqi === 'number' && input.sqi < PEAK_DETECTION_DEFAULTS.minSQI) {
      confidence *= 0.7;
    }

    return {
      peaks: outPeaks,
      peakTimes: outPeakTimes,
      peakValues: outPeakValues,
      confidence: clamp(confidence, 0, 1),
      rejectedCandidates,
      diagnostics: {
        blocks: blocks.length,
        resampled: uniform.resampled,
        fsEffective: fs,
        rrCount,
        meanEnergy,
        thrOffset,
        signalSkewness,
      },
      reason: pk > 0 ? 'OK' : 'NO_PEAKS',
      parametersUsed: { minBpm, maxBpm, peakMs, beatMs, offsetW, beta, minProm, fs, w1, w2 },
    };
  }
}
