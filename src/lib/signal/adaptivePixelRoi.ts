import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { SPATIAL_OBSERVATION_DEFAULTS as S } from '@/config/signalProcessing';
import { clamp } from '@/utils/math';

/**
 * ROI adaptativo con fotometría de escena y observaciones espaciales separadas.
 *
 * Cada sitio de tejido observado consecutivamente mantiene una estimación de:
 *
 *   OD_t   = -ln((I_t + 1) / 256)          (densidad óptica, Beer-Lambert)
 *   ΔOD_t  = OD_t - OD_{t-1}                (absorbancia diferencial)
 *   AC/DC  = sqrt(2·Var(OD)) / |media(OD)|  (índice de perfusión espectral)
 *
 * La máscara fisiológica aporta evidencia, sin seleccionar ni ponderar el
 * RGB de escena. El pulso compara cada píxel con su DC medido y con el mismo
 * píxel del cuadro anterior. El consenso entre regiones limita la influencia
 * de cambios locales de soporte. La máscara de tejido guía el seguimiento y
 * el movimiento independientemente de la fase del pulso.
 *
 * Los arrays por píxel y región se reutilizan. Una interrupción de exposición,
 * tejido o captura invalida la historia de ese sitio; no se integra señal en
 * intervalos sin observaciones. La transformación logarítmica es una medida
 * relativa sobre bytes de cámara, no una calibración de Beer–Lambert del ISP.
 */

const P = VITAL_THRESHOLDS.PIXEL_ROI;
const F = VITAL_THRESHOLDS.FINGER;

export interface AdaptivePixelRoiFrame {
  spatialObservation: SpatialObservation;
  rawRed: number;
  rawGreen: number;
  rawBlue: number;
  coverageRatio: number;
  fingerScore: number;
  fingerRegionCount: number;
  effectivePixels: number;
  physiologicalPixels: number;
  sampledPixels: number;
  /**
   * SELLADO ÓPTICO [0..1]: fracción del área explorada ocupada por tejido del
   * dedo (dominancia roja), sin exigir pulsatilidad. Responde "¿la yema cubre
   * la lente?" y es la entrada de "cobertura" del modelo de presión.
   */
  tissueRatio: number;
  /** DC rojo medio de los píxeles de tejido (escala 0–255 del sensor). */
  tissueRed: number;
  /** Fracción de píxeles de tejido que además tienen AC/DC fisiológico. */
  perfusionRatio: number;
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

export interface SpatialChannelObservation {
  valid: boolean;
  /** Both means use exactly the same consecutive pixel coordinates. */
  current: number;
  previous: number;
  /** Spatial median of measured log(current / previous), with a one-count offset. */
  fractionalChange: number;
  /** Current absorbance relative to each consecutive pixel's measured slow DC. */
  pulse: number;
}

export interface SpatialObservation {
  valid: boolean;
  epoch: number;
  overlapRatio: number;
  matchedPixels: number;
  regionCount: number;
  regionAgreement: number;
  red: SpatialChannelObservation;
  green: SpatialChannelObservation;
  blue: SpatialChannelObservation;
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

/**
 * The scene mean describes the current image. Pulse observations compare the
 * same sensor coordinates, independently of physiological-mask membership.
 * New or re-entered sites start a fresh DC history; changing spatial support
 * therefore cannot turn differences between pixel DC levels into a heartbeat.
 */
export class AdaptivePixelRoi {
  private width = 0;
  private height = 0;
  private stride = 0;
  private gridW = 0;
  private gridH = 0;
  private frameNumber = 0;
  private lastTimestamp: number | null = null;
  private epoch = 1;
  private observationWasValid = false;
  private previousObservablePixels = 0;

  private meanOd = new Float32Array(0);
  private varOd = new Float32Array(0);
  private samples = new Uint16Array(0);
  private seen = new Uint32Array(0);
  private previousRed = new Uint8Array(0);
  private previousGreen = new Uint8Array(0);
  private previousBlue = new Uint8Array(0);
  private baselineRed = new Float32Array(0);
  private baselineGreen = new Float32Array(0);
  private baselineBlue = new Float32Array(0);
  private effectiveMask = new Uint8Array(0);
  private prevMask = new Uint8Array(0);
  private hasPrevMask = false;
  private prevPixels = 0;
  private prevCx = 0;
  private prevCy = 0;
  private trackedX = 0.5;
  private trackedY = 0.5;
  private penaltyEma = 0;

