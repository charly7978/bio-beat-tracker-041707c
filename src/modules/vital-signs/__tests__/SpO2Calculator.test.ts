import { describe, expect, it } from 'vitest';
import { SpO2Calculator } from '../SpO2Calculator';

/**
 * Tests de SpO2Calculator — verifican especialmente que NO existe clamp
 * inferior fisiológico forzado (regla "sin lectura" sobre lectura falseada):
 * si el modelo dice <75, devuelve <75 y el gating de publicación decide
 * mostrar o '--'.
 */
describe('SpO2Calculator', () => {
  it('rechaza DC insuficiente', () => {
    const calc = new SpO2Calculator();
    const result = calc.calculate(
      { redAC: 0.5, redDC: 5, greenAC: 0.3, greenDC: 3 },
      0,
    );
    expect(result.value).toBe(0);
  });

  it('NO clampea al piso 75%: una desaturación real se devuelve cruda', () => {
    const calc = new SpO2Calculator();
    // R alto (rojo poco modulado vs verde) → el modelo cuadrático produce un
    // valor claramente < 75%. Antes del fix se devolvía exactamente 75
    // (Math.max(MIN_VALID, ...)), enmascarando la desaturación.
    let last = 0;
    for (let i = 0; i < 15; i++) {
      last = calc.calculate(
        { redAC: 0.52, redDC: 50, greenAC: 0.15, greenDC: 30 },
        i,
      ).value;
    }
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThan(75);
  });

  it('nunca devuelve valores por encima del 100% físico', () => {
    const calc = new SpO2Calculator();
    // R muy bajo (verde dominante) → modelo por encima de 100 → CAP en 100.
    let last = 0;
    for (let i = 0; i < 15; i++) {
      last = calc.calculate(
        { redAC: 0.1, redDC: 50, greenAC: 3, greenDC: 30 },
        i,
      ).value;
    }
    expect(last).toBeLessThanOrEqual(100);
  });

  it('devuelve 0 (no inventa) cuando R cae fuera del rango físico', () => {
    const calc = new SpO2Calculator();
    // R enorme → fuera de [R_VALUE_MIN, R_VALUE_MAX] → 0 → UI muestra '--'.
    let last = -1;
    for (let i = 0; i < 15; i++) {
      last = calc.calculate(
        { redAC: 40, redDC: 10, greenAC: 0.001, greenDC: 5 },
        i,
      ).value;
    }
    expect(last).toBe(0);
  });
});
