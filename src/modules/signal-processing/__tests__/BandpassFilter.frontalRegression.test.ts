import { describe, expect, it } from 'vitest';
import { BandpassFilter } from '../BandpassFilter';

// Deterministic laboratory inputs, confined to tests; not camera measurements.
const SAMPLE_RATES = [15, 24, 30, 60];
const DAMPING = [2 * Math.cos(Math.PI / 8), 2 * Math.cos(3 * Math.PI / 8)];

/** Independent analog Butterworth phase derivative after bilinear mapping.
 * Each HP/LP section has the same denominator phase derivative. Numerator
 * phase is constant away from DC/Nyquist in the analog domain.
 */
function referenceDelaySamples(fs: number, low: number, high: number, hz: number): number {
  const halfOmega = Math.PI * hz / fs;
  let delay = 0;
  for (const cutoff of [low, high]) {
    const k = Math.tan(Math.PI * cutoff / fs);
    const r = Math.tan(halfOmega) / k;
    const derivative = 0.5 / (Math.cos(halfOmega) ** 2 * k);
    for (const damping of DAMPING) {
      delay += damping * (1 + r * r) * derivative /
        ((1 - r * r) ** 2 + damping * damping * r * r);
    }
  }
  return delay;
}

/** Measure phase slope from the *executed* impulse response, not coefficients.
 * tau = -Im(H'(omega) / H(omega)), with H' from time-weighted samples.
 */
function measuredDelaySamples(impulse: Float64Array, fs: number, hz: number): number {
  const omega = 2 * Math.PI * hz / fs;
  let real = 0;
  let imaginary = 0;
  let derivativeReal = 0;
  let derivativeImaginary = 0;
  for (let n = 0; n < impulse.length; n++) {
    const c = Math.cos(omega * n);
    const s = Math.sin(omega * n);
    real += impulse[n] * c;
    imaginary -= impulse[n] * s;
    derivativeReal -= n * impulse[n] * s;
    derivativeImaginary -= n * impulse[n] * c;
  }
  const power = real * real + imaginary * imaginary;
  expect(power).toBeGreaterThan(0.01); // A zero-output filter must fail.
  return -(derivativeImaginary * real - derivativeReal * imaginary) / power;
}

function impulseResponse(filter: BandpassFilter, fs: number): Float64Array {
  const response = new Float64Array(fs * 60);
  for (let n = 0; n < response.length; n++) response[n] = filter.filter(n === 0 ? 1 : 0);
  return response;
}

// Test-only access to actual denominators: independently solve z²+a1*z+a2.
// Checking generated reference poles alone would miss a production regression.
type Denominators = { hpfA: number[][]; lpfA: number[][] };
function assertActualPoles(filter: BandpassFilter): void {
  const coefficients = filter as unknown as Denominators;
  for (const a of [...coefficients.hpfA, ...coefficients.lpfA]) {
    expect(a).toHaveLength(3);
    expect(a.every(Number.isFinite)).toBe(true);
    expect(a[0]).toBe(1);
    const discriminant = a[1] * a[1] - 4 * a[2];
    const radii = discriminant < 0
      ? [Math.sqrt(a[2]), Math.sqrt(a[2])]
      : [Math.abs((-a[1] + Math.sqrt(discriminant)) / 2),
        Math.abs((-a[1] - Math.sqrt(discriminant)) / 2)];
    for (const radius of radii) {
      expect(Number.isFinite(radius)).toBe(true);
      expect(radius).toBeLessThan(1 - 1e-6);
    }
  }
}