  private readonly regionSize = S.regionColumns * S.regionRows;
  private readonly regionCounts = new Uint32Array(this.regionSize);
  private readonly regionBlueCounts = new Uint32Array(this.regionSize);
  // RGB current, previous, log change and baseline-relative absorbance.
  private readonly regionValues = new Float64Array(this.regionSize * 12);
  private readonly medianScratch = new Float64Array(this.regionSize);

  reset(): void {
    this.clearHistory();
    this.trackedX = 0.5;
    this.trackedY = 0.5;
    this.lastTimestamp = null;
    this.epoch++;
  }

  private clearHistory(): void {
    this.meanOd.fill(0);
    this.varOd.fill(0);
    this.samples.fill(0);
    this.seen.fill(0);
    this.effectiveMask.fill(0);
    this.prevMask.fill(0);
    this.frameNumber = 0;
    this.previousObservablePixels = 0;
    this.observationWasValid = false;
    this.hasPrevMask = false;
    this.prevPixels = 0;
    this.prevCx = 0;
    this.prevCy = 0;
    this.penaltyEma = 0;
  }

  processFrame(imageData: ImageData, stride = 3, timestampMs?: number): AdaptivePixelRoiFrame {
    const width = imageData.width;
    const height = imageData.height;
    const s = clamp(Math.round(stride), 1, 16);
    this.ensureBuffers(width, height, s);
    let intervalMs = S.nominalFrameIntervalMs;
    if (timestampMs !== undefined && Number.isFinite(timestampMs)) {
      if (this.lastTimestamp !== null) {
        const elapsed = timestampMs - this.lastTimestamp;
        if (elapsed <= 0 || elapsed > S.maxFrameGapMs) {
          this.clearHistory();
          this.epoch++;
        } else intervalMs = elapsed;
      }
      this.lastTimestamp = timestampMs;
    }
    this.frameNumber++;
    const statisticsAlpha = 1 - Math.exp(-intervalMs / S.statisticsTimeConstantMs);
    const baselineAlpha = 1 - Math.exp(-intervalMs / S.baselineTimeConstantMs);
    const data = imageData.data;
    const scanSide = Math.max(32, Math.floor(Math.min(width, height) * F.ROI_SIZE_FRACTION));
    const startX = clamp(Math.floor(this.trackedX * width - scanSide / 2), 0, Math.max(0, width - scanSide));
    const startY = clamp(Math.floor(this.trackedY * height - scanSide / 2), 0, Math.max(0, height - scanSide));
    const endX = Math.min(width, startX + scanSide);
    const endY = Math.min(height, startY + scanSide);
    const gx0 = Math.max(0, Math.ceil(startX / s));
    const gy0 = Math.max(0, Math.ceil(startY / s));
    const gx1 = Math.min(this.gridW - 1, Math.floor((endX - 1) / s));
    const gy1 = Math.min(this.gridH - 1, Math.floor((endY - 1) / s));
    this.effectiveMask.fill(0);
    this.regionCounts.fill(0);
    this.regionBlueCounts.fill(0);
    this.regionValues.fill(0);
    let sampled = 0, exposed = 0, saturated = 0, underexposed = 0;
    let nonPhysiological = 0, physiologicalPixels = 0;
    let tissuePixels = 0, tissueRedSum = 0, tissueEvaluated = 0, tissuePerfused = 0;
    let redSum = 0, greenSum = 0, blueSum = 0, qualitySum = 0;
    let sumX = 0, sumY = 0, minX = width, minY = height, maxX = -1, maxY = -1;
    let observablePixels = 0, matchedPixels = 0, blueMatchedPixels = 0;
    const matchedCurrent = [0, 0, 0];
    const matchedPrevious = [0, 0, 0];

    for (let gy = gy0; gy <= gy1; gy++) {
      const y = gy * s;
      for (let gx = gx0; gx <= gx1; gx++) {
        const x = gx * s;
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const idx = gy * this.gridW + gx;
        sampled++;
        const dominance = r - (g + b) * 0.5;
        const isTissue = dominance >= P.TISSUE_DOMINANCE_MIN && r >= P.TISSUE_RED_MIN && g >= P.TISSUE_GREEN_MIN;
        if (isTissue) {
          tissuePixels++;
          tissueRedSum += r;
          sumX += x; sumY += y;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          this.effectiveMask[idx] = 1;
        }
        if (r >= P.SATURATION_RED) { saturated++; continue; }
        if (r <= P.UNDEREXPOSED_RED) { underexposed++; continue; }
        exposed++;
        redSum += r; greenSum += g; blueSum += b;
        // Blue can be dark or clipped under torch while R/G still carry pulse.
        const observable = isTissue && g > 0 && g < 255;
        const consecutive = observable && this.seen[idx] === this.frameNumber - 1 && this.samples[idx] > 0;
        const blueConsecutive = consecutive && b > 0 && b < 255 && this.previousBlue[idx] > 0 && this.previousBlue[idx] < 255;
        const od = opticalDensity(g);
        const n = consecutive ? this.samples[idx] : 0;
        let mean = n > 0 ? this.meanOd[idx] : od;
        let variance = n > 0 ? this.varOd[idx] : 0;
        if (n > 0) {
          const d = od - mean;
          mean += statisticsAlpha * d;
          variance = (1 - statisticsAlpha) * (variance + statisticsAlpha * d * d);
        }
        const acdc = perfusionIndexFromOpticalDensity(mean, variance);
        qualitySum += 0.55 * clamp(acdc / P.AC_DC_MAX, 0, 1) + 0.30 * clamp(dominance / 80, 0, 1) + 0.15 * clamp((Math.min(r, g, b) - 8) / 140, 0, 1);
        if (!observable) continue;
        observablePixels++;
        tissueEvaluated++;
        if (consecutive) {
          matchedPixels++;
          const region = Math.min(S.regionRows - 1, Math.floor(y * S.regionRows / height)) * S.regionColumns + Math.min(S.regionColumns - 1, Math.floor(x * S.regionColumns / width));
          this.regionCounts[region]++;
          const offset = region * 12;
          this.regionValues[offset] += r;
          this.regionValues[offset + 1] += g;
          this.regionValues[offset + 3] += this.previousRed[idx];
          this.regionValues[offset + 4] += this.previousGreen[idx];
          this.regionValues[offset + 6] += opticalDensity(this.previousRed[idx]) - opticalDensity(r);
          this.regionValues[offset + 7] += opticalDensity(this.previousGreen[idx]) - od;
          this.regionValues[offset + 9] += Math.log((this.baselineRed[idx] + 1) / (r + 1));
          this.regionValues[offset + 10] += Math.log((this.baselineGreen[idx] + 1) / (g + 1));
          matchedCurrent[0] += r; matchedCurrent[1] += g;
          matchedPrevious[0] += this.previousRed[idx]; matchedPrevious[1] += this.previousGreen[idx];
          if (blueConsecutive) {
            blueMatchedPixels++;
            this.regionBlueCounts[region]++;
            this.regionValues[offset + 2] += b;
            this.regionValues[offset + 5] += this.previousBlue[idx];
            this.regionValues[offset + 8] += opticalDensity(this.previousBlue[idx]) - opticalDensity(b);
            this.regionValues[offset + 11] += Math.log((this.baselineBlue[idx] + 1) / (b + 1));
            matchedCurrent[2] += b;
            matchedPrevious[2] += this.previousBlue[idx];
          }
        }
        this.baselineRed[idx] = consecutive ? this.baselineRed[idx] + baselineAlpha * (r - this.baselineRed[idx]) : r;
        this.baselineGreen[idx] = consecutive ? this.baselineGreen[idx] + baselineAlpha * (g - this.baselineGreen[idx]) : g;
        this.baselineBlue[idx] = blueConsecutive ? this.baselineBlue[idx] + baselineAlpha * (b - this.baselineBlue[idx]) : b;
        this.previousRed[idx] = r; this.previousGreen[idx] = g; this.previousBlue[idx] = b;
        this.meanOd[idx] = mean; this.varOd[idx] = variance;
        this.samples[idx] = Math.min(65535, n + 1);
        this.seen[idx] = this.frameNumber;
        if (n + 1 >= P.MIN_STAT_SAMPLES) {
          if (acdc >= P.AC_DC_MIN && acdc <= P.AC_DC_MAX) { physiologicalPixels++; tissuePerfused++; }
          else nonPhysiological++;
        }
      }
    }

    let regionCount = 0, blueRegionCount = 0;
    for (let region = 0; region < this.regionSize; region++) {
      const count = this.regionCounts[region];
      if (count >= S.minRegionPixels) regionCount++;
      const blueCount = this.regionBlueCounts[region];
      if (blueCount >= S.minRegionPixels) blueRegionCount++;
      for (let c = 0; c < 12; c++) {
        const channelCount = c % 3 === 2 ? blueCount : count;
        if (channelCount > 0) this.regionValues[region * 12 + c] /= channelCount;
      }
    }
    const channel = (c: number): SpatialChannelObservation => {
      const count = c === 2 ? blueMatchedPixels : matchedPixels;
      return {
        valid: count >= S.minMatchedPixels && (c === 2 ? blueRegionCount : regionCount) >= S.minRegions,
        current: count > 0 ? matchedCurrent[c] / count : 0,
        previous: count > 0 ? matchedPrevious[c] / count : 0,
        fractionalChange: this.regionMedian(6 + c),
        pulse: this.regionMedian(9 + c),
      };
    };
    const red = channel(0), green = channel(1), blue = channel(2);
    let coherentRegions = 0;
    for (let region = 0; region < this.regionSize; region++) {
      if (this.regionCounts[region] < S.minRegionPixels) continue;
      const offset = region * 12;
      // Agreement is evidence only. Common RGB pulsation remains intact.
      const tolerance = S.regionNoiseFloor + S.regionDisagreementFraction * Math.abs(green.fractionalChange);
      if (Math.abs(this.regionValues[offset + 7] - green.fractionalChange) <= tolerance) coherentRegions++;
    }
    const overlapRatio = matchedPixels / Math.max(1, observablePixels, this.previousObservablePixels);
    const valid = matchedPixels >= S.minMatchedPixels && regionCount >= S.minRegions && overlapRatio >= S.minOverlapRatio;
    if (!valid && this.observationWasValid) this.epoch++;
    this.observationWasValid = valid;
    this.previousObservablePixels = observablePixels;
    const spatialObservation: SpatialObservation = {
      valid, epoch: this.epoch, overlapRatio, matchedPixels, regionCount,
      regionAgreement: regionCount > 0 ? coherentRegions / regionCount : 0,
      red, green, blue,
    };

    let correlation = 1, shiftPx = 0;
    if (this.hasPrevMask) {
      // The full old/new union includes support that left the moving scan.
      correlation = maskTemporalCorrelation(this.effectiveMask, this.prevMask);
      if (this.prevPixels > 0 && tissuePixels > 0) shiftPx = Math.hypot(sumX / tissuePixels - this.prevCx, sumY / tissuePixels - this.prevCy);
    }
    this.penaltyEma += P.PENALTY_SMOOTH_ALPHA * (displacementPenaltyFrom(correlation, shiftPx, scanSide) - this.penaltyEma);
    let roiX = startX, roiY = startY, roiW = Math.max(1, endX - startX), roiH = Math.max(1, endY - startY);
    if (tissuePixels > 0) {
      const margin = Math.max(2, Math.floor(scanSide * P.ROI_MARGIN_FRACTION));
      roiX = clamp(minX - margin, 0, width - 1); roiY = clamp(minY - margin, 0, height - 1);
      roiW = clamp(maxX + s + margin, roiX + 1, width) - roiX;
      roiH = clamp(maxY + s + margin, roiY + 1, height) - roiY;
    }
    const centroidX = tissuePixels > 0 ? sumX / tissuePixels / width : this.trackedX;
    const centroidY = tissuePixels > 0 ? sumY / tissuePixels / height : this.trackedY;
    if (tissuePixels > 0) {
      this.trackedX = clamp(this.trackedX + clamp(centroidX - this.trackedX, -P.CENTER_MAX_STEP, P.CENTER_MAX_STEP) * P.CENTER_TRACK_ALPHA, 0.15, 0.85);
      this.trackedY = clamp(this.trackedY + clamp(centroidY - this.trackedY, -P.CENTER_MAX_STEP, P.CENTER_MAX_STEP) * P.CENTER_TRACK_ALPHA, 0.15, 0.85);
    } else {
      this.trackedX += (0.5 - this.trackedX) * 0.04;
      this.trackedY += (0.5 - this.trackedY) * 0.04;
    }
    const tmp = this.prevMask; this.prevMask = this.effectiveMask; this.effectiveMask = tmp;
    this.hasPrevMask = true; this.prevPixels = tissuePixels;
    this.prevCx = tissuePixels > 0 ? sumX / tissuePixels : 0;
    this.prevCy = tissuePixels > 0 ? sumY / tissuePixels : 0;
    return {
      spatialObservation,
      rawRed: exposed > 0 ? redSum / exposed : 0,
      rawGreen: exposed > 0 ? greenSum / exposed : 0,
      rawBlue: exposed > 0 ? blueSum / exposed : 0,
      coverageRatio: sampled > 0 ? exposed / sampled : 0,
      fingerScore: exposed > 0 ? qualitySum / exposed : 0,
      fingerRegionCount: sampled > 0 ? Math.min(25, Math.floor(exposed * 25 / sampled)) : 0,
      effectivePixels: exposed, physiologicalPixels, sampledPixels: sampled,
      tissueRatio: sampled > 0 ? tissuePixels / sampled : 0,
      tissueRed: tissuePixels > 0 ? tissueRedSum / tissuePixels : 0,
      perfusionRatio: tissueEvaluated > 0 ? tissuePerfused / tissueEvaluated : 0,
      roiX, roiY, roiW, roiH, centroidX, centroidY, trackedX: this.trackedX, trackedY: this.trackedY,
      centroidMotion: clamp(shiftPx / Math.max(1, scanSide * 0.15), 0, 1),
      maskCorrelation: correlation, displacementPenalty: this.penaltyEma,
      excludedSaturated: saturated, excludedUnderexposed: underexposed,
      excludedNonPhysiological: nonPhysiological,
    };
  }

