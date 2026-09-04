/**
 * Constantes y utilidades fisiológicas.
 * Los rangos RR provienen de VITAL_THRESHOLDS (única fuente de verdad).
 */
import { VITAL_THRESHOLDS } from '../config/vitalThresholds';

export const RR_MIN_MS = VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS;
export const RR_MAX_MS = VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS;

/** Timestamp monotónico de alta resolución (sin riesgo de saltos de reloj). */
export const getMonotonicNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

export function isPhysiologicalRR(ms: number): boolean {
  return ms >= RR_MIN_MS && ms <= RR_MAX_MS;
}

// Cálculos HRV (SDNN, RMSSD, pNN50, CV)
export interface HRVMetrics {
  sdnn: number;
  rmssd: number;
  pnn50: number;
  cv: number;
}

/** HRV con media RR — núcleo único reutilizado por display y detección de arritmias. */
export interface RrHrvMetrics extends HRVMetrics {
  meanRR: number;
}

/**
 * Núcleo HRV (única fuente). Asume `valid` ya filtrado a RR fisiológicos.
 * SDNN poblacional (/n), RMSSD muestral (/(n−1)) — coherente con la literatura
 * y con ambos consumidores (display y detección de arritmias).
 */
export function computeRrHrv(valid: number[]): RrHrvMetrics {
  const n = valid.length;
  if (n < 2) {
    return { meanRR: n === 1 ? valid[0] : 0, sdnn: 0, rmssd: 0, pnn50: 0, cv: 0 };
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += valid[i];
  const meanRR = sum / n;

  let sqSum = 0;
  for (let i = 0; i < n; i++) sqSum += (valid[i] - meanRR) ** 2;
  const sdnn = Math.sqrt(sqSum / n);

  let sumSqDiff = 0;
  let nn50count = 0;
  for (let i = 1; i < n; i++) {
    const diff = Math.abs(valid[i] - valid[i - 1]);
    sumSqDiff += diff * diff;
    if (diff > 50) nn50count++;
  }
  const rmssd = Math.sqrt(sumSqDiff / (n - 1));
  const pnn50 = nn50count / (n - 1);
  const cv = meanRR !== 0 ? sdnn / meanRR : 0;

  return { meanRR, sdnn, rmssd, pnn50, cv };
}

export function calculateHRV(intervals: number[]): HRVMetrics {
  const valid = intervals.filter(isPhysiologicalRR);
  const { sdnn, rmssd, pnn50, cv } = computeRrHrv(valid);
  return { sdnn, rmssd, pnn50, cv };
}

export interface PoincareMetrics {
  sd1: number;
  sd2: number;
  sd1Sd2Ratio: number;
  ellipseArea: number;
}

export interface BaevskyStressMetrics {
  stressIndex: number;
  modeSec: number;
  modeAmplitudePct: number;
  variationRangeSec: number;
  stressLevel: 'RELAXED' | 'NORMAL' | 'ELEVATED' | 'HIGH_STRESS';
}

/**
 * Análisis Geométrico de Poincaré (SD1, SD2, Balance Autonómico y Área Elíptica).
 * Definición estándar de Brennan et al.:
 * SD1 representa variabilidad parasimpática a corto plazo (eje perpendicular al identity line).
 * SD2 representa variabilidad simpática y total a largo plazo (eje a lo largo del identity line).
 */
export function computePoincare(intervals: number[]): PoincareMetrics {
  const valid = intervals.filter(isPhysiologicalRR);
  if (valid.length < 3) {
    return { sd1: 0, sd2: 0, sd1Sd2Ratio: 0, ellipseArea: 0 };
  }

  const n = valid.length - 1;
  const d: number[] = [];
  const s: number[] = [];

  for (let i = 0; i < n; i++) {
    d.push((valid[i + 1] - valid[i]) / Math.SQRT2);
    s.push((valid[i + 1] + valid[i]) / Math.SQRT2);
  }

  const meanD = d.reduce((a, b) => a + b, 0) / n;
  const meanS = s.reduce((a, b) => a + b, 0) / n;

  const varD = d.reduce((acc, v) => acc + (v - meanD) ** 2, 0) / (n - 1 || 1);
  const varS = s.reduce((acc, v) => acc + (v - meanS) ** 2, 0) / (n - 1 || 1);

  const sd1 = Math.sqrt(varD);
  const sd2 = Math.sqrt(varS);
  const sd1Sd2Ratio = sd2 > 0 ? sd1 / sd2 : 0;
  const ellipseArea = Math.PI * sd1 * sd2;

  return { sd1, sd2, sd1Sd2Ratio, ellipseArea };
}

/**
 * Índice de Tensión / Estrés de Baevsky (Baevsky Stress Index, SI).
 * SI = AMo / (2 · Mo · MxDMn)
 * Mo: Moda en segundos (bin width 50 ms).
 * AMo: Amplitud de la moda (% de intervalos en el bin modal).
 * MxDMn: Rango de variación (Max - Min) en segundos.
 */
export function computeBaevskyStressIndex(intervals: number[]): BaevskyStressMetrics {
  const valid = intervals.filter(isPhysiologicalRR);
  if (valid.length < 4) {
    return {
      stressIndex: 0,
      modeSec: 0,
      modeAmplitudePct: 0,
      variationRangeSec: 0,
      stressLevel: 'NORMAL',
    };
  }

  // Histograma con bins de 50 ms
  const binMap: Record<number, number> = {};
  let maxCount = 0;
  let modalBin = 0;
  let minRR = Infinity;
  let maxRR = -Infinity;

  for (const rr of valid) {
    if (rr < minRR) minRR = rr;
    if (rr > maxRR) maxRR = rr;
    const b = Math.floor(rr / 50) * 50;
    const count = (binMap[b] ?? 0) + 1;
    binMap[b] = count;
    if (count > maxCount) {
      maxCount = count;
      modalBin = b;
    }
  }

  const moSec = (modalBin + 25) / 1000; // Centro del bin en segundos
  const amoPct = (maxCount / valid.length) * 100;
  const mxdmnSec = Math.max(0.02, (maxRR - minRR) / 1000); // Mínimo 20 ms para evitar división por cero

  const rawSI = amoPct / (2 * moSec * mxdmnSec);
  const stressIndex = Math.max(0, Math.min(2500, Math.round(rawSI * 10) / 10));

  let stressLevel: BaevskyStressMetrics['stressLevel'] = 'NORMAL';
  if (stressIndex < 50) stressLevel = 'RELAXED';
  else if (stressIndex <= 150) stressLevel = 'NORMAL';
  else if (stressIndex <= 300) stressLevel = 'ELEVATED';
  else stressLevel = 'HIGH_STRESS';

  return {
    stressIndex,
    modeSec: moSec,
    modeAmplitudePct: amoPct,
    variationRangeSec: mxdmnSec,
    stressLevel,
  };
}

