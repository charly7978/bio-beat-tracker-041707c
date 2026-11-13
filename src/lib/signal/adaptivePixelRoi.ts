import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { clamp } from '@/utils/math';

/**
 * ROI ADAPTATIVO POR PÍXEL — MÁSCARA BEER-LAMBERT DIFERENCIAL.
 *
 * Sustituye el ROI rígido y la fusión fija por celdas. Cada sitio muestreado
 * mantiene una estimación online de:
 *
 *   OD_t   = -ln((I_t + 1) / 256)          (densidad óptica, Beer-Lambert)
 *   ΔOD_t  = OD_t - OD_{t-1}                (absorbancia diferencial)
 *   AC/DC  = sqrt(2·Var(OD)) / |media(OD)|  (índice de perfusión espectral)
 *
 * La máscara de cada frame:
 *   1. Excluye píxeles saturados (R ≥ 250) y subexpuestos (R ≤ 15).
 *   2. Excluye píxeles cuyo AC/DC queda fuera de 0.1%–3%.
 *   3. Pondera la señal agregada por pulsatilidad OD y |ΔOD| actual.
 *   4. Compara la máscara con la del frame anterior (Jaccard + desplazamiento
 *      de centroide) para penalizar el movimiento del dedo antes de que la
 *      señal llegue al detector de latidos.
 *
 * Todo el estado vive en arrays tipados reutilizados: el hot path no asigna
 * memoria por frame. El fallback de exposición válida solo actúa cuando aún no
 * hay evidencia fisiológica suficiente; el resto del pipeline sigue exigiendo
 * perfusión real antes de publicar un latido.
 */

const P = VITAL_THRESHOLDS.PIXEL_ROI;
const F = VITAL_THRESHOLDS.FINGER;

export interface AdaptivePixelRoiFrame {
  rawRed: number;
  rawGreen: number;
  rawBlue: number;
  coverageRatio: number;
  fingerScore: number;
  fingerRegionCount: number;
  effectivePixels: number;
  physiologicalPixels: number;
  sampledPixels: number;
  roiX: number;
  roiY: number;
  roiW: number;
  roiH: number;
  centroidX: number;
  centroidY: number;
  trackedX: number;
  trackedY: number;
  centroidMotion: number;
  maskCorrelation: number;
  displacementPenalty: number;
  excludedSaturated: number;
  excludedUnderexposed: number;
  excludedNonPhysiological: number;
}

/** LUT de densidad óptica para las 256 intensidades del sensor. */
const OD_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  OD_LUT[i] = -Math.log((i + 1) / 256);
}

/** Densidad óptica de Beer-Lambert para una intensidad 0–255. */
export function opticalDensity(intensity: number): number {
  const v = intensity < 0 ? 0 : intensity > 255 ? 255 : intensity | 0;
  return OD_LUT[v];
}

/**
 * Índice de perfusión a partir de la OD media y su varianza.
 * Para una oscilación sinusoidal, AC_peak = sqrt(2·Var); el ratio AC/DC queda
 * independiente de la escala de intensidad y directamente comparable con el
 * rango fisiológico 0.1%–3%.
 */
export function perfusionIndexFromOpticalDensity(
  meanOd: number,
  varianceOd: number,
): number {
  const denom = Math.max(1e-6, Math.abs(meanOd));
  return Math.sqrt(Math.max(0, 2 * varianceOd)) / denom;
}

/** Correlación temporal de dos máscaras binarias (Jaccard). */
export function maskTemporalCorrelation(
  current: Uint8Array,
  previous: Uint8Array,
): number {
  const n = Math.min(current.length, previous.length);
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < n; i++) {
    const a = current[i] !== 0;
    const b = previous[i] !== 0;
    if (a || b) {
      union++;
      if (a && b) intersection++;
    }
  }
  if (union === 0) return 1;
  return intersection / union;
}

