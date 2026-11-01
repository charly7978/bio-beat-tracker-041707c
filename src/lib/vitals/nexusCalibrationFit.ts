/**
 * NEXUS CALIBRATION FIT — Ajuste personal del modelo PTT↔PA (F3)
 * ===============================================================
 * Módulo puro (sin React, sin almacenamiento, sin cámara) que convierte los
 * pares (τ, PA de referencia) registrados en hypertensión de brazalete en un
 * modelo personal de la forma clásica de Moens–Korteweg:
 *
 *     SBP ≈ kSbp/τ² + cSbp      DBP ≈ kDbp/τ² + cDbp       (τ en segundos)
 *
 * Ajuste: OLS sobre x = 1/τ² con regularización ridge hacia el prior público
 * (fracción fija; con pocos pares, el prior aporta la escala fisiológica y el
 * ajuste personal corrige alrededor). Devuelve, además, el acuerdo
 * predicción↔referencia por el método de Bland–Altman (d̄ ± 1.96σ, y
 * percentiles p5/p95 con la utilidad compartida del repositorio — sin DSP ni
 * estadística duplicada).
 *
 * Honestidad: con <NEXUS_CALIBRATION_MIN_PAIRS pares o con relación no
 * monótona (β≤0, defying física vascular) NO se produce modelo: el resultado
 * declara el estado y nada se fabrica.
 */

import { robustPercentile } from '@/modules/signal-processing/shared/dsp';
import { clamp } from '@/utils/math';
import {
  UNCALIBRATED_PTT_MODEL,
  pttModelToPressures,
  type PttPersonalModel,
} from './nexusFusionCore';

/** Mínimo de pares (honestidad: con menos no hay línea identificable). */
export const NEXUS_CALIBRATION_MIN_PAIRS = 3;
/** Vigencia del modelo personal (28 días; la relación τ↔PA varía con la salud vascular). */
export const NEXUS_CALIBRATION_VALIDITY_MS = 28 * 24 * 60 * 60 * 1000;
/** Fracción del prior mezclada en el modelo final (blend ridge). */
export const NEXUS_RIDGE_FRACTION = 0.2;
/** Máximo de pares conservados en el registro local (la antiguedad se recorta). */
export const NEXUS_CALIBRATION_PAIRS_MAX = 50;

/** Par de calibración NEXUS: un τ observado con la referencia del brazalete. */
export interface NexusCalibrationPair {
  /** Marca temporal del trío (ms de la línea de tiempo del runtime). */
  timestampMs: number;
  /** Tránsito cara→dedo observado en la insignia NEXUS (ms). */
  tauMs: number;
  /** PA sistólica de referencia (mmHg, tensiómetro de brazo). */
  sbpMmHg: number;
  /** PA diastólica de referencia (mmHg). */
  dbpMmHg: number;
  /** Calidad declarada 0–100 (opcional; se registra, no filtra el fit). */
  quality0to100?: number;
}

export type NexusCalibrationFitStatus =
  /** Ajuste válido: modelo personal listo para registrar. */
  | 'FIT'
  /** Insuficiente: < mínimo de pares. */
  | 'INSUFFICIENT_PAIRS'
  /** Relación degenerada (τ repetidos o pendiente ≤0): no hay física vascular. */
  | 'UNSTABLE_MODEL';

/** Resumen estadístico del ajuste OLS previo al blend ridge. */
export interface NexusCalibrationFitSummary {
  /** Pendientes OLS crudas (mmHg·s²) — antes del blend con el prior. */
  kSbpOls: number;
  cSbpOls: number;
  kDbpOls: number;
  cDbpOls: number;
  /** Correlación Pearson por canal (−1..1; honestidad del ajuste). */
  rSbp: number;
  rDbp: number;
  /** Desviación residual por canal (mmHg, σ muestral). */
  residualStdSbpMmHg: number;
  residualStdDbpMmHg: number;
}

/** Resultado Bland–Altman de UN canal (d = predicción − referencia). */
export interface NexusAltmanChannel {
  n: number;
  direction: 'PREDICTED_MINUS_REFERENCE';
  /** d̄ (mmHg). */
  biasMmHg: number;
  /** σ muestral de las diferencias (mmHg). */
  sdMmHg: number;
  loaLowMmHg: number;
  loaHighMmHg: number;
  /** Percentiles empíricos de las diferencias (robustPercentile compartida). */
  p5MmHg: number;
  p95MmHg: number;
}

export interface NexusCalibrationAltman {
  sbp: NexusAltmanChannel;
  dbp: NexusAltmanChannel;
}

export interface NexusCalibrationFitResult {
  status: NexusCalibrationFitStatus;
  /** Modelo con coeficientes finales (blend ridge); null salvo status FIT. */
  model: PttPersonalModel | null;
  fitSummary: NexusCalibrationFitSummary | null;
  /** Bland–Altman del modelo final contra las referencias (null si no FIT). */
  altman: NexusCalibrationAltman | null;
}

export interface NexusCalibrationFitOptions {
  /** Fracción del prior (0..1); por defecto NEXUS_RIDGE_FRACTION. */
  ridgeFraction?: number;
  /** Prior hacia el que regularizar; por defecto el público no calibrado. */
  prior?: PttPersonalModel;
}

/** Coeficiente de regresión lineal y stats honestos sobre x = 1/τ². */
interface OlsChannel {
  slope: number;
  intercept: number;
  r: number;
  residualStd: number;
}

