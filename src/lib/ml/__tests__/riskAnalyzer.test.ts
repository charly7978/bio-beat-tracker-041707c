import { describe, expect, it } from 'vitest';
import { HealthRiskAnalyzer, healthRiskAnalyzer } from '../riskAnalyzer';
import type { VitalSignsResult } from '../../../modules/vital-signs/VitalSignsProcessor';

function createMockVitals(overrides: Partial<VitalSignsResult> = {}): VitalSignsResult {
  return {
    heartRate: { value: 72, confidence: 0.9, status: 'VALID' },
    spo2: { value: 98, confidence: 0.9, status: 'VALID' },
    bloodPressure: { value: { systolic: 120, diastolic: 80 }, confidence: 0.8, status: 'VALID' },
    respiration: { value: 16, confidence: 0.85, status: 'VALID' },
    arrhythmia: { value: { count: 0, status: 'NORMAL', score: 0 }, confidence: 0.9, status: 'VALID' },
    signalQuality: 90,
    isCalibrating: false,
    calibrationProgress: 100,
    ...overrides,
  };
}

describe('HealthRiskAnalyzer', () => {
  it('instancia exportada única existe', () => {
    expect(healthRiskAnalyzer).toBeInstanceOf(HealthRiskAnalyzer);
  });

  it('reporta riesgo bajo y timeline NORMAL para signos vitales ideales', () => {
    const vitals = createMockVitals();
    const score = healthRiskAnalyzer.analyze(vitals);

    expect(score.overall).toBeLessThan(0.2);
    expect(score.timeline).toBe('NORMAL');
    expect(score.flags).toHaveLength(0);
    expect(score.recommendations.length).toBeGreaterThan(0);
  });

  it('detecta y marca TAQUICARDIA y RIESGO_CARDIOVASCULAR_ELEVADO', () => {
    const vitals = createMockVitals({
      heartRate: { value: 135, confidence: 0.95, status: 'VALID' },
    });
    const score = healthRiskAnalyzer.analyze(vitals);

    expect(score.flags).toContain('TAQUICARDIA');
    expect(score.categories.cardiovascular).toBeGreaterThan(0.2);
  });

  it('detecta y marca BRADICARDIA cuando HR < 50', () => {
    const vitals = createMockVitals({
      heartRate: { value: 44, confidence: 0.95, status: 'VALID' },
    });
    const score = healthRiskAnalyzer.analyze(vitals);

    expect(score.flags).toContain('BRADICARDIA');
  });

  it('detecta CRISIS_HIPERTENSIVA y asigna timeline IMMEDIATE', () => {
    const vitals = createMockVitals({
      bloodPressure: { value: { systolic: 195, diastolic: 125 }, confidence: 0.9, status: 'VALID' },
    });
    const score = healthRiskAnalyzer.analyze(vitals);

    expect(score.flags).toContain('CRISIS_HIPERTENSIVA');
    expect(score.flags).toContain('HIPERTENSION_SEVERA');
    expect(score.timeline).toBe('IMMEDIATE');
  });

  it('detecta DESATURACION_CRITICA y evalúa hipoxia severa', () => {
    const vitals = createMockVitals({
      spo2: { value: 84, confidence: 0.95, status: 'VALID' },
    });
    const score = healthRiskAnalyzer.analyze(vitals);

    expect(score.flags).toContain('DESATURACION_CRITICA');
    expect(score.flags).toContain('HIPOXIA_SEVERA');
    expect(score.timeline).toBe('IMMEDIATE');
  });

  it('evalúa frecuencia respiratoria fisiológica real: TAQUIPNEA y BRADIPNEA', () => {
    // Taquipnea
    const vitalsTachypnea = createMockVitals({
      respiration: { value: 28, confidence: 0.9, status: 'VALID' },
    });
    const scoreTach = healthRiskAnalyzer.analyze(vitalsTachypnea);
    expect(scoreTach.flags).toContain('TAQUIPNEA');
    expect(scoreTach.categories.respiratory).toBeGreaterThan(0.4);

    // Bradipnea
    const vitalsBradypnea = createMockVitals({
      respiration: { value: 8, confidence: 0.9, status: 'VALID' },
    });
    const scoreBrad = healthRiskAnalyzer.analyze(vitalsBradypnea);
    expect(scoreBrad.flags).toContain('BRADIPNEA');
    expect(scoreBrad.categories.respiratory).toBeGreaterThan(0.4);
  });

  it('NO inventa lecturas falsas ni dispara falsas alarmas ante signos ausentes o nulos', () => {
    // Vitals completamente sin medir (aún en calibración o sin dedo/rostro)
    const emptyVitals: VitalSignsResult = {
      heartRate: { value: 0, confidence: 0, status: 'INVALID' },
      spo2: { value: 0, confidence: 0, status: 'INVALID' },
      bloodPressure: { value: null as unknown as { systolic: number; diastolic: number }, confidence: 0, status: 'INVALID' },
      respiration: { value: 0, confidence: 0, status: 'INVALID' },
      arrhythmia: { value: null as unknown as { count: number; status: string; score?: number }, confidence: 0, status: 'INVALID' },
      signalQuality: 0,
      isCalibrating: true,
      calibrationProgress: 0,
    };

    const score = healthRiskAnalyzer.analyze(emptyVitals);

    // No debe disparar BRADICARDIA por hr === 0
    expect(score.flags).not.toContain('BRADICARDIA');
    expect(score.flags).not.toContain('CRISIS_HIPERTENSIVA');
    expect(score.flags).not.toContain('DESATURACION_CRITICA');
    expect(score.flags).not.toContain('BRADIPNEA');
    expect(score.overall).toBe(0);
  });

  it('normaliza dinámicamente los pesos sobre las categorías disponibles', () => {
    // Solo tenemos HR y SpO2
    const partialVitals: VitalSignsResult = {
      heartRate: { value: 72, confidence: 0.9, status: 'VALID' },
      spo2: { value: 98, confidence: 0.9, status: 'VALID' },
      bloodPressure: { value: null as unknown as { systolic: number; diastolic: number }, confidence: 0, status: 'INVALID' },
      respiration: { value: 0, confidence: 0, status: 'INVALID' },
      arrhythmia: { value: null as unknown as { count: number; status: string; score?: number }, confidence: 0, status: 'INVALID' },
      signalQuality: 85,
      isCalibrating: false,
      calibrationProgress: 100,
    };

    const score = healthRiskAnalyzer.analyze(partialVitals);
    expect(score.categories.cardiovascular).toBeCloseTo(0, 2);
    expect(score.categories.hypoxia).toBeCloseTo(0, 2);
    expect(score.overall).toBeCloseTo(0, 2);
    expect(score.timeline).toBe('NORMAL');
  });
});
