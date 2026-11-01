import { describe, it, expect } from 'vitest';
import {
  assessNexusCoherence,
  tauCvPercentFromBeats,
  type NexusCoherenceInput,
} from '../nexusCoherence';

const OK: NexusCoherenceInput = {
  tauMs: 120,
  proximalBpm: 72.0,
  distalBpm: 71.0,
  spectralCoherence: 0.75,
  tauCvPercent: 8,
};

describe('nexusCoherence — adjudicador de coherencia multisitio', () => {
  it('todas las señales en tolerancia → CONGRUENT', () => {
    const r = assessNexusCoherence(OK);
    expect(r.level).toBe('CONGRUENT');
    expect(r.score).toBe(100);
    expect(r.reasons).toContain('HR_INTERSITIO_OK');
    expect(r.reasons).toContain('MSC_BANDA_PULSO_OK');
    expect(r.reasons).toContain('ESTABILIDAD_TAU_OK');
    expect(r.reasons.some((x) => x.includes('FUERA_DE_TOLERANCIA'))).toBe(false);
  });

  it('divergencia de frecuencia cardiaca >6% → INCOMPATIBLE con motivo', () => {
    const r = assessNexusCoherence({ ...OK, distalBpm: 80 });
    expect(r.level).toBe('INCOMPATIBLE');
    expect(r.reasons).toContain('HR_INTERSITIO_FUERA_DE_TOLERANCIA');
  });

  it('divergencia leve de frecuencia cardiaca (3–6%) mantiene coherencia PARTIAL sin fallar', () => {
    const r = assessNexusCoherence({ ...OK, distalBpm: 75.4 });
    expect(r.level).toBe('PARTIAL');
    expect(r.score).toBe(65);
  });

  it('MSC baja → INCOMPATIBLE', () => {
    const r = assessNexusCoherence({ ...OK, spectralCoherence: 0.3 });
    expect(r.level).toBe('INCOMPATIBLE');
    expect(r.reasons).toContain('MSC_BANDA_PULSO_FUERA_DE_TOLERANCIA');
  });

  it('CV de τ alta → INCOMPATIBLE (deriva o artefacto)', () => {
    const r = assessNexusCoherence({ ...OK, tauCvPercent: 42 });
    expect(r.level).toBe('INCOMPATIBLE');
    expect(r.reasons).toContain('ESTABILIDAD_TAU_FUERA_DE_TOLERANCIA');
  });

  it('τ nulo siempre condena: INCOMPATIBLE base', () => {
    const r = assessNexusCoherence({ ...OK, tauMs: null });
    expect(r.level).toBe('INCOMPATIBLE');
    expect(r.reasons).toContain('τ_DATO_FUERA_DE_TOLERANCIA');
  });

  it('solo τ (sin corroboración HR/MSC/CV) → máx PARTIAL con motivo explícito', () => {
    const r = assessNexusCoherence({ tauMs: 100 });
    expect(r.level).toBe('PARTIAL');
    expect(r.reasons).toContain('SIN_CORROBORACION_MULTISITIO');
  });

  it('tauCvPercentFromBeats: consistente en series estables y detecta deriva', () => {
    expect(tauCvPercentFromBeats([120, 121, 120.5])).toBeLessThan(2);
    expect(tauCvPercentFromBeats([120, 160, 90, 150])).toBeGreaterThan(15);
    expect(tauCvPercentFromBeats([120])).toBeUndefined();
  });
});