function olsChannel(xs: number[], ys: number[]): OlsChannel | null {
  const n = xs.length;
  if (n < 2) return null;
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xMean;
    const dy = ys[i] - yMean;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx < 1e-12) return null; // τ degenerados: sin línea identificable
  const slope = sxy / sxx;
  const intercept = yMean - slope * xMean;
  const denom = Math.sqrt(sxx) * Math.sqrt(syy);
  const r = denom > 0 ? clamp(sxy / denom, -1, 1) : 0;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const resid = ys[i] - (slope * xs[i] + intercept);
    ss += resid * resid;
  }
  const residualStd = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
  return { slope, intercept, r, residualStd };
}

function diffsBlandAltman(diffs: number[]): NexusAltmanChannel {
  const sorted = [...diffs].sort((a, b) => a - b);
  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1
    ? diffs.reduce((acc, d) => acc + (d - mean) * (d - mean), 0) / (n - 1)
    : 0;
  const sd = Math.sqrt(variance);
  return {
    n,
    direction: 'PREDICTED_MINUS_REFERENCE',
    biasMmHg: mean,
    sdMmHg: sd,
    loaLowMmHg: mean - 1.96 * sd,
    loaHighMmHg: mean + 1.96 * sd,
    p5MmHg: robustPercentile(sorted, 0.05),
    p95MmHg: robustPercentile(sorted, 0.95),
  };
}

/**
 * Bland–Altman entre el modelo aportado y las referencias de los pares.
 * d = predicción − referencia (dirección declarada en cada resultado).
 * Herramienta pública: el ajuste interno y el panel vivo de calibración la
 * usan SIEMPRE con la misma semántica (una sola estatística, sin copias).
 */
export function computeNexusBlandAltman(
  pairs: NexusCalibrationPair[],
  model: PttPersonalModel,
): NexusCalibrationAltman | null {
  const clean = pairs.filter((p) => Number.isFinite(p.tauMs) && p.tauMs > 0);
  if (clean.length === 0) return null;
  const sbpDiff: number[] = [];
  const dbpDiff: number[] = [];
  for (const p of clean) {
    const { sbp, dbp } = pttModelToPressures(p.tauMs, model);
    sbpDiff.push(sbp - p.sbpMmHg);
    dbpDiff.push(dbp - p.dbpMmHg);
  }
  return { sbp: diffsBlandAltman(sbpDiff), dbp: diffsBlandAltman(dbpDiff) };
}

/**
 * Ajusta el modelo personal. Lanza estado honesto en cada causa de rechazo;
 * el modelo final mezcla OLS y prior con la fracción de ridge declarada.
 */
export function fitPttPersonalModel(
  pairs: NexusCalibrationPair[],
  options: NexusCalibrationFitOptions = {},
): NexusCalibrationFitResult {
  const clean = pairs.filter(
    (p) =>
      Number.isFinite(p.tauMs) && p.tauMs >= 10 && p.tauMs <= 900 &&
      Number.isFinite(p.sbpMmHg) && p.sbpMmHg > 0 &&
      Number.isFinite(p.dbpMmHg) && p.dbpMmHg > 0 &&
      p.dbpMmHg < p.sbpMmHg,
  );
  if (clean.length < NEXUS_CALIBRATION_MIN_PAIRS) {
    return { status: 'INSUFFICIENT_PAIRS', model: null, fitSummary: null, altman: null };
  }

  const xs = clean.map((p) => (p.tauMs / 1000) ** -2);
  const olsSbp = olsChannel(xs, clean.map((p) => p.sbpMmHg));
  const olsDbp = olsChannel(xs, clean.map((p) => p.dbpMmHg));
  if (!olsSbp || !olsDbp) {
    return { status: 'UNSTABLE_MODEL', model: null, fitSummary: null, altman: null };
  }
  // Moens–Korteweg exige pendiente positiva (τ↑ ⇒ PA↓). Otra cosa denota datos
  // inconsistentes: se rechaza el modelo, no se disimula.
  const lambda = clamp(options.ridgeFraction ?? NEXUS_RIDGE_FRACTION, 0, 1);
  const prior = options.prior ?? UNCALIBRATED_PTT_MODEL;
  if (olsSbp.slope <= 0 || olsDbp.slope <= 0) {
    return { status: 'UNSTABLE_MODEL', model: null, fitSummary: null, altman: null };
  }

  const model: PttPersonalModel = {
    kSbpMmHgS2: lambda * prior.kSbpMmHgS2 + (1 - lambda) * olsSbp.slope,
    cSbpMmHg: lambda * prior.cSbpMmHg + (1 - lambda) * olsSbp.intercept,
    kDbpMmHgS2: lambda * prior.kDbpMmHgS2 + (1 - lambda) * olsDbp.slope,
    cDbpMmHg: lambda * prior.cDbpMmHg + (1 - lambda) * olsDbp.intercept,
    calibrated: true,
  };

  // Verificación fisiológica del modelo final con las referencias usadas.
  for (const p of clean) {
    const { sbp, dbp } = pttModelToPressures(p.tauMs, model);
    if (!Number.isFinite(sbp) || !Number.isFinite(dbp) || dbp <= 0 || dbp >= sbp) {
      return { status: 'UNSTABLE_MODEL', model: null, fitSummary: null, altman: null };
    }
  }

  const summary: NexusCalibrationFitSummary = {
    kSbpOls: olsSbp.slope,
    cSbpOls: olsSbp.intercept,
    kDbpOls: olsDbp.slope,
    cDbpOls: olsDbp.intercept,
    rSbp: olsSbp.r,
    rDbp: olsDbp.r,
    residualStdSbpMmHg: olsSbp.residualStd,
    residualStdDbpMmHg: olsDbp.residualStd,
  };

  // Acuerdo predicción↔referencia del modelo final (misma estatística pública
  // que consume el panel vivo de calibración).
  const altman = computeNexusBlandAltman(clean, model);

  return { status: 'FIT', model, fitSummary: summary, altman };
}
