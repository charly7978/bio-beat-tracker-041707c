/**
 * NEXUS COHERENCE — Adjudicador de coherencia multisitio (cara↔dedo)
 * ===================================================================
 * Decide si las dos señales del modo NEXUS cuentan la MISMA historia
 * fisiológica antes de que el τ entre a la fusión de presión arterial.
 *
 * Reglas (capítulos 5 y 11 de docs/nexus-vitals-blueprint.md):
 *  - Concordancia de frecuencia cardiaca inter-sitio: la frecuencia cardiaca
 *    de la cara y del dedo provienen del MISMO corazón; una divergencia real
 *    > umbral delata adquisición incoherente (topic: npj 2025, fiabilidad).
 *  - Coherencia espectral (MSC) en la banda del pulso: cristaliza la semejanza
 *    morfología/fase entre los dos sitios (Eseroglu/Knapp-Carter).
 *  - Estabilidad del τ por latido (CV): un tránsito real es estable latido a
 *    latido; la deriva indica arrastre de movimiento o contacto cambiante.
 *
 * El nivel final es el PEOR de los criterios evaluados: para considerar
 * congruente la medición basta UNA señal discordante. Nada se disimula.
 */

import { clamp } from '@/utils/math';

/** Divergencia relativa máxima de frecuencia cardiaca inter-sitio (fracción). */
const HR_TOLERANCE_CONGRUENT = 0.03;
/** Divergencia relativa tolerada para nivel PARTIAL. */
const HR_TOLERANCE_PARTIAL = 0.06;
/** MSC mínima para considerar coherencia espectral plena. */
const MSC_CONGRUENT = 0.6;
/** MSC aceptable parcial. */
const MSC_PARTIAL = 0.45;
/** Variabilidad de τ por latido tolerada para nivel CONGRUENT (%). */
const TAU_CV_CONGRUENT = 15;
/** CV tolerada parcial (%). */
const TAU_CV_PARTIAL = 35;

export type NexusCoherenceLevel = 'CONGRUENT' | 'PARTIAL' | 'INCOMPATIBLE';

export interface NexusCoherenceInput {
  /** τ estimado por el CSTT, o null si el estimador lo rechazó. */
  tauMs: number | null;
  /** Frecuencia cardiaca del sitio proximal (cara), opcional. */
  proximalBpm?: number;
  /** Frecuencia cardiaca del sitio distal (dedo), opcional. */
  distalBpm?: number;
  /** MSC media en banda de pulso (0–1), opcional. */
  spectralCoherence?: number;
  /** Coeficiente de variación (%) del τ latido-a-latido, opcional. */
  tauCvPercent?: number;
}

export interface NexusCoherenceResult {
  level: NexusCoherenceLevel;
  /** Puntuación de coherencia 0–100 (mínimo entre criterios disponibles). */
  score: number;
  /** Motivos técnicos de la decisión (se lista cada criterio evaluado). */
  reasons: string[];
}

type Criterion = { score: number; fail: boolean } | null;

function hrCriterion(proximalBpm?: number, distalBpm?: number): Criterion {
  if (proximalBpm === undefined || distalBpm === undefined) return null;
  const d = Math.abs(proximalBpm - distalBpm) / Math.max(1, proximalBpm);
  if (d <= HR_TOLERANCE_CONGRUENT) return { score: 100, fail: false };
  if (d <= HR_TOLERANCE_PARTIAL) return { score: 65, fail: false };
  return { score: 25, fail: true };
}

function mscCriterion(msc?: number): Criterion {
  if (msc === undefined) return null;
  if (msc >= MSC_CONGRUENT) return { score: 100, fail: false };
  if (msc >= MSC_PARTIAL) return { score: 65, fail: false };
  return { score: 30, fail: true };
}

function tauStabilityCriterion(tauCvPercent?: number): Criterion {
  if (tauCvPercent === undefined) return null;
  if (tauCvPercent <= TAU_CV_CONGRUENT) return { score: 100, fail: false };
  if (tauCvPercent <= TAU_CV_PARTIAL) return { score: 65, fail: false };
  return { score: 30, fail: true };
}

/**
 * Adjudica la coherencia multisitio. Con `tauMs = null` el resultado es
 * INCOMPATIBLE con motivo explícito (sin τ no hay historia común).
 */
export function assessNexusCoherence(input: NexusCoherenceInput): NexusCoherenceResult {
  const reasons: string[] = [];
  let floor = 100;
  let anyFail = false;

  const criteria: Array<[string, Criterion]> = [
    ['τ_DATO', input.tauMs === null ? { score: 0, fail: true } : { score: 100, fail: false }],
    ['HR_INTERSITIO', hrCriterion(input.proximalBpm, input.distalBpm)],
    ['MSC_BANDA_PULSO', mscCriterion(input.spectralCoherence)],
    ['ESTABILIDAD_TAU', tauStabilityCriterion(input.tauCvPercent)],
  ];

  const evaluated: Array<{ name: string; score: number }> = [];
  for (const [name, criterion] of criteria) {
    if (criterion === null) continue; // criterio no disponible: no penaliza
    evaluated.push({ name, score: criterion.score });
    if (criterion.fail) anyFail = true;
    floor = Math.min(floor, criterion.score);
    if (criterion.fail) reasons.push(`${name}_FUERA_DE_TOLERANCIA`);
  }
  for (const e of evaluated) {
    if (!reasons.some((r) => r.startsWith(e.name + '_'))) reasons.push(`${e.name}_OK`);
  }

  // Sin ningún criterio evaluable no hay historia admissible
  if (evaluated.length === 0) {
    return {
      level: 'INCOMPATIBLE',
      score: 0,
      reasons: ['SIN_CRITERIOS_EVALUABLES'],
    };
  }

  // Nivel: CONGRUENT exige coherencia plena (100) en TODOS los criterios
  // disponibles; un solo criterio en parcial degrada a PARTIAL; cualquier
  // fallo condena a INCOMPATIBLE (peor nivel: basta una señal discordante).
  const allPerfect = evaluated.every((e) => e.score === 100);
  const level: NexusCoherenceLevel = anyFail
    ? 'INCOMPATIBLE'
    : allPerfect
      ? 'CONGRUENT'
      : 'PARTIAL';

  // Con SOLO el τ (sin HR/MSC/CV) no hay corroboración multisitio disponible:
  // máx PARTIAL con motivo explícito.
  if (level === 'CONGRUENT' && evaluated.length === 1 && evaluated[0].name === 'τ_DATO') {
    return { level: 'PARTIAL', score: floor, reasons: ['SIN_CORROBORACION_MULTISITIO'] };
  }

  return {
    level,
    score: Math.round(clamp(floor, 0, 100)),
    reasons,
  };
}

/**
 * Coeficiente de variación (%) del τ latido-a-latido a partir de los τ individuales.
 */
export function tauCvPercentFromBeats(tauByBeatMs: readonly number[]): number | undefined {
  if (tauByBeatMs.length < 2) return undefined;
  let s = 0;
  for (const v of tauByBeatMs) s += v;
  const mean = s / tauByBeatMs.length;
  if (mean <= 0) return undefined;
  let v = 0;
  for (const raw of tauByBeatMs) {
    const d = raw - mean;
    v += d * d;
  }
  return (Math.sqrt(v / tauByBeatMs.length) / mean) * 100;
}
