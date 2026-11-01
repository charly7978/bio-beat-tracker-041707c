/**
 * Procedencia y gate de promoción de los pesos del MLP de presión arterial.
 *
 * REGLA DEL PROYECTO (docs/medical-validation.md §4):
 * los coeficientes de un modelo solo se sustituyen con evidencia verificable.
 * Este módulo implementa esa regla de dos formas:
 *
 *   1. Declaración de procedencia (`MLP_WEIGHTS_PROVENANCE`): qué juego de
 *      pesos está en producción, de dónde salió y qué validación tiene.
 *      Incluye la huella exacta de los pesos (ver `mlpWeightsFingerprint.ts`),
 *      de modo que una sustitución manual sin actualizar esta declaración queda
 *      detectada por `getMlpWeightsIntegrity()` (runtime) y por CI.
 *
 *   2. Gate de promoción (`evaluateBpWeightsPromotion`): un informe de
 *      validación solo autoriza la sustitución si demuestra, contra referencia
 *      clínica real, el cumplimiento de ISO 81060-2:2018 / ANSI-AAMI ES1
 *      (|sesgo| ≤ 5 mmHg y DE ≤ 8 mmHg por brazo).
 *
 * Estado actual: los pesos en producción fueron generados por fórmulas sobre
 * features aleatorios (NO son mediciones de pacientes), no tienen informe de
 * validación asociado y por tanto NO se pueden sustituir todavía. El MLP se
 * mantiene únicamente como un estimador secundario dentro de la fusión del
 * motor Windkessel-PDA.
 */

import { MLP_WEIGHTS } from './mlpWeights';
import { PUBLIC_BP_DATASETS } from './bpTrainingDatasets';
export { PUBLIC_BP_DATASETS };
import {
  computeMlpWeightsFingerprint,
  verifyMlpWeightsShape,
  type MlpWeightsShape,
} from './mlpWeightsFingerprint';

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. MODELO DE PROCEDENCIA
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Origen del conjunto de datos usado para obtener los pesos.
 * - `clinical_reference`: pares (estimación, referencia certificada) medidos en
 *   sujetos reales. Es el único origen que habilita la promoción.
 * - `formula_generated`: objetivos calculados con fórmulas sobre features
 *   generados. Sirve para verificar que el pipeline de entrenamiento funciona,
 *   nunca para uso clínico.
 */
export type WeightsDatasetKind = 'formula_generated' | 'clinical_reference';

export type WeightsValidationStatus = 'unvalidated' | 'validated';

/** Métricas de concordancia de un brazo (sistólica o diastólica). */
export interface BpValidationArmMetrics {
  /** Pares estimación/referencia incluidos. */
  sampleCount: number;
  /** Media de (estimado − referencia) en mmHg. */
  bias: number;
  /** Desviación estándar de las diferencias en mmHg. */
  sd: number;
  /** Error absoluto medio en mmHg. */
  mae: number;
  /** Límite inferior de concordancia de Bland–Altman (bias − 1.96·sd). */
  loaLower: number;
  /** Límite superior de concordancia de Bland–Altman (bias + 1.96·sd). */
  loaUpper: number;
}

/** Informe de validación de un juego de pesos de PA. */
export interface BpValidationReport {
  /** Huella de los pesos evaluados; debe coincidir con los pesos candidatos. */
  weightsFingerprint: string;
  /** ISO 8601 de generación de los pesos evaluados. */
  weightsGeneratedAt: string;
  /** ISO 8601 de cierre de la evaluación. */
  evaluatedAt: string;
  /** Protocolo seguido (p. ej. "ISO 81060-2:2018"). */
  protocol: string;
  /** Responsable de la evaluación. */
  evaluator: string;
  dataset: {
    kind: WeightsDatasetKind;
    /** Sujetos distintos incluidos en el análisis. */
    subjectCount: number;
    /** Dispositivo de referencia usado. */
    referenceDevice: string;
    /** El dispositivo de referencia está certificado para medida de PA. */
    referenceDeviceCertified: boolean;
    collectedAt: string;
    /** Identificador del dataset registrado. */
    datasetId: string;
  };
  arms: {
    systolic: BpValidationArmMetrics;
    diastolic: BpValidationArmMetrics;
  };
}