/** Penalización [0..1] por caída de correlación y desplazamiento de centroide. */
export function displacementPenaltyFrom(
  correlation: number,
  shiftPx: number,
  roiSide: number,
): number {
  const corrPenalty = clamp(
    (1 - correlation) / Math.max(1e-6, 1 - P.MASK_CORRELATION_MIN),
    0,
    1,
  );
  const shiftPenalty = clamp(
    shiftPx / Math.max(1, roiSide * P.SHIFT_PENALTY_FRACTION),
    0,
    1,
  );
  return clamp(
    P.CORRELATION_PENALTY_WEIGHT * corrPenalty +
      P.SHIFT_PENALTY_WEIGHT * shiftPenalty,
    0,
    1,
  );
}

/**
 * Coeficiente de variación temporal (std/mean) de una serie. Se conserva como
 * utilidad de pulsatilidad cruda del canal rojo.
 */
export function redSeriesCoefficientOfVariation(
  samples: ArrayLike<number>,
  count?: number,
): number {
  const n = count ?? samples.length;
  if (n < 10) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += samples[i] as number;
  const mean = sum / n;
  if (!Number.isFinite(mean) || Math.abs(mean) < 1e-4) return 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = (samples[i] as number) - mean;
    sq += d * d;
  }
  const std = Math.sqrt(sq / (n - 1));
  return Number.isFinite(std) ? std / Math.abs(mean) : 0;
}

export class AdaptivePixelRoi {
  private width = 0;
  private height = 0;
  private stride = 0;
  private gridW = 0;
  private gridH = 0;

  private meanOd = new Float32Array(0);
  private varOd = new Float32Array(0);
  private prevOd = new Float32Array(0);
  private samples = new Uint16Array(0);
  private maskLevel = new Uint8Array(0);
  private effectiveMask = new Uint8Array(0);
  private prevMask = new Uint8Array(0);

  private hasPrevMask = false;
  private prevPixels = 0;
  private prevCx = 0;
  private prevCy = 0;

  private trackedX = 0.5;
  private trackedY = 0.5;
  private penaltyEma = 0;

  reset(): void {
    this.meanOd.fill(0);
    this.varOd.fill(0);
    this.prevOd.fill(0);
    this.samples.fill(0);
    this.maskLevel.fill(0);
    this.effectiveMask.fill(0);
    this.prevMask.fill(0);
    this.hasPrevMask = false;
    this.prevPixels = 0;
    this.prevCx = 0;
    this.prevCy = 0;
    this.trackedX = 0.5;
    this.trackedY = 0.5;
    this.penaltyEma = 0;
  }

