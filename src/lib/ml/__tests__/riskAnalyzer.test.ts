import { describe, expect, it } from 'vitest';
import { HealthRiskAnalyzer, healthRiskAnalyzer } from '../riskAnalyzer';
import type { VitalSignsResult } from '../../../modules/vital-signs/VitalSignsProcessor';
import type { MeasurementStatus, VitalMeasurement } from '../../../types/measurements';

function makeMeasurement<T>(
  name: string,
  value: T | null,
  unit: string,
  status: MeasurementStatus = 'VALID',
  confidence = 0.9,
): VitalMeasurement<T> {
  return {
    name,
    value,
    unit,
    timestamp: Date.now(),
    confidence,
    status,
    reason: 'clinical test',
    signalQuality: {
      sqi: 90,
      perfusionIndex: 1.5,
      snr: 10,
      periodicity: 0.9,
      motionScore: 0.05,
      saturationRatio: 0,
      frameDropRatio: 0,
      fpsEffective: 30,
      timestampJitterMs: 1,
    },
    diagnostics: {},
  };
}

function createMockVitals(overrides: Partial<VitalSignsResult> = {}): VitalSignsResult {
  return {
    heartRate: makeMeasurement('Heart Rate', 72, 'BPM'),
    spo2: makeMeasurement('SpO2', 98, '%'),
    bloodPressure: makeMeasurement('Blood Pressure', { systolic: 120, diastolic: 80 }, 'mmHg'),
    respiration: makeMeasurement('Respiration', 16, 'RPM'),
    arrhythmia: makeMeasurement('Arrhythmia', { count: 0, status: 'NORMAL', score: 0 }, 'events'),
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

  it('detecta y marca TAQUICARDIA desde pulso medido', () => {
    const vitals = createMockVitals({
      heartRate: makeMeasurement('Heart Rate', 135, 'BPM'),
    });
    const score = healthRiskAnalyzer.analyze(vitals);

    expect(score.flags).toContain('TAQUICARDIA');
    expect(score.categories.cardiovascular).toBeGreaterThan(0.2);
  });

  it('detecta y marca BRADICARDIA cuando HR < 50', () => {
    const vitals = createMockVitals({
      heartRate: makeMeasurement('Heart Rate', 44, 'BPM'),
    });
    const score = healthRiskAnalyzer.analyze(vitals);

    expect(score.flags).toContain('BRADICARDIA');
  });

  it('NO puntúa PA experimental: sin banderas de hipertensión aunque sys/dia altos', () => {
    const vitals = createMockVitals({
      bloodPressure: makeMeasurement('Blood Pressure', { systolic: 195, diastolic: 125 }, 'mmHg'),
    });
    const score = healthRiskAnalyzer.analyze(vitals);

    expect(score.flags).not.toContain('CRISIS_HIPERTENSIVA');
    expect(score.flags).not.toContain('HIPERTENSION_SEVERA');
    expect(score.flags).not.toContain('HIPERTENSION_MODERADA');
    expect(score.categories.hypertension).toBe(0);
  });

  it('NO puntúa SpO2 experimental: sin banderas de hipoxia aunque SpO2 baja', () => {
    const vitals = createMockVitals({
      spo2: makeMeasurement('SpO2', 84, '%'),
    });
    const score = healthRiskAnalyzer.analyze(vitals);

    expect(score.flags).not.toContain('DESATURACION_CRITICA');
    expect(score.flags).not.toContain('HIPOXIA_SEVERA');
    expect(score.categories.hypoxia).toBe(0);
  });

  it('NO puntúa respiración experimental: sin banderas TAQUIPNEA/BRADIPNEA', () => {
    // Taquipnea
    const vitalsTachypnea = createMockVitals({
      respiration: makeMeasurement('Respiration', 28, 'RPM'),
    });
    const scoreTach = healthRiskAnalyzer.analyze(vitalsTachypnea);
    expect(scoreTach.flags).not.toContain('TAQUIPNEA');
    expect(scoreTach.categories.respiratory).toBe(0);

    // Bradipnea
    const vitalsBradypnea = createMockVitals({
      respiration: makeMeasurement('Respiration', 8, 'RPM'),
    });
    const scoreBrad = healthRiskAnalyzer.analyze(vitalsBradypnea);
    expect(scoreBrad.flags).not.toContain('BRADIPNEA');
    expect(scoreBrad.categories.respiratory).toBe(0);
  });

  it('NO inventa lecturas falsas ni dispara falsas alarmas ante signos ausentes o nulos', () => {
    // Vitals completamente sin medir (aún en calibración o sin dedo/rostro)
    const emptyVitals: VitalSignsResult = {
      heartRate: makeMeasurement<number>('Heart Rate', null, 'BPM', 'NO_VALID_SIGNAL', 0),
      spo2: makeMeasurement<number>('SpO2', null, '%', 'NO_VALID_SIGNAL', 0),
      bloodPressure: makeMeasurement<{ systolic: number; diastolic: number }>('Blood Pressure', null, 'mmHg', 'NO_VALID_SIGNAL', 0),
      respiration: makeMeasurement<number>('Respiration', null, 'RPM', 'NO_VALID_SIGNAL', 0),
      arrhythmia: makeMeasurement<{ count: number; status: string; score?: number }>('Arrhythmia', null, 'events', 'NO_VALID_SIGNAL', 0),
      signalQuality: 0,
      isCalibrating: true,
      calibrationProgress: 0,
    };

    const score = healthRiskAnalyzer.analyze(emptyVitals);

    // No debe disparar BRADICARDIA por hr === null/0
    expect(score.flags).not.toContain('BRADICARDIA');
    expect(score.flags).not.toContain('CRISIS_HIPERTENSIVA');
    expect(score.flags).not.toContain('DESATURACION_CRITICA');
    expect(score.flags).not.toContain('BRADIPNEA');
    expect(score.overall).toBe(0);
  });

  it('normaliza dinámicamente los pesos sobre las categorías disponibles', () => {
    // Solo tenemos HR y SpO2
    const partialVitals: VitalSignsResult = {
      heartRate: makeMeasurement('Heart Rate', 72, 'BPM'),
      spo2: makeMeasurement('SpO2', 98, '%'),
      bloodPressure: makeMeasurement<{ systolic: number; diastolic: number }>('Blood Pressure', null, 'mmHg', 'NO_VALID_SIGNAL', 0),
      respiration: makeMeasurement<number>('Respiration', null, 'RPM', 'NO_VALID_SIGNAL', 0),
      arrhythmia: makeMeasurement<{ count: number; status: string; score?: number }>('Arrhythmia', null, 'events', 'NO_VALID_SIGNAL', 0),
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
