import { describe, expect, it } from 'vitest';
import { RingF32 } from '../RingBuffer';

describe('RingF32', () => {
  it('inicializa vacío con length 0 y reset funcional', () => {
    const ring = new RingF32(4);
    expect(ring.length).toBe(0);
    expect(ring.last()).toBe(0);
    expect(ring.mean()).toBe(0);
    expect(ring.stdDev()).toBe(0);

    ring.push(10);
    expect(ring.length).toBe(1);
    expect(ring.last()).toBe(10);
    expect(ring.mean()).toBe(10);
    expect(ring.stdDev()).toBe(0);

    ring.reset();
    expect(ring.length).toBe(0);
    expect(ring.last()).toBe(0);
  });

  it('guarda y rota valores correctamente (wrap around)', () => {
    const ring = new RingF32(3);
    ring.push(1);
    ring.push(2);
    ring.push(3);
    expect(ring.length).toBe(3);
    expect(ring.tail(3)).toEqual([1, 2, 3]);

    ring.push(4); // Sobrescribe 1
    expect(ring.length).toBe(3);
    expect(ring.last()).toBe(4);
    expect(ring.tail(3)).toEqual([2, 3, 4]);
    expect(ring.tail(2)).toEqual([3, 4]);
  });

  it('calcula mean y stdDev zero-allocation idénticos a los de referencia', () => {
    const ring = new RingF32(8);
    const data = [2, 4, 4, 4, 5, 5, 7, 9];
    for (const v of data) {
      ring.push(v);
    }
    expect(ring.mean()).toBeCloseTo(5.0, 4);
    expect(ring.stdDev()).toBeCloseTo(2.0, 4);

    // Con wrap-around: agregar más valores
    const ringWrap = new RingF32(4);
    ringWrap.push(100);
    ringWrap.push(200);
    ringWrap.push(10);
    ringWrap.push(20);
    ringWrap.push(30); // Desplaza 100
    ringWrap.push(40); // Desplaza 200 -> quedan [10, 20, 30, 40]

    expect(ringWrap.mean()).toBeCloseTo(25.0, 4);
    // Varianza de [10, 20, 30, 40]: mean=25, sumSqDiff = 225+25+25+225 = 500 / 4 = 125, sqrt = 11.1803
    expect(ringWrap.stdDev()).toBeCloseTo(Math.sqrt(125), 4);
  });

  it('copyTailInto copia sin alocar memoria', () => {
    const ring = new RingF32(5);
    ring.push(1);
    ring.push(2);
    ring.push(3);
    const out = new Float32Array(3);
    const copied = ring.copyTailInto(out, 2);
    expect(copied).toBe(2);
    expect(out[0]).toBe(2);
    expect(out[1]).toBe(3);
  });
});