  processFrame(imageData: ImageData, stride = 3): AdaptivePixelRoiFrame {
    const width = imageData.width;
    const height = imageData.height;
    const s = clamp(Math.round(stride), 1, 16);
    this.ensureBuffers(width, height, s);

    const data = imageData.data;
    const scanSide = Math.max(
      32,
      Math.floor(Math.min(width, height) * F.ROI_SIZE_FRACTION),
    );
    const centerX = this.trackedX * width;
    const centerY = this.trackedY * height;
    const startX = clamp(
      Math.floor(centerX - scanSide / 2),
      0,
      Math.max(0, width - scanSide),
    );
    const startY = clamp(
      Math.floor(centerY - scanSide / 2),
      0,
      Math.max(0, height - scanSide),
    );
    const endX = Math.min(width, startX + scanSide);
    const endY = Math.min(height, startY + scanSide);

    const gx0 = Math.max(0, Math.ceil(startX / s));
    const gy0 = Math.max(0, Math.ceil(startY / s));
    const gx1 = Math.min(this.gridW - 1, Math.floor((endX - 1) / s));
    const gy1 = Math.min(this.gridH - 1, Math.floor((endY - 1) / s));

    this.maskLevel.fill(0);
    this.effectiveMask.fill(0);

    let sampled = 0;
    let exposurePixels = 0;
    let saturated = 0;
    let underexposed = 0;
    let nonPhysiological = 0;

    let rExp = 0;
    let gExp = 0;
    let bExp = 0;
    let qExp = 0;
    let wExp = 0;

    let rPh = 0;
    let gPh = 0;
    let bPh = 0;
    let qPh = 0;
    let wPh = 0;
    let physiologicalPixels = 0;

    for (let gy = gy0; gy <= gy1; gy++) {
      const y = gy * s;
      const row = y * width;
      for (let gx = gx0; gx <= gx1; gx++) {
        const x = gx * s;
        const i = (row + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        sampled++;

        if (r >= P.SATURATION_RED) {
          saturated++;
          continue;
        }
        if (r <= P.UNDEREXPOSED_RED) {
          underexposed++;
          continue;
        }
        exposurePixels++;

        const idx = gy * this.gridW + gx;
        const od = opticalDensity(g);
        const n = this.samples[idx];
        let mean = this.meanOd[idx];
        let variance = this.varOd[idx];
        if (n === 0) {
          mean = od;
          variance = 0;
        } else {
          const delta = od - mean;
          mean += P.OD_EMA_ALPHA * delta;
          variance =
            (1 - P.OD_EMA_ALPHA) * (variance + P.OD_EMA_ALPHA * delta * delta);
        }
        this.meanOd[idx] = mean;
        this.varOd[idx] = variance;
        if (n < 65535) this.samples[idx] = n + 1;

        const acdc = perfusionIndexFromOpticalDensity(mean, variance);
        const piNorm = clamp(acdc / P.AC_DC_MAX, 0, 1);
        const dominance = r - (g + b) * 0.5;
        const dominanceScore = clamp(dominance / 80, 0, 1);
        const exposureScore = clamp((Math.min(r, g, b) - 8) / 140, 0, 1);
        const quality =
          0.55 * piNorm + 0.30 * dominanceScore + 0.15 * exposureScore;

        const activity =
          n > 0
            ? clamp(Math.abs(od - this.prevOd[idx]) / P.DOD_ACTIVITY_REF, 0, 1)
            : 0;
        this.prevOd[idx] = od;

        const wExpInst = 0.35 + quality;
        rExp += r * wExpInst;
        gExp += g * wExpInst;
        bExp += b * wExpInst;
        qExp += quality * wExpInst;
        wExp += wExpInst;

        const stable = n + 1 >= P.MIN_STAT_SAMPLES;
        if (stable && acdc >= P.AC_DC_MIN && acdc <= P.AC_DC_MAX) {
          const wPhInst = 0.25 + 0.5 * piNorm + 0.25 * activity;
          rPh += r * wPhInst;
          gPh += g * wPhInst;
          bPh += b * wPhInst;
          qPh += quality * wPhInst;
          wPh += wPhInst;
          physiologicalPixels++;
          this.maskLevel[idx] = 2;
        } else {
          this.maskLevel[idx] = 1;
          if (stable) nonPhysiological++;
        }
      }
    }

    const usePhysiological =
      physiologicalPixels >= P.MIN_PHYSIOLOGICAL_PIXELS && wPh > 0;
    const rawRed = usePhysiological
      ? rPh / wPh
      : wExp > 0
        ? rExp / wExp
        : 0;
    const rawGreen = usePhysiological
      ? gPh / wPh
      : wExp > 0
        ? gExp / wExp
        : 0;
    const rawBlue = usePhysiological
      ? bPh / wPh
      : wExp > 0
        ? bExp / wExp
        : 0;
    const fingerScore = usePhysiological
      ? qPh / wPh
      : wExp > 0
        ? qExp / wExp
        : 0;
    const effectivePixels = usePhysiological
      ? physiologicalPixels
      : exposurePixels;
    const coverageRatio = sampled > 0 ? effectivePixels / sampled : 0;
    const fingerRegionCount =
      sampled > 0
        ? Math.min(25, Math.floor((effectivePixels * 25) / sampled))
        : 0;
    const maskLevelValue = usePhysiological ? 2 : 1;

    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const idx = gy * this.gridW + gx;
        if (this.maskLevel[idx] !== maskLevelValue) continue;
        this.effectiveMask[idx] = 1;
        const x = gx * s;
        const y = gy * s;
        count++;
        sumX += x;
        sumY += y;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }

    let correlation = 1;
    let shiftPx = 0;
    if (this.hasPrevMask) {
      let intersection = 0;
      let union = 0;
      for (let gy = gy0; gy <= gy1; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const idx = gy * this.gridW + gx;
          const a = this.effectiveMask[idx] !== 0;
          const b = this.prevMask[idx] !== 0;
          if (a || b) {
            union++;
            if (a && b) intersection++;
          }
        }
      }
      if (union >= P.MIN_MASK_PIXELS_FOR_CORRELATION) {
        correlation = intersection / union;
        if (this.prevPixels > 0 && count > 0) {
          const cx = sumX / count;
          const cy = sumY / count;
          shiftPx = Math.hypot(cx - this.prevCx, cy - this.prevCy);
        }
      }
    }

