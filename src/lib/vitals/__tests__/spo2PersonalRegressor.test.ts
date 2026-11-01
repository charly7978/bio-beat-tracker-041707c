import { describe, it, expect } from 'vitest';
import { fitSpo2PersonalRegressor, predictSpo2, SPO2_REGRESSOR_MIN_PAIRS } from '../spo2PersonalRegressor';

function makePairs(n: number, noise = 0): { timestampMs: number; features: number[]; referenceSpo2: number }[] {
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = 0.5 + i * 0.05;
    const y = 98 - 5 * x + (i % 2 === 0 ? 0.3 : -0.3) * noise;
    out.push({ timestampMs: i * 60000, features: [x, x * x, 1 / (x + 0.1)], referenceSpo2: y });
  }
  return out;
}

describe('spo2PersonalRegressor — regresión personal con banda p5-p95 (F4)', () => {
  it('min pares declarado', () => {
    expect(SPO2_REGRESSOR_MIN_PAIRS).toBe(6);
  });

  it('con <min pares → INSUFFICIENT_PAIRS', () => {
    const pairs = makePairs(3);
    const fit = fitSpo2PersonalRegressor(pairs);
    expect(fit.status).toBe('INSUFFICIENT_PAIRS');
    expect(fit.model).toBeNull();
  });

  it('recupera relación lineal con r alto y banda finita', () => {
    const pairs = makePairs(12);
    const fit = fitSpo2PersonalRegressor(pairs);
    expect(fit.status).toBe('FIT');
    expect(fit.model).not.toBeNull();
    expect(fit.model!.calibrated).toBe(true);
    expect(fit.r).not.toBeNull();
    expect(Math.abs(fit.r!)).toBeGreaterThan(0.9);
    expect(fit.model!.residualStd).toBeGreaterThanOrEqual(0);
    // banda p5 <= p95
    expect(fit.model!.residualP5).toBeLessThanOrEqual(fit.model!.residualP95);
  });

  it('predictSpo2 devuelve SpO2 y banda p5-p95 dentro de [50,100]', () => {
    const pairs = makePairs(12);
    const fit = fitSpo2PersonalRegressor(pairs);
    const model = fit.model!;
    const pred = predictSpo2(model, [0.7, 0.49, 1 / 0.8]);
    expect(pred).not.toBeNull();
    expect(pred!.spo2).toBeGreaterThanOrEqual(50);
    expect(pred!.spo2).toBeLessThanOrEqual(100);
    expect(pred!.p5).toBeLessThanOrEqual(pred!.p95);
    expect(pred!.p5).toBeGreaterThanOrEqual(50);
    expect(pred!.p95).toBeLessThanOrEqual(100);
  });

  it('predictSpo2 con dimensión incorrecta → null', () => {
    const pairs = makePairs(12);
    const model = fitSpo2PersonalRegressor(pairs).model!;
    expect(predictSpo2(model, [0.5])).toBeNull();
    expect(predictSpo2(model, [NaN, 1, 1])).toBeNull();
  });

  it('par inválido (SpO2 fuera de rango) se descarta antes del conteo', () => {
    const pairs = [...makePairs(6), { timestampMs: 999, features: [0.5, 0.25, 2], referenceSpo2: 200 }];
    const fit = fitSpo2PersonalRegressor(pairs);
    // 6 válidos quedan (el inválido descartado) → FIT
    expect(fit.status).toBe('FIT');
    expect(fit.model!.nPairs).toBe(6);
  });

  it('features inconsistentes (longitudes distintas) → UNSTABLE_MODEL', () => {
    const pairs = [
      ...makePairs(4),
      { timestampMs: 10, features: [0.5, 0.25], referenceSpo2: 95 },
      { timestampMs: 11, features: [0.6, 0.36, 1.1, 0.9], referenceSpo2: 94 },
      { timestampMs: 12, features: [0.7, 0.49, 0.8], referenceSpo2: 93 },
    ];
    // 7 pares pero longitudes inconsistentes → standardize devuelve null
    const fit = fitSpo2PersonalRegressor(pairs);
    expect(fit.status).toBe('UNSTABLE_MODEL');
  });

  it('modelo no calibrado no predice', () => {
    const model = { ...fitSpo2PersonalRegressor(makePairs(12)).model!, calibrated: false };
    expect(predictSpo2(model, [0.5, 0.25, 2])).toBeNull();
  });
});