  private regionMedian(column: number): number {
    let n = 0;
    for (let region = 0; region < this.regionSize; region++) {
      const count = column % 3 === 2 ? this.regionBlueCounts[region] : this.regionCounts[region];
      if (count < S.minRegionPixels) continue;
      const value = this.regionValues[region * 12 + column];
      let i = n;
      while (i > 0 && this.medianScratch[i - 1] > value) {
        this.medianScratch[i] = this.medianScratch[i - 1]; i--;
      }
      this.medianScratch[i] = value; n++;
    }
    return n > 0 ? n % 2 ? this.medianScratch[n >> 1] : (this.medianScratch[(n >> 1) - 1] + this.medianScratch[n >> 1]) * 0.5 : 0;
  }

  private ensureBuffers(width: number, height: number, stride: number): void {
    if (this.width === width && this.height === height && this.stride === stride && this.meanOd.length > 0) return;
    this.width = width; this.height = height; this.stride = stride;
    this.gridW = Math.max(1, Math.ceil(width / stride)); this.gridH = Math.max(1, Math.ceil(height / stride));
    const size = this.gridW * this.gridH;
    this.meanOd = new Float32Array(size); this.varOd = new Float32Array(size);
    this.samples = new Uint16Array(size); this.seen = new Uint32Array(size);
    this.previousRed = new Uint8Array(size); this.previousGreen = new Uint8Array(size); this.previousBlue = new Uint8Array(size);
    this.baselineRed = new Float32Array(size); this.baselineGreen = new Float32Array(size); this.baselineBlue = new Float32Array(size);
    this.effectiveMask = new Uint8Array(size); this.prevMask = new Uint8Array(size);
    this.clearHistory(); this.epoch++;
  }
}
