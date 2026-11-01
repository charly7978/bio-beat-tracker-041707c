import { describe, expect, it } from 'vitest';
import { MLP_WEIGHTS } from '../mlpWeights';
import {
  computeMlpWeightsFingerprint,
  serializeMlpWeights,
  verifyMlpWeightsShape,
  type MlpWeightsShape,
} from '../mlpWeightsFingerprint';
import {
  BP_PROMOTION_CRITERIA,
  MLP_WEIGHTS_PROVENANCE,
  evaluateBpWeightsPromotion,
  getMlpWeightsIntegrity,
  getShippedMlpWeightsFingerprint,
  type BpValidationArmMetrics,
  type BpValidationReport,
} from '../mlpWeightsProvenance';

const shippedWeights = MLP_WEIGHTS as MlpWeightsShape;

function arm(overrides: Partial<BpValidationArmMetrics> = {}): BpValidationArmMetrics {
  const bias = overrides.bias ?? 1.2;
  const sd = overrides.sd ?? 6.1;
  return {
    sampleCount: 135,
    bias,
    sd,
    mae: 4.8,
    loaLower: bias - 1.96 * sd,
    loaUpper: bias + 1.96 * sd,
    ...overrides,
  };
}

function compliantReport(overrides: Partial<BpValidationReport> = {}): BpValidationReport {
  return {
    weightsFingerprint: 'fnv1a64:candidate00000000',
    weightsGeneratedAt: '2026-05-01T00:00:00.000Z',
    evaluatedAt: '2026-06-15T00:00:00.000Z',
    protocol: 'ISO 81060-2:2018',
    evaluator: 'Lab de validacion',
    dataset: {
      kind: 'clinical_reference',
      subjectCount: 45,
      referenceDevice: 'Tensiometro auscultatorio validado',
      referenceDeviceCertified: true,
      collectedAt: '2026-04-10T00:00:00.000Z',
      datasetId: 'ds-bp-2026-04',
    },
    arms: { systolic: arm(), diastolic: arm({ bias: 0.8, sd: 5.4 }) },
    ...overrides,
  };
}

const promotionContext = {
  candidateFingerprint: 'fnv1a64:candidate00000000',
  candidateGeneratedAt: '2026-05-01T00:00:00.000Z',
};
describe('mlpWeights — procedencia y sustitucion de pesos', () => {
  it('la huella de los pesos en produccion coincide con la declarada', () => {
    const actual = getShippedMlpWeightsFingerprint();
    if (actual !== MLP_WEIGHTS_PROVENANCE.fingerprint) {
      console.error(`Huella real de los pesos: ${actual}`);
    }
    expect(actual).toBe(MLP_WEIGHTS_PROVENANCE.fingerprint);
  });

  it('la forma de los pesos coincide con la arquitectura declarada', () => {
    expect(verifyMlpWeightsShape(shippedWeights)).toEqual([]);
  });

  it('la serializacion canonica es estable y cambia con cualquier peso', () => {
    const canonical = serializeMlpWeights(shippedWeights);
    expect(canonical).toBe(serializeMlpWeights(shippedWeights));
    expect(canonical).toContain('fc1.w[0]=');
    expect(canonical).toContain('fc3.b=');

    const tampered: MlpWeightsShape = {
      fc1: {
        weights: shippedWeights.fc1.weights.map((row, index) =>
          index === 0 ? [...row.slice(1), row[0]] : row,
        ),
        bias: [...shippedWeights.fc1.bias],
      },
      fc2: shippedWeights.fc2,
      fc3: shippedWeights.fc3,
    };
    expect(computeMlpWeightsFingerprint(tampered)).not.toBe(
      computeMlpWeightsFingerprint(shippedWeights),
    );
  });

  it('la procedencia declara pesos NO validados clinicamente', () => {
    expect(MLP_WEIGHTS_PROVENANCE.validationStatus).toBe('unvalidated');
    expect(MLP_WEIGHTS_PROVENANCE.datasetKind).toBe('formula_generated');
    expect(MLP_WEIGHTS_PROVENANCE.subjectCount).toBe(0);
    expect(MLP_WEIGHTS_PROVENANCE.validationReportPath).toBeNull();
    expect(MLP_WEIGHTS_PROVENANCE.publishedMetrics).toBeNull();
  });

  it('la integridad en runtime confirma los pesos y niega la validacion clinica', () => {
    const integrity = getMlpWeightsIntegrity();
    expect(integrity.problems).toEqual([]);
    expect(integrity.shapeValid).toBe(true);
    expect(integrity.fingerprintMatchesProvenance).toBe(true);
    expect(integrity.clinicallyValidated).toBe(false);
    expect(integrity.verified).toBe(true);
  });
});