/** Procedencia declarada del juego de pesos que corre en producción. */
export interface MlpWeightsProvenance {
  /** Identificador legible del juego de pesos. */
  weightsId: string;
  /** Huella "fnv1a64:…" de los pesos exactos declarados. */
  fingerprint: string;
  generatedBy: string;
  generatedAt: string;
  datasetKind: WeightsDatasetKind;
  datasetDescription: string;
  /** Sujetos reales usados; 0 si el dataset no es clínico. */
  subjectCount: number;
  validationStatus: WeightsValidationStatus;
  /** Ruta del informe de validación, o null si no existe. */
  validationReportPath: string | null;
  /** Métricas publicadas del modelo, o null si nunca se validó. */
  publishedMetrics: BpValidationArmMetrics | null;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. CRITERIOS DE PROMOCIÓN (con base documental explícita)
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Criterios de aceptación para sustituir los pesos.
 *
 * - `MIN_SUBJECTS = 30`: mínimo exigido por el propio protocolo del proyecto
 *   (docs/medical-validation.md §4.1, "N ≥ 30 sujetos representativos").
 * - `MAX_ABS_BIAS_MMHG = 5` y `MAX_SD_MMHG = 8`: criterio de exactitud de
 *   ISO 81060-2:2018 / ANSI-AAMI ES1 para esfigmomanómetros automáticos
 *   (error medio ≤ 5 mmHg y desviación estándar ≤ 8 mmHg).
 * - `MIN_PAIRS_PER_SUBJECT = 3`: ISO 81060-2 exige un mínimo de 3 pares
 *   válidos por sujeto.
 *
 * No son constantes fisiológicas: son umbrales de aceptación normativos y por
 * eso viven aquí y no en `src/config/vitalThresholds.ts`.
 */
export const BP_PROMOTION_CRITERIA = {
  MIN_SUBJECTS: 30,
  MAX_ABS_BIAS_MMHG: 5,
  MAX_SD_MMHG: 8,
  MIN_PAIRS_PER_SUBJECT: 3,
  /** Tolerancia al comprobar que loaLower/loaUpper = bias ± 1.96·sd. */
  LOA_CONSISTENCY_TOLERANCE_MMHG: 0.5,
} as const;

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. GATE DE PROMOCIÓN
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface BpPromotionDecision {
  allowed: boolean;
  /** Motivos concretos de rechazo; vacío cuando `allowed` es true. */
  blockers: string[];
}

export interface BpPromotionContext {
  /** Huella de los pesos candidatos que se quieren poner en producción. */
  candidateFingerprint: string;
  /** ISO 8601 de generación de los pesos candidatos. */
  candidateGeneratedAt: string;
}

function parseIsoMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function checkArm(
  armName: string,
  arm: BpValidationArmMetrics | undefined,
  requiredPairs: number,
  blockers: string[],
): void {
  if (!arm) {
    blockers.push(`${armName}: falta el brazo de métricas`);
    return;
  }

  const numericFields: Array<[string, number]> = [
    ['sampleCount', arm.sampleCount],
    ['bias', arm.bias],
    ['sd', arm.sd],
    ['mae', arm.mae],
    ['loaLower', arm.loaLower],
    ['loaUpper', arm.loaUpper],
  ];
  for (const [field, value] of numericFields) {
    if (!Number.isFinite(value)) {
      blockers.push(`${armName}.${field}: valor no finito`);
      return;
    }
  }

  if (arm.sampleCount < requiredPairs) {
    blockers.push(
      `${armName}: ${arm.sampleCount} pares válidos, mínimo ${requiredPairs} (ISO 81060-2)`,
    );
  }
  if (Math.abs(arm.bias) > BP_PROMOTION_CRITERIA.MAX_ABS_BIAS_MMHG) {
    blockers.push(
      `${armName}: sesgo ${arm.bias.toFixed(2)} mmHg, máximo ±${BP_PROMOTION_CRITERIA.MAX_ABS_BIAS_MMHG}`,
    );
  }
  if (arm.sd > BP_PROMOTION_CRITERIA.MAX_SD_MMHG) {
    blockers.push(
      `${armName}: DE ${arm.sd.toFixed(2)} mmHg, máximo ${BP_PROMOTION_CRITERIA.MAX_SD_MMHG}`,
    );
  }
  if (arm.mae + 1e-9 < Math.abs(arm.bias)) {
    blockers.push(
      `${armName}: MAE (${arm.mae.toFixed(2)}) menor que |sesgo| (${Math.abs(arm.bias).toFixed(2)})`,
    );
  }

  const expectedLower = arm.bias - 1.96 * arm.sd;
  const expectedUpper = arm.bias + 1.96 * arm.sd;
  const tolerance = BP_PROMOTION_CRITERIA.LOA_CONSISTENCY_TOLERANCE_MMHG;
  if (
    Math.abs(arm.loaLower - expectedLower) > tolerance ||
    Math.abs(arm.loaUpper - expectedUpper) > tolerance
  ) {
    blockers.push(
      `${armName}: límites de concordancia incoherentes con bias ± 1.96·sd ` +
        `(esperado [${expectedLower.toFixed(2)}, ${expectedUpper.toFixed(2)}])`,
    );
  }
}

/**
 * Decide si un informe de validación autoriza la sustitución de pesos.
 * Todo lo que no esté demostrado se trata como bloqueante: no hay promoción
 * por defecto ni por ausencia de datos.
 */
export function evaluateBpWeightsPromotion(
  report: BpValidationReport | null | undefined,
  context: BpPromotionContext,
): BpPromotionDecision {
  const blockers: string[] = [];

  if (!report) {
    blockers.push(
      'No existe informe de validación para estos pesos: la sustitución requiere resultados verificables.',
    );
    return { allowed: false, blockers };
  }

  if (!report.weightsFingerprint || report.weightsFingerprint !== context.candidateFingerprint) {
    blockers.push(
      `El informe evalúa los pesos "${report.weightsFingerprint ?? 'sin huella'}" ` +
        `pero los candidatos son "${context.candidateFingerprint}".`,
    );
  }

  const evaluatedAtMs = parseIsoMs(report.evaluatedAt);
  const weightsGeneratedAtMs = parseIsoMs(context.candidateGeneratedAt);
  if (evaluatedAtMs === null) {
    blockers.push('evaluatedAt no es una fecha ISO 8601 válida');
  }
  if (weightsGeneratedAtMs === null) {
    blockers.push('candidateGeneratedAt no es una fecha ISO 8601 válida');
  }
  if (
    evaluatedAtMs !== null &&
    weightsGeneratedAtMs !== null &&
    evaluatedAtMs < weightsGeneratedAtMs
  ) {
    blockers.push('El informe es anterior a la generación de los pesos evaluados');
  }
  if (report.weightsGeneratedAt && parseIsoMs(report.weightsGeneratedAt) === null) {
    blockers.push('weightsGeneratedAt no es una fecha ISO 8601 válida');
  }

  if (!report.protocol || report.protocol.trim().length === 0) {
    blockers.push('Falta el protocolo de validación');
  }
  if (!report.evaluator || report.evaluator.trim().length === 0) {
    blockers.push('Falta el responsable de la evaluación');
  }

  const { dataset } = report;
  if (!dataset) {
    blockers.push('Falta la descripción del dataset');
  } else {
    if (dataset.kind !== 'clinical_reference') {
      blockers.push(
        `Dataset "${dataset.kind}": solo un dataset con referencia clínica (clinical_reference) habilita la promoción`,
      );
    }
    if (
      !Number.isFinite(dataset.subjectCount) ||
      dataset.subjectCount < BP_PROMOTION_CRITERIA.MIN_SUBJECTS
    ) {
      blockers.push(
        `Sujetos ${dataset.subjectCount}: mínimo ${BP_PROMOTION_CRITERIA.MIN_SUBJECTS} (docs/medical-validation.md §4.1)`,
      );
    }
    if (dataset.referenceDeviceCertified !== true) {
      blockers.push('El dispositivo de referencia no está declarado como certificado');
    }
    if (!dataset.referenceDevice || dataset.referenceDevice.trim().length === 0) {
      blockers.push('Falta el dispositivo de referencia');
    }
    if (!dataset.datasetId || dataset.datasetId.trim().length === 0) {
      blockers.push('Falta el identificador del dataset registrado');
    }
    if (parseIsoMs(dataset.collectedAt) === null) {
      blockers.push('dataset.collectedAt no es una fecha ISO 8601 válida');
    }
  }

  const requiredPairs = Math.max(
    BP_PROMOTION_CRITERIA.MIN_PAIRS_PER_SUBJECT,
    BP_PROMOTION_CRITERIA.MIN_PAIRS_PER_SUBJECT * (report.dataset?.subjectCount ?? 0),
  );
  checkArm('systolic', report.arms?.systolic, requiredPairs, blockers);
  checkArm('diastolic', report.arms?.diastolic, requiredPairs, blockers);

  return { allowed: blockers.length === 0, blockers };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. PROCEDENCIA DECLARADA DE LOS PESOS EN PRODUCCIÓN
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Declaración vigente. Cualquier cambio de `mlpWeights.ts` obliga a actualizar
 * `fingerprint` aquí; si no, `getMlpWeightsIntegrity()` marca los pesos como no
 * verificados y el motor descarta su contribución.
 *
 * `fingerprint` se obtiene de `getShippedMlpWeightsFingerprint()` (el test de
 * procedencia imprime el valor real cuando no coincide con el declarado).
 */
export const MLP_WEIGHTS_PROVENANCE: MlpWeightsProvenance = {
  weightsId: 'bp-mlp-formula-v1',
  fingerprint: 'fnv1a64:ed365c6fd3f42d17',
  generatedBy: 'training/train_bp_mlp.py',
  generatedAt: '2026-01-01T00:00:00.000Z',
  datasetKind: 'formula_generated',
  datasetDescription:
    'Objetivos calculados con fórmulas fisiológicas aproximadas sobre features generados (edad, IMC, rigidez, FC). No son mediciones de pacientes.',
  subjectCount: 0,
  validationStatus: 'unvalidated',
  validationReportPath: null,
  publishedMetrics: null,
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. VERIFICACIÓN DE INTEGRIDAD EN TIEMPO DE EJECUCIÓN
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface MlpWeightsIntegrity {
  /** La forma y los valores de los pesos son válidos. */
  shapeValid: boolean;
  /** La huella de los pesos coincide con la declarada en la procedencia. */
  fingerprintMatchesProvenance: boolean;
  /** La procedencia afirma validación clínica con métricas publicadas. */
  clinicallyValidated: boolean;
  /** Los pesos se pueden usar en la fusión (forma y huella correctas). */
  verified: boolean;
  problems: string[];
}

let cachedIntegrity: MlpWeightsIntegrity | null = null;

function buildIntegrity(): MlpWeightsIntegrity {
  const problems = verifyMlpWeightsShape(MLP_WEIGHTS as MlpWeightsShape);
  const shapeProblems = [...problems];
  let fingerprintMatchesProvenance = false;

  try {
    const actual = computeMlpWeightsFingerprint(MLP_WEIGHTS as MlpWeightsShape);
    fingerprintMatchesProvenance = actual === MLP_WEIGHTS_PROVENANCE.fingerprint;
    if (!fingerprintMatchesProvenance) {
      problems.push(
        `Huella de pesos ${actual} distinta de la declarada ${MLP_WEIGHTS_PROVENANCE.fingerprint}`,
      );
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : 'Huella de pesos no calculable');
  }

  const clinicallyValidated =
    MLP_WEIGHTS_PROVENANCE.validationStatus === 'validated' &&
    MLP_WEIGHTS_PROVENANCE.publishedMetrics !== null;

  return {
    shapeValid: shapeProblems.length === 0,
    fingerprintMatchesProvenance,
    clinicallyValidated,
    verified: problems.length === 0 && fingerprintMatchesProvenance,
    problems,
  };
}

/**
 * Integridad de los pesos en producción. Se calcula una sola vez y se cachea.
 * `verified === false` significa que los pesos no coinciden con la procedencia
 * declarada: el motor no debe usarlos.
 */
export function getMlpWeightsIntegrity(): MlpWeightsIntegrity {
  if (cachedIntegrity === null) {
    cachedIntegrity = buildIntegrity();
  }
  return cachedIntegrity;
}

/** Huella de los pesos actualmente cargados. */
export function getShippedMlpWeightsFingerprint(): string {
  return computeMlpWeightsFingerprint(MLP_WEIGHTS as MlpWeightsShape);
}
