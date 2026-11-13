import { describe, expect, it } from 'vitest';
import { classifyLuminousFlow, type LuminousSample } from '../lensCoLocation';

/** Secuencia determinista de muestras RGB (medias 0–255) espaciadas 16 ms. */
function seq(n: number, rgb: (i: number) => [number, number, number], stepMs = 16): LuminousSample[] {
  return Array.from({ length: n }, (_, i) => {
    const [r, g, b] = rgb(i);
    return { tMs: i * stepMs, red: r, green: g, blue: b };
  });
}

describe('classifyLuminousFlow — profiling de co-ubicación lente/flash', () => {
  it('dedo sobre la lente junto al flash: rojo alto con firma de hemoglobina', () => {
    // El torch atraviesa el tejido: rojo alto, verde/azul absorbidos por la sangre.
    const samples = seq(10, i => [170 + i, 60 + Math.round(i * 0.5), 40]);
    const r = classifyLuminousFlow(samples, true);
    expect(r.verdict).toBe('finger-flash-lens');
    expect(r.redMean).toBeGreaterThanOrEqual(170);
  });

  it('lente cubierta a oscuras con torch activo → alerta de lente equivocada', () => {
    // Dedo sobre ultra gran angular/tele: la lente está tapada pero el LED no la ilumina.
    const samples = seq(10, () => [8, 8, 8]);
    const r = classifyLuminousFlow(samples, true);
    expect(r.verdict).toBe('lens-covered-dark');
  });

  it('oscuridad sin torch confirmado no acusa lente equivocada', () => {
    // Sin torch no se puede atribuir la oscuridad a una lente incorrecta.
    const samples = seq(10, () => [8, 8, 8]);
    const r = classifyLuminousFlow(samples, false);
    expect(r.verdict).toBe('indeterminate');
  });

  it('escena visible (sin dedo) no genera alerta', () => {
    // Lente libre: la escena tiene verde/azul con dominancia roja baja.
    const samples = seq(10, () => [90, 110, 100]);
    expect(classifyLuminousFlow(samples, true).verdict).toBe('scene-visible');
    expect(classifyLuminousFlow(samples, false).verdict).toBe('scene-visible');
  });

  it('ventana demasiado corta es indeterminada', () => {
    const samples = seq(3, () => [8, 8, 8]);
    expect(classifyLuminousFlow(samples, true).verdict).toBe('indeterminate');
  });

  it('rojo alto sin verde/azul medibles no afirma firma de dedo', () => {
    // Canal verde/azul muerto: sin ratios no hay firma de hemoglobina fiable.
    const samples = seq(10, () => [200, 0, 0]);
    expect(classifyLuminousFlow(samples, true).verdict).toBe('scene-visible');
  });

  it('lumaRise refleja el flujo lumínico del torch encendiéndose en la ventana', () => {
    // Primeros frames oscuros (torch encendiéndose), luego el tejido iluminado.
    const samples = seq(10, i => {
      const lit = i >= 4;
      return lit ? [190, 70, 40] : [10, 10, 10];
    });
    const r = classifyLuminousFlow(samples, true);
    expect(r.verdict).toBe('finger-flash-lens');
    expect(r.lumaRise).toBeGreaterThan(0);
  });
});