describe('evaluateBpWeightsPromotion — gate de sustitucion de pesos', () => {
  it('sin informe de validacion la sustitucion queda bloqueada', () => {
    const decision = evaluateBpWeightsPromotion(null, promotionContext);
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(' ')).toContain('No existe informe de validación');
  });

  it('un informe completo y conforme si habilita la sustitucion', () => {
    const decision = evaluateBpWeightsPromotion(compliantReport(), promotionContext);
    expect(decision.blockers).toEqual([]);
    expect(decision.allowed).toBe(true);
  });

  it('rechaza informes de un juego de pesos distinto', () => {
    const decision = evaluateBpWeightsPromotion(
      compliantReport({ weightsFingerprint: 'fnv1a64:otro-juego' }),
      promotionContext,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(' ')).toContain('pero los candidatos son');
  });

  it('rechaza datasets generados por formulas', () => {
    const report = compliantReport();
    const decision = evaluateBpWeightsPromotion(
      { ...report, dataset: { ...report.dataset, kind: 'formula_generated' } },
      promotionContext,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(' ')).toContain('referencia clínica');
  });

  it(`rechaza menos de ${BP_PROMOTION_CRITERIA.MIN_SUBJECTS} sujetos`, () => {
    const report = compliantReport();
    const decision = evaluateBpWeightsPromotion(
      { ...report, dataset: { ...report.dataset, subjectCount: 12 } },
      promotionContext,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(' ')).toContain('Sujetos 12');
  });

  it('rechaza dispositivo de referencia no certificado', () => {
    const report = compliantReport();
    const decision = evaluateBpWeightsPromotion(
      { ...report, dataset: { ...report.dataset, referenceDeviceCertified: false } },
      promotionContext,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(' ')).toContain('no está declarado como certificado');
  });

  it('rechaza sesgo y desviacion por encima del criterio normativo', () => {
    const report = compliantReport({
      arms: {
        systolic: arm({ bias: 6.4, sd: 7.0, mae: 7.1 }),
        diastolic: arm({ bias: 1.0, sd: 9.5, mae: 7.6 }),
      },
    });
    const decision = evaluateBpWeightsPromotion(report, promotionContext);
    expect(decision.allowed).toBe(false);
    const joined = decision.blockers.join(' ');
    expect(joined).toContain('systolic: sesgo');
    expect(joined).toContain('diastolic: DE');
  });

  it('rechaza pares insuficientes para el numero de sujetos', () => {
    const decision = evaluateBpWeightsPromotion(
      compliantReport({ arms: { systolic: arm({ sampleCount: 40 }), diastolic: arm() } }),
      promotionContext,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(' ')).toContain('pares válidos');
  });

  it('rechaza limites de concordancia incoherentes con sesgo y DE', () => {
    const decision = evaluateBpWeightsPromotion(
      compliantReport({
        arms: { systolic: arm({ loaLower: -40, loaUpper: 40 }), diastolic: arm() },
      }),
      promotionContext,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(' ')).toContain('incoherentes');
  });

  it('rechaza un informe anterior a la generacion de los pesos', () => {
    const decision = evaluateBpWeightsPromotion(
      compliantReport({ evaluatedAt: '2026-01-01T00:00:00.000Z' }),
      promotionContext,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(' ')).toContain('anterior a la generación');
  });

  it('rechaza metricas no finitas', () => {
    const decision = evaluateBpWeightsPromotion(
      compliantReport({ arms: { systolic: arm({ sd: Number.NaN }), diastolic: arm() } }),
      promotionContext,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(' ')).toContain('valor no finito');
  });

  it('rechaza un informe sin protocolo ni responsable', () => {
    const decision = evaluateBpWeightsPromotion(
      compliantReport({ protocol: '  ', evaluator: '' }),
      promotionContext,
    );
    expect(decision.allowed).toBe(false);
    const joined = decision.blockers.join(' ');
    expect(joined).toContain('protocolo');
    expect(joined).toContain('responsable');
  });
});
