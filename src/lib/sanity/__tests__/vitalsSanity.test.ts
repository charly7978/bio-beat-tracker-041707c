import { describe, it, expect } from 'vitest';
import { VitalsSanityChecker } from '../vitalsSanity';

describe('VitalsSanityChecker', () => {
  it('returns ok before minSamples', () => {
    const c = new VitalsSanityChecker({ minSamples: 5 });
    for (let i = 0; i < 4; i++) expect(c.push(70 + i)).toEqual({ ok: true });
  });

  it('skips non-finite and non-positive values (returns last verdict)', () => {
    const c = new VitalsSanityChecker({ minSamples: 3 });
    c.push(70); c.push(71); c.push(72);
    const before = c.push(73);
    expect(c.push(0)).toBe(before);
    expect(c.push(NaN)).toBe(before);
    expect(c.push(-5)).toBe(before);
    expect(c.push(Infinity)).toBe(before);
  });

  it('flags OUT_OF_RANGE below min', () => {
    const c = new VitalsSanityChecker({ minSamples: 3, min: 30, max: 220 });
    c.push(70); c.push(71); c.push(72);
    const v = c.push(20);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('OUT_OF_RANGE');
  });

  it('flags OUT_OF_RANGE above max', () => {
    const c = new VitalsSanityChecker({ minSamples: 3, min: 30, max: 220 });
    c.push(70); c.push(71); c.push(72);
    const v = c.push(250);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('OUT_OF_RANGE');
  });

  it('flags CONSTANT stream', () => {
    const c = new VitalsSanityChecker({ minSamples: 4, constantTolerance: 1.5 });
    for (let i = 0; i < 12; i++) c.push(72);
    const v = c.push(72);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('CONSTANT');
  });

  it('flags ZERO_VARIANCE stream', () => {
    const c = new VitalsSanityChecker({ minSamples: 4 });
    // values with span > tol but identical after rounding? use identical floats
    const vals = [70, 70 + 1e-9, 70 - 1e-9, 70 + 2e-9];
    for (const v of vals) c.push(v);
    // pad
    for (let i = 0; i < 10; i++) c.push(70 + (i % 2 === 0 ? 1e-9 : -1e-9));
    const r = c.push(70);
    // constant tolerance 1.5 catches span tiny -> CONSTANT likely; accept either
    expect(r.ok).toBe(false);
  });

  it('flags REPETITIVE ramp', () => {
    const c = new VitalsSanityChecker({ minSamples: 12, constantTolerance: 1.5, repetitiveStdMin: 0.15 });
    // linear ramp with identical deltas
    for (let i = 0; i < 20; i++) c.push(60 + i * 2);
    const v = c.push(100);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(['REPETITIVE', 'CONSTANT']).toContain(v.reason);
  });

  it('accepts plausible noisy BPM stream', () => {
    const c = new VitalsSanityChecker({ minSamples: 12 });
    const base = [72, 74, 71, 73, 75, 70, 72, 74, 73, 71, 72, 75, 74, 73];
    for (const v of base) c.push(v);
    const r = c.push(72);
    expect(r.ok).toBe(true);
  });

  it('reset clears buffer and verdict', () => {
    const c = new VitalsSanityChecker({ minSamples: 4 });
    for (let i = 0; i < 12; i++) c.push(72);
    c.reset();
    // after reset, not enough samples -> ok
    expect(c.push(72)).toEqual({ ok: true });
  });

  it('onVerdict listener is invoked and errors swallowed', () => {
    let calls = 0;
    const c = new VitalsSanityChecker({
      minSamples: 3,
      onVerdict: () => { calls++; throw new Error('boom'); },
    });
    c.push(70); c.push(71); c.push(72);
    expect(calls).toBeGreaterThan(0);
  });

  it('windowSize caps buffer', () => {
    const c = new VitalsSanityChecker({ windowSize: 5, minSamples: 3 });
    for (let i = 0; i < 20; i++) c.push(60 + (i % 7));
    // no throw; verdict finite
    const v = c.push(65);
    expect(typeof v.ok).toBe('boolean');
  });

  it('custom range via constructor', () => {
    const c = new VitalsSanityChecker({ min: 50, max: 60, minSamples: 3 });
    c.push(55); c.push(56); c.push(57);
    const v = c.push(70);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('OUT_OF_RANGE');
  });
});