describe('Frontal path: shared BandpassFilter regression', () => {
  describe.each(SAMPLE_RATES)('group delay at %i fps', fs => {
    it.each([[0.5, 4.5], [0.8, 3.2], [1.1, 4.0]])(
      'matches independent phase derivative for %f–%f Hz', (low, high) => {
        const filter = new BandpassFilter(fs);
        filter.setBand(low, high);
        const band = filter.getBand();
        const response = impulseResponse(filter, fs);
        for (const hz of [0.8, 1.2, 2.0, 3.0]) {
          const measured = measuredDelaySamples(response, fs, hz);
          const reference = referenceDelaySamples(fs, band.low, band.high, hz);
          expect(measured).toBeGreaterThan(0);
          // 0.1 ms is far below one camera frame, even at 60 fps.
          expect(Math.abs(measured - reference) * 1000 / fs).toBeLessThan(0.1);
        }
      },
    );
  });

  describe.each(SAMPLE_RATES)('retuning at %i fps', fs => {
    it.each([0, Math.PI / 2, Math.PI])(
      'bounds transient energy and settling at phase %f', phase => {
        const filter = new BandpassFilter(fs);
        const target = new BandpassFilter(fs);
        target.setBand(0.8, 3.2);
        const input = (n: number) => Math.sin(2 * Math.PI * 1.2 * n / fs + phase);
        const warmup = fs * 30;
        for (let n = 0; n < warmup; n++) {
          filter.filter(input(n));
          target.filter(input(n));
        }
        expect(filter.setBand(0.8, 3.2)).toBe(true);
        let errorEnergy = 0;
        let referenceEnergy = 0;
        let peak = 0;
        let tailError = 0;
        for (let n = 0; n < fs * 12; n++) {
          const actual = filter.filter(input(warmup + n));
          const expected = target.filter(input(warmup + n));
          expect(Number.isFinite(actual)).toBe(true);
          peak = Math.max(peak, Math.abs(actual));
          if (n < fs * 2) {
            errorEnergy += (actual - expected) ** 2;
            referenceEnergy += expected ** 2;
          }
          if (n >= fs * 8) tailError = Math.max(tailError, Math.abs(actual - expected));
        }
        // Unit-amplitude POS-band input: <=25% overshoot; transient error
        // energy <=25% of steady-state signal energy during first 2 seconds.
        expect(peak).toBeLessThan(1.25);
        expect(referenceEnergy).toBeGreaterThan(fs * 0.5);
        expect(errorEnergy / referenceEnergy).toBeLessThan(0.25);
        expect(tailError).toBeLessThan(0.001);
      },
    );

    it('ignores sub-deadband tuning without disturbing IIR state', () => {
      const tuned = new BandpassFilter(fs);
      const control = new BandpassFilter(fs);
      for (let n = 0; n < fs * 20; n++) {
        const input = Math.sin(2 * Math.PI * 1.2 * n / fs);
        if (n === fs * 10) expect(tuned.setBand(0.51, 4.59)).toBe(false);
        expect(tuned.filter(input)).toBe(control.filter(input));
      }
    });
  });

  it.each(SAMPLE_RATES)('keeps actual poles inside the unit circle at %i fps', fs => {
    const filter = new BandpassFilter(fs);
    assertActualPoles(filter);
    // Include band edges, inverted requests (sanitized by setBand), near
    // Nyquist and repeated forward/reverse retunes, not only nominal HR.
    const bands = [[0.15, 0.3], [0.5, 4.5], [1.2, 2.8], [3, 1], [0.2, fs], [2, 4.5]];
    for (const rate of [fs, fs + 0.3, fs * 0.9, fs]) {
      filter.setSampleRate(rate);
      assertActualPoles(filter);
      for (const [low, high] of [...bands, ...bands.slice().reverse()]) {
        filter.setBand(low, high);
        assertActualPoles(filter);
        // Also exercise states: the runtime overflow guard cannot substitute
        // for stable roots, and zero output cannot substitute for a response.
        const response = impulseResponse(filter, rate);
        expect(response.every(Number.isFinite)).toBe(true);
        expect(response.some(value => Math.abs(value) > 1e-6)).toBe(true);
        expect(Math.max(...response.slice(-Math.floor(rate)) .map(Math.abs))).toBeLessThan(0.001);
        filter.reset();
      }
    }
  });
});