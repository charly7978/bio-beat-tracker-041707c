import { describe, it, expect } from 'vitest';
import { BandpassFilter } from '../BandpassFilter';

function generate(fs: number, freqs: { f: number; a: number }[], dc = 100, n = 1024): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let v = dc;
    for (const { f, a } of freqs) v += a * Math.sin(2 * Math.PI * f * (i / fs));
    out.push(v);
  }
  return out;
}

function rms(x: number[], from = 0): number {
  let s = 0; let n = 0;
  for (let i = from; i < x.length; i++) { s += x[i] * x[i]; n++; }
  return Math.sqrt(s / Math.max(1, n));
}

describe('BandpassFilter', () => {
  it('attenuates DC component (>0.99 reduction in steady state)', () => {
    const f = new BandpassFilter(30);
    const dc = generate(30, [], 200, 600);
    let last = 0;
    for (const v of dc) last = f.filter(v);
    // ignore transient: take last 200 samples
    const tail = dc.slice(400).map(v => f.filter(v));
    expect(Math.abs(last)).toBeLessThan(5);
    expect(rms(tail)).toBeLessThan(2);
  });

  it('passes a 1.2 Hz cardiac-band sine and rejects 10 Hz noise', () => {
    const fs = 30;
    const cardiac = generate(fs, [{ f: 1.2, a: 5 }], 120, 900);
    const noise = generate(fs, [{ f: 10, a: 5 }], 120, 900);
    const fc = new BandpassFilter(fs);
    const fn = new BandpassFilter(fs);
    const yc = cardiac.map(v => fc.filter(v));
    const yn = noise.map(v => fn.filter(v));
    // skip transient
    const rmsC = rms(yc, 300);
    const rmsN = rms(yn, 300);
    expect(rmsC).toBeGreaterThan(rmsN * 2.0);
  });

  it('handles non-finite input safely', () => {
    const f = new BandpassFilter(30);
    expect(f.filter(NaN)).toBe(0);
    expect(f.filter(Infinity)).toBe(0);
  });

  it('reset() returns filter to zero state', () => {
    const f = new BandpassFilter(30);
    for (let i = 0; i < 100; i++) f.filter(150 + Math.sin(i));
    f.reset();
    expect(f.filter(0)).toBe(0);
  });

  it('setSampleRate recomputes coefficients without throwing', () => {
    const f = new BandpassFilter(30);
    f.filter(120);
    expect(() => f.setSampleRate(60)).not.toThrow();
    expect(Number.isFinite(f.filter(120))).toBe(true);
  });

  it('group delay is positive and bounded for a 1 Hz cardiac sine', () => {
    const fs = 30;
    const freq = 1.0;
    const f = new BandpassFilter(fs);
    const period = Math.round(fs / freq);
    for (let i = 0; i < 500; i++) f.filter(Math.sin((2 * Math.PI * freq * i) / fs));
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < period * 6; i++) {
      const x = Math.sin((2 * Math.PI * freq * (500 + i)) / fs);
      xs.push(x);
      ys.push(f.filter(x));
    }
    let bestLag = 0;
    let bestCorr = -Infinity;
    for (let lag = 0; lag < period; lag++) {
      let corr = 0;
      for (let i = 0; i < xs.length - lag; i++) corr += xs[i]! * ys[i + lag]!;
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }
    expect(bestLag).toBeGreaterThan(0);
    expect(bestLag).toBeLessThan(period);
  });

  it('re-tuning (setBand) produces no NaN and no transient explosion', () => {
    const fs = 30;
    const f = new BandpassFilter(fs, 4.5);
    for (let i = 0; i < 500; i++) f.filter(100 + 5 * Math.sin((2 * Math.PI * 1.2 * i) / fs));
    expect(f.setBand(0.5, 2.0)).toBe(true);
    for (let i = 0; i < 60; i++) {
      const v = f.filter(100 + 5 * Math.sin((2 * Math.PI * 1.2 * i) / fs));
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThan(20);
    }
  });

  it('setBand returns false when the change is below the 3% threshold', () => {
    const f = new BandpassFilter(30);
    expect(f.setBand(0.5, 4.5)).toBe(false);
  });

  it('impulse response decays to ~0 (BIBO / pole stability)', () => {
    const f = new BandpassFilter(30);
    let tailMax = 0;
    for (let i = 0; i < 2000; i++) {
      const v = f.filter(i === 0 ? 1 : 0);
      if (i > 1500 && Math.abs(v) > tailMax) tailMax = Math.abs(v);
    }
    expect(tailMax).toBeLessThan(1e-6);
  });

  it('all IIR poles lie strictly inside the unit circle', () => {
    const f = new BandpassFilter(30) as any;
    for (const stage of [f.hpfA, f.lpfA]) {
      for (const a of stage) {
        const b = a[1];
        const c = a[2];
        const disc = b * b - 4 * c;
        let mag: number;
        if (disc >= 0) {
          mag = Math.max(Math.abs((-b + Math.sqrt(disc)) / 2), Math.abs((-b - Math.sqrt(disc)) / 2));
        } else {
          const re = -b / 2;
          const im = Math.sqrt(-disc) / 2;
          mag = Math.sqrt(re * re + im * im);
        }
        expect(mag).toBeLessThan(1);
      }
    }
  });
});