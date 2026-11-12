import { describe, it, expect } from 'vitest';
import { goertzelMagnitude, savitzkyGolaySecondDeriv } from '../dsp';

describe('goertzelMagnitude', () => {
  const fs = 30;
  const n = 256;

  function sine(freq: number, amp: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(amp * Math.sin((2 * Math.PI * freq * i) / fs));
    return out;
  }

  it('recupera la amplitud de un seno en su frecuencia', () => {
    const amp = 3.5;
    const mag = goertzelMagnitude(sine(1.2, amp), 1.2, fs);
    // 2·|X|/N ≈ amplitud del seno; tolerancia por longitud finita.
    expect(mag).toBeGreaterThan(amp * 0.85);
    expect(mag).toBeLessThan(amp * 1.15);
  });

  it('da magnitud baja fuera de la frecuencia del seno', () => {
    const onFreq = goertzelMagnitude(sine(1.2, 3), 1.2, fs);
    const offFreq = goertzelMagnitude(sine(1.2, 3), 2.6, fs);
    expect(offFreq).toBeLessThan(onFreq * 0.5);
  });

  it('es invariante al offset DC (lo elimina internamente)', () => {
    const base = sine(1.0, 2);
    const shifted = base.map((v) => v + 50);
    expect(Math.abs(goertzelMagnitude(base, 1.0, fs) - goertzelMagnitude(shifted, 1.0, fs))).toBeLessThan(1e-6);
  });

  it('retorna 0 con entrada degenerada o frecuencia sobre Nyquist', () => {
    expect(goertzelMagnitude([1, 2], 1, fs)).toBe(0);
    expect(goertzelMagnitude(sine(1, 1), 20, fs)).toBe(0); // > fs/2
  });
});

describe('savitzkyGolaySecondDeriv', () => {
  it('2ª derivada de una parábola y=x² es ≈ 2 en el interior', () => {
    const y: number[] = [];
    for (let x = -30; x <= 30; x++) y.push(x * x);
    const d2 = savitzkyGolaySecondDeriv(y, 4);
    for (let i = 10; i < y.length - 10; i++) {
      expect(Math.abs(d2[i] - 2)).toBeLessThan(1e-6);
    }
  });

  it('aproxima −ω²·sin en un seno y atenúa ruido mejor que la diferencia finita', () => {
    const n = 200;
    const w = 0.3; // rad/muestra
    const clean: number[] = [];
    const noisy: number[] = [];
    let seed = 7;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    for (let i = 0; i < n; i++) {
      const s = Math.sin(w * i);
      clean.push(s);
      noisy.push(s + rng() * 0.02);
    }
    const sg = savitzkyGolaySecondDeriv(noisy, 5);
    // Error RMS vs la 2ª derivada analítica, en el interior.
    let sgErr = 0;
    let fdErr = 0;
    let cnt = 0;
    for (let i = 20; i < n - 20; i++) {
      const truth = -w * w * Math.sin(w * i);
      const fd = noisy[i + 1] - 2 * noisy[i] + noisy[i - 1];
      sgErr += (sg[i] - truth) ** 2;
      fdErr += (fd - truth) ** 2;
      cnt++;
    }
    sgErr = Math.sqrt(sgErr / cnt);
    fdErr = Math.sqrt(fdErr / cnt);
    expect(sgErr).toBeLessThan(fdErr);
  });

  it('preserva la longitud del array', () => {
    const y = new Array(50).fill(0).map((_, i) => Math.sin(i / 5));
    expect(savitzkyGolaySecondDeriv(y, 4)).toHaveLength(50);
  });
});
