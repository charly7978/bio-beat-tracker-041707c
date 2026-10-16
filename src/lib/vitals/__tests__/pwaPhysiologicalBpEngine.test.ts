import { describe, expect, it } from 'vitest';
import { VITAL_THRESHOLDS } from '../../../config/vitalThresholds';
import {
  computePhysiologicalIndices,
  enforceHemodynamicCoherence,
  estimatePhysiologicalBp,
  isPhysiologicalBp,
  type PwaMedianFeatures,
} from '../pwaPhysiologicalBpEngine';

const baseFeatures: PwaMedianFeatures = {
  bDivA: -0.75,
  dDivA: -0.35,
  agi: 0.4,
  sutMs: 140,
  diastolicPhaseMs: 480,
  stiffnessIndex: 8,
  augmentationIndex: 18,
  dicroticDepth: 0.22,
  areaRatio: 1.45,
  pw50Ms: 220,
  kValue: 0.38,
  vMax: 52,
  harmonicDistortion: 0.12,
};

describe('pwaPhysiologicalBpEngine (SOTA Bio-PWA 2026)', () => {
  it('índices fisiológicos en [0,1] derivados de morfología PDA', () => {
    const idx = computePhysiologicalIndices(baseFeatures, {
      hr: 72,
      rmssd: 35,
      cyclePeriodMs: 830,
    });
    expect(idx.resistanceIndex).toBeGreaterThanOrEqual(0);
    expect(idx.resistanceIndex).toBeLessThanOrEqual(1);
    expect(idx.complianceIndex).toBeGreaterThanOrEqual(0);
    expect(idx.complianceIndex).toBeLessThanOrEqual(1);
    expect(idx.reflectionIndex).toBeGreaterThanOrEqual(0);
    expect(idx.reflectionIndex).toBeLessThanOrEqual(1);
  });

  it('estimación dentro de rangos fisiológicos coherentes', () => {
    const raw = estimatePhysiologicalBp(baseFeatures, {
      hr: 72,
      rmssd: 35,
      cyclePeriodMs: 830,
    });
    const { sbp, dbp } = enforceHemodynamicCoherence(raw.systolic, raw.diastolic);
    expect(isPhysiologicalBp(sbp, dbp)).toBe(true);
    expect(sbp).toBeGreaterThan(dbp);
    expect(dbp).toBeGreaterThanOrEqual(VITAL_THRESHOLDS.BP.DIASTOLIC_MIN);
    expect(sbp).toBeLessThanOrEqual(VITAL_THRESHOLDS.BP.SYSTOLIC_MAX);
    expect(sbp - dbp).toBeGreaterThanOrEqual(VITAL_THRESHOLDS.BP.PP_MIN);
    expect(sbp - dbp).toBeLessThanOrEqual(VITAL_THRESHOLDS.BP.PP_MAX);
  });

  it('rechaza presión fuera de rango fisiológico', () => {
    expect(isPhysiologicalBp(250, 80)).toBe(false);
    expect(isPhysiologicalBp(120, 20)).toBe(false);
    expect(isPhysiologicalBp(80, 80)).toBe(false);
    expect(isPhysiologicalBp(NaN, 80)).toBe(false);
  });

  it('el perfil antropométrico modula compliancia y resistencia según edad y BMI', () => {
    const youngIdx = computePhysiologicalIndices(
      baseFeatures,
      { hr: 72, rmssd: 35, cyclePeriodMs: 830 },
      { ageYears: 20, heightCm: 180, weightKg: 70, isMale: true },
    );
    const oldIdx = computePhysiologicalIndices(
      baseFeatures,
      { hr: 72, rmssd: 35, cyclePeriodMs: 830 },
      { ageYears: 70, heightCm: 180, weightKg: 70, isMale: true },
    );
    expect(oldIdx.complianceIndex).toBeLessThan(youngIdx.complianceIndex);
    expect(oldIdx.resistanceIndex).toBeGreaterThan(youngIdx.resistanceIndex);
  });

  it('aplica offsets de calibración médica activa correctamente', () => {
    const uncalib = estimatePhysiologicalBp(baseFeatures, {
      hr: 72,
      rmssd: 35,
      cyclePeriodMs: 830,
    });
    const calib = estimatePhysiologicalBp(
      baseFeatures,
      { hr: 72, rmssd: 35, cyclePeriodMs: 830 },
      null,
      { sbpOffset: 10, dbpOffset: 5 },
    );
    expect(calib.systolic).toBeGreaterThan(uncalib.systolic);
    expect(calib.diastolic).toBeGreaterThan(uncalib.diastolic);
  });
});