    const instantPenalty = displacementPenaltyFrom(
      correlation,
      shiftPx,
      scanSide,
    );
    this.penaltyEma =
      this.penaltyEma * (1 - P.PENALTY_SMOOTH_ALPHA) +
      instantPenalty * P.PENALTY_SMOOTH_ALPHA;

    let roiX = startX;
    let roiY = startY;
    let roiW = Math.max(1, endX - startX);
    let roiH = Math.max(1, endY - startY);
    if (count > 0) {
      const margin = Math.max(2, Math.floor(scanSide * P.ROI_MARGIN_FRACTION));
      roiX = clamp(minX - margin, 0, width - 1);
      roiY = clamp(minY - margin, 0, height - 1);
      const right = clamp(maxX + s + margin, roiX + 1, width);
      const bottom = clamp(maxY + s + margin, roiY + 1, height);
      roiW = right - roiX;
      roiH = bottom - roiY;
    }

    const centroidX = count > 0 ? sumX / count / width : this.trackedX;
    const centroidY = count > 0 ? sumY / count / height : this.trackedY;
    const centroidMotion = clamp(
      shiftPx / Math.max(1, scanSide * 0.15),
      0,
      1,
    );

    if (count > 0) {
      const stepX = clamp(
        centroidX - this.trackedX,
        -P.CENTER_MAX_STEP,
        P.CENTER_MAX_STEP,
      );
      const stepY = clamp(
        centroidY - this.trackedY,
        -P.CENTER_MAX_STEP,
        P.CENTER_MAX_STEP,
      );
      this.trackedX = clamp(
        this.trackedX + stepX * P.CENTER_TRACK_ALPHA,
        0.15,
        0.85,
      );
      this.trackedY = clamp(
        this.trackedY + stepY * P.CENTER_TRACK_ALPHA,
        0.15,
        0.85,
      );
    } else {
      this.trackedX += (0.5 - this.trackedX) * 0.04;
      this.trackedY += (0.5 - this.trackedY) * 0.04;
    }

    const tmp = this.prevMask;
    this.prevMask = this.effectiveMask;
    this.effectiveMask = tmp;
    this.hasPrevMask = true;
    this.prevPixels = count;
    this.prevCx = count > 0 ? sumX / count : 0;
    this.prevCy = count > 0 ? sumY / count : 0;

    return {
      rawRed,
      rawGreen,
      rawBlue,
      coverageRatio,
      fingerScore,
      fingerRegionCount,
      effectivePixels,
      physiologicalPixels,
      sampledPixels: sampled,
      roiX,
      roiY,
      roiW,
      roiH,
      centroidX,
      centroidY,
      trackedX: this.trackedX,
      trackedY: this.trackedY,
      centroidMotion,
      maskCorrelation: correlation,
      displacementPenalty: this.penaltyEma,
      excludedSaturated: saturated,
      excludedUnderexposed: underexposed,
      excludedNonPhysiological: nonPhysiological,
    };
  }

  private ensureBuffers(width: number, height: number, stride: number): void {
    if (
      this.width === width &&
      this.height === height &&
      this.stride === stride &&
      this.meanOd.length > 0
    ) {
      return;
    }
    this.width = width;
    this.height = height;
    this.stride = stride;
    this.gridW = Math.max(1, Math.ceil(width / stride));
    this.gridH = Math.max(1, Math.ceil(height / stride));
    const size = this.gridW * this.gridH;
    this.meanOd = new Float32Array(size);
    this.varOd = new Float32Array(size);
    this.prevOd = new Float32Array(size);
    this.samples = new Uint16Array(size);
    this.maskLevel = new Uint8Array(size);
    this.effectiveMask = new Uint8Array(size);
    this.prevMask = new Uint8Array(size);
    this.hasPrevMask = false;
    this.prevPixels = 0;
    this.prevCx = 0;
    this.prevCy = 0;
    this.penaltyEma = 0;
  }
}
