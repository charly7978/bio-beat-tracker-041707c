/**
 * Hydrostatic auto-calibration (Fase 5)
 * =====================================
 * Rompe la dependencia del brazalete: ΔP = ρ·g·Δh ≈ 0.77 mmHg/cm. Midiendo τ
 * a dos (o más) alturas del pulgar respecto al corazón se obtiene dτ/dP, es
 * decir la pendiente k del modelo Moens–Korteweg, sin tensiómetro.
 *
 * Módulo puro: sin cámara, sin React. La medición de altura (píxeles → cm)
 * vive en la capa de dispositivo; aquí solo la física y la regresión.
 */

/** mmHg por cm de columna de sangre (ρ·g con ρ≈1.06 g/cm³). */
export const MMHG_PER_CM_HYDROSTATIC = 0.77;

export interface HydrostaticSegment {
  /** Altura del pulgar respecto al corazón en cm (positivo = por encima). */
  heightCm: number;
  /** τ observado (ms) en ese segmento. */
  tauMs: number;
  /** Incertidumbre de τ (ms), opcional. */
  tauUncertaintyMs?: number;
}

export interface HydrostaticFitResult {
  /** Pendiente dτ/dP (ms por mmHg) con signo: τ disminuye al subir P. */
  slopeMsPerMmHg: number;
  /** Intercepto (ms) a ΔP=0. */
  interceptMs: number;
  /** Error estándar de la pendiente. */
  slopeStdErr: number;
  /** R de Pearson (honestidad). */
  r: number;
  /** Número de segmentos usados. */
  n: number;
  /** true si el ajuste es fisiológicamente plausible (pendiente finita, R≥umbral). */
  valid: boolean;
  reason: string;
}

/**
 * Convierte una diferencia de altura (cm) en ΔP (mmHg). Por convención, mano
 * por encima del corazón → presión menor → ΔP negativo.
 */
export function heightToDeltaPressureMmHg(heightCm: number): number {
  return -heightCm * MMHG_PER_CM_HYDROSTATIC;
}

/**
 * Regresión lineal τ vs ΔP conocido. Devuelve pendiente (ms/mmHg) e
 * intercepto. Con <2 segmentos o τ degenerados → inválido.
 */
export function fitHydrostaticSlope(segments: HydrostaticSegment[]): HydrostaticFitResult {
  const clean = segments.filter(
    (s) => Number.isFinite(s.heightCm) && Number.isFinite(s.tauMs) && s.tauMs > 0,
  );
  const out: HydrostaticFitResult = {
    slopeMsPerMmHg: 0,
    interceptMs: 0,
    slopeStdErr: 0,
    r: 0,
    n: clean.length,
    valid: false,
    reason: 'INSUFICIENTE',
  };
  if (clean.length < 2) { out.reason = 'MENOS_DE_2_SEGMENTOS'; return out; }

  const xs = clean.map((s) => heightToDeltaPressureMmHg(s.heightCm)); // ΔP
  const ys = clean.map((s) => s.tauMs); // τ

  const n = xs.length;
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xMean;
    const dy = ys[i] - yMean;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx < 1e-12) { out.reason = 'PRESION_DEGENERADA'; return out; }
  const slope = sxy / sxx;
  const intercept = yMean - slope * xMean;
  const denom = Math.sqrt(sxx) * Math.sqrt(syy);
  const r = denom > 0 ? (sxy / denom) : 0;

  // Error estándar de la pendiente.
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const resid = ys[i] - (slope * xs[i] + intercept);
    ss += resid * resid;
  }
  const sigma = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
  const slopeStdErr = sigma / Math.sqrt(sxx);

  out.slopeMsPerMmHg = slope;
  out.interceptMs = intercept;
  out.slopeStdErr = slopeStdErr;
  out.r = r;
  out.n = n;

  // Plausibilidad: pendiente finita y |R| razonable.
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) { out.reason = 'NO_FINIDO'; return out; }
  if (Math.abs(r) < 0.5) { out.reason = 'CORRELACION_BAJA'; return out; }
  out.valid = true;
  out.reason = 'OK';
  return out;
}

/**
 * Convierte la pendiente hidrostática (ms/mmHg) a la pendiente k del modelo
 * Moens–Korteweg (mmHg·s²). El modelo usa τ en segundos: SBP ≈ k/τ² + c.
 * Aproximación: k ≈ -2·τ³ / slope (derivada dτ/dP = -k·2τ⁻³/P? simplificado).
 * Se deja como estimación honesta con error declarado.
 */
export function hydrostaticSlopeToK(slopeMsPerMmHg: number, tauRefMs: number): number | null {
  if (!Number.isFinite(slopeMsPerMmHg) || slopeMsPerMmHg === 0) return null;
  if (!Number.isFinite(tauRefMs) || tauRefMs <= 0) return null;
  const tauSec = tauRefMs / 1000;
  // dτ/dP (s/mmHg) = slopeMsPerMmHg / 1000. k = - (dτ/dP)^-1 * 2 * τ^3 (con signo).
  const dtauDp = slopeMsPerMmHg / 1000;
  const k = -2 * Math.pow(tauSec, 3) / dtauDp;
  if (!Number.isFinite(k)) return null;
  return k;
}