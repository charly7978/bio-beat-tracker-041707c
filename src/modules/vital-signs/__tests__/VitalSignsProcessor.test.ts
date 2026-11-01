import { describe, expect, it } from 'vitest';
import { VitalSignsProcessor } from '../VitalSignsProcessor';
import { DisplaySmoothing } from '../DisplaySmoothing';
import { SpO2Calculator } from '../SpO2Calculator';

describe('VitalSignsProcessor', () => {
  it('se inicializa con valores correctos', () => {
    const proc = new VitalSignsProcessor();
    const result = proc.reset();
    expect(result).toBeDefined();
    expect(result!.heartRate.value).toBeNull();
    expect(result!.spo2.value).toBeNull();
  });

  it('smoothWeightedValue actualiza con mayor velocidad ante alta confianza y viceversa', () => {
    const smoother = new DisplaySmoothing();
    
    // Test con peso = 1.0 (alta confianza)
    const valHighConf = smoother.smoothWeightedValue(120, 140, 1.0, 'stable');
    
    // Test con peso = 0.1 (baja confianza)
    const valLowConf = smoother.smoothWeightedValue(120, 140, 0.1, 'stable');

    // Alta confianza debe estar más cerca del nuevo valor (140)
    // que baja confianza (que debe quedarse más cerca del valor previo 120).
    const diffHigh = Math.abs(valHighConf - 140);
    const diffLow = Math.abs(valLowConf - 140);

    expect(diffHigh).toBeLessThan(diffLow);
    
    // Ambas salidas deben ser valores numéricos finitos y coherentes
    expect(isFinite(valHighConf)).toBe(true);
    expect(isFinite(valLowConf)).toBe(true);
    expect(valHighConf).toBeGreaterThan(120);
    expect(valLowConf).toBeGreaterThan(120);
  });

  it('SpO2Calculator rechaza DC insuficiente', () => {
    const calc = new SpO2Calculator();
    const result = calc.calculate(
      { redAC: 0.5, redDC: 5, greenAC: 0.3, greenDC: 3 },
      0,
    );
    expect(result.value).toBe(0);
  });

  it('procesa señales válidas y actualiza el estado de las mediciones', () => {
    const proc = new VitalSignsProcessor();
    
    const result = proc.processSignal(
      150,
      75,
      72,
      { intervals: [833, 830, 835], lastPeakTime: Date.now() },
      0.0035,
      { sqi: 75 }
    );

    expect(result).toBeDefined();
    expect(result.signalQuality).toBe(75);
  });

  it('NUNCA afirma "SIN ARRITMIAS": el estado inicial es CALIBRANDO (sin evidencia no hay veredicto)', () => {
    const proc = new VitalSignsProcessor();
    const result = proc.reset();
    expect(result!.arrhythmia.value?.status).toBe('CALIBRANDO...');
  });

  it('propaga la respiración del acelerómetro (modalidad ACC) a la Smart Fusion', () => {
    const proc = new VitalSignsProcessor();
    // Ventana suficiente para respiración: >=132 muestras de banda respiratoria
    // (RESPIRATION_BUFFER=320, gate minBuffer*0.55=132) y estabilidad sostenida
    // (stableFramesCount >= 90 → confianza HIGH con sqi 75 y 4+ RR válidos).
    for (let i = 0; i < 160; i++) {
      const resp = 150 + 20 * Math.sin(2 * Math.PI * 0.233 * (i / 10)); // ~14 rpm @10Hz
      proc.processSignal(
        resp,
        75,
        72,
        { intervals: [833, 830, 835, 828], lastPeakTime: Date.now() },
        0.0035,
        { sqi: 75 },
        resp,
        undefined,
        { rpm: 14, quality: 0.8 },
      );
    }
    const result = proc.processSignal(
      150, 75, 72,
      { intervals: [833, 830, 835], lastPeakTime: Date.now() },
      0.0035,
      { sqi: 75 },
      150,
      undefined,
      { rpm: 14, quality: 0.8 },
    );
    const mods = result.respiration.diagnostics?.modalities as
      | { acc?: { available: boolean; rpm: number } }
      | undefined;
    // La modalidad ACC del acelerómetro debe estar disponible en la fusión —
    // antes del fix el wiring la descartaba sistemáticamente.
    expect(mods?.acc?.available).toBe(true);
    expect(mods?.acc?.rpm).toBe(14);
  });
});
