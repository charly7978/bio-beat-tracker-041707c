import { describe, expect, it } from 'vitest';
import { derivePulseMorphology } from '../pulseMorphology';

const sample = (time: number, value: number, sourceValue?: number) => ({ time, value, sourceValue });

describe('morfología diferencial de observaciones PPG', () => {
  it('una señal constante conserva derivadas cero y los tiempos centrales observados', () => {
    const result = derivePulseMorphology([sample(0, 8), sample(20, 8), sample(60, 8), sample(100, 8)]);
    expect(result).toEqual([[
      { time: 20, velocity: 0, acceleration: 0 },
      { time: 60, velocity: 0, acceleration: 0 },
    ]]);
  });

  it('una rampa irregular conserva unidades por segundo y aceleración cero', () => {
    const times = [0, 11, 47, 93, 120, 225];
    const result = derivePulseMorphology(times.map(time => sample(time, 7 + 3 * time / 1000)));
    expect(result).toHaveLength(1);
    for (const point of result[0]) {
      expect(point.velocity).toBeCloseTo(3, 10);
      expect(point.acceleration).toBeCloseTo(0, 9);
    }
  });

  it('una curva cuadrática conserva ambas derivadas en el instante central a cadencia irregular', () => {
    const times = [0, 13, 65, 110, 170, 211];
    const result = derivePulseMorphology(times.map(time => {
      const t = time / 1000;
      return sample(time, 5 * t * t - 2 * t + 9);
    }));
    for (const point of result[0]) {
      expect(point.velocity).toBeCloseTo(10 * point.time / 1000 - 2, 9);
      expect(point.acceleration).toBeCloseTo(10, 8);
    }
  });

  it('no deriva la ganancia visual cuando existe el canal lineal original', () => {
    const result = derivePulseMorphology([
      sample(0, 20, 1), sample(50, 200, 2), sample(100, -90, 3), sample(150, 8000, 4),
    ]);
    expect(result[0].map(point => point.velocity)).toEqual([20, 20]);
    expect(result[0].map(point => point.acceleration)).toEqual([0, 0]);
  });

  it('conserva curvatura de amplitud muy débil sin un piso de aceleración absoluto', () => {
    const result = derivePulseMorphology([0, 13, 65, 110, 170].map(time => sample(time, (time / 1000) ** 2 * 1e-12)));
    for (const point of result[0]) expect(point.acceleration / 1e-12).toBeCloseTo(2, 10);
  });

  it('corta el segmento al perder observaciones sin unir ambos lados del hueco', () => {
    const result = derivePulseMorphology([
      sample(0, 0), sample(50, 1), sample(100, 2), sample(150, 3),
      sample(1000, 100), sample(1050, 101), sample(1100, 102), sample(1150, 103),
    ]);
    expect(result).toHaveLength(2);
    expect(result.map(segment => segment.map(point => point.time))).toEqual([[50, 100], [1050, 1100]]);
    for (const point of result.flat()) expect(point.velocity).toBeCloseTo(20);
  });

  it.each([NaN, Infinity])('un canal original inválido %s corta la continuidad aunque el display tenga un número', invalid => {
    const result = derivePulseMorphology([
      sample(0, 0, 0), sample(50, 1, 1), sample(100, 2, 2),
      sample(150, 3, invalid),
      sample(200, 4, 4), sample(250, 5, 5), sample(300, 6, 6),
    ]);
    expect(result.map(segment => segment.map(point => point.time))).toEqual([[50], [250]]);
  });

  it.each([50, 25])('un reloj repetido o invertido (%s ms) inicia otro segmento', time => {
    const result = derivePulseMorphology([
      sample(0, 0), sample(50, 1), sample(100, 2),
      sample(time, 3), sample(150, 4), sample(200, 5),
    ]);
    expect(result.map(segment => segment.map(point => point.time))).toEqual([[50], [150]]);
  });

  it('no crea un trazado cuando faltan tres observaciones continuas', () => {
    expect(derivePulseMorphology([])).toEqual([]);
    expect(derivePulseMorphology([sample(0, 5), sample(50, 6)])).toEqual([]);
    expect(derivePulseMorphology([sample(0, 5), sample(500, 6), sample(1000, 7)])).toEqual([]);
  });
});
