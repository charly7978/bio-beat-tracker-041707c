import { describe, expect, it } from 'vitest';
import { computeWindowMoments } from '../dsp';

/**
 * Contrato de escala de los momentos que alimentan el scoring SQI
 * (VITAL_THRESHOLDS.QUALITY.SKEWNESS_SQI_* / KURTOSIS_SQI_*).
 *
 * Regresión del bug de escala (auditoría 2026-10): el productor entregaba
 * kurtosis CRUDA de Pearson (β₂ ≥ 0, ≈3 para ruido gaussiano) contra umbrales
 * de EXCESO (β₂−3) → el término valía ~6/6 en cualquier ventana, incluido ruido.
 */
describe('computeWindowMoments', () => {
  it('ventana simétrica → skewness ≈ 0', () => {
    const symmetric = [-3, -2, -1, -1, 0, 0, 1, 1, 2, 3];
    const m = computeWindowMoments(symmetric);
    expect(Math.abs(m.skewness)).toBeLessThan(1e-9);
  });

  it('ventana con cola derecha (subida sistólica) → skewness > 0', () => {
    // Muchas muestras cercanas a la línea base con picos agudos positivos:
    // firma de PPG limpio (Elgendi 2016: skewness positivo = pulso real).
    const pulseLike: number[] = [];
    for (let i = 0; i < 30; i++) pulseLike.push(i === 10 || i === 20 ? 5 : 0.1);
    const m = computeWindowMoments(pulseLike);
    expect(m.skewness).toBeGreaterThan(0.5);
  });

  it('ventana uniforme discreta → exceso de kurtosis ≈ −1.2 (platicúrtica, score 0)', () => {
    const uniform: number[] = [];
    for (let i = 0; i < 20; i++) uniform.push(i);
    const m = computeWindowMoments(uniform);
    // Uniforme continua: β₂ = 1.8 → exceso = −1.2; discreta con n=20 se aproxima.
    expect(m.kurtosis).toBeLessThan(-0.9);
    expect(m.kurtosis).toBeGreaterThan(-1.6);
  });

  it('ventana con outlier agudo → exceso de kurtosis alto (leptocúrtica, score máximo)', () => {
    const spiky: number[] = [];
    for (let i = 0; i < 30; i++) spiky.push(i === 7 ? 10 : 0);
    const m = computeWindowMoments(spiky);
    expect(m.kurtosis).toBeGreaterThan(3);
  });

  it('ventana degenerada (constante) → momentos en 0, sin NaN', () => {
    const flat = new Array<number>(40).fill(2.5);
    const m = computeWindowMoments(flat);
    expect(m.std).toBe(0);
    expect(m.skewness).toBe(0);
    expect(m.kurtosis).toBe(0);
    expect(Number.isFinite(m.variance)).toBe(true);
  });

  it('ventana < 3 muestras → ceros defensivos', () => {
    const m = computeWindowMoments([1, 2]);
    expect(m).toEqual({ mean: 0, variance: 0, std: 0, skewness: 0, kurtosis: 0 });
  });

  it('kurtosis de referencia: seno discreto ≈ exceso −0.6…−1.2 (no positiva)', () => {
    // Un seno puro tiene β₂ = 1.5 → exceso −1.5 para la forma de onda completa;
    // con media no cero el valor se desplaza hacia 0 pero NUNCA positivo alto.
    const sine: number[] = [];
    for (let i = 0; i < 64; i++) sine.push(Math.sin((2 * Math.PI * i) / 32));
    const m = computeWindowMoments(sine);
    expect(m.kurtosis).toBeLessThan(-0.5);
    expect(Math.abs(m.skewness)).toBeLessThan(1e-9);
  });
});
