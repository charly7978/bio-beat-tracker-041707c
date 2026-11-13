import { describe, expect, it } from 'vitest';
import { resampleTimedSignal } from '../timedSamples';

function makeSamples(rateHz: number, seconds = 4, jitterMs = 0) {
  const result = [];
  const nominalStep = 1000 / rateHz;
  const count = Math.floor(rateHz * seconds);
  for (let i = 0; i < count; i++) {
    const timestampMs = 10_000 + i * nominalStep + (i % 2 === 0 ? jitterMs : -jitterMs);
    result.push({
      timestampMs,
      value: Math.sin((2 * Math.PI * 1.2 * i) / rateHz),
    });
  }
  return result;
}

describe('resampleTimedSignal', () => {
  it('conserva una señal nominal de 30 Hz y devuelve frecuencia medida', () => {
    const result = resampleTimedSignal(makeSamples(30));
    expect(result).not.toBeNull();
    expect(result!.sampleRateHz).toBeCloseTo(30, 0);
    expect(result!.samples.length).toBeGreaterThanOrEqual(90);
  });

  it('no eleva una captura de 24 Hz a 30 Hz', () => {
    const result = resampleTimedSignal(makeSamples(24));
    expect(result).not.toBeNull();
    expect(result!.sampleRateHz).toBeCloseTo(24, 0);
  });

  it('rechaza una captura demasiado lenta para morfología PPG', () => {
    expect(resampleTimedSignal(makeSamples(15))).toBeNull();
  });

  it('tolera jitter moderado de timestamps', () => {
    const result = resampleTimedSignal(makeSamples(30, 4, 2));
    expect(result).not.toBeNull();
    expect(result!.jitterRatio).toBeLessThan(0.35);
  });

  it('rechaza timestamps fuera de orden y huecos excesivos', () => {
    const outOfOrder = makeSamples(30);
    outOfOrder[20] = { ...outOfOrder[20], timestampMs: outOfOrder[19].timestampMs - 1 };
    expect(resampleTimedSignal(outOfOrder)).toBeNull();

    const withGap = makeSamples(30);
    withGap[60] = { ...withGap[60], timestampMs: withGap[60].timestampMs + 250 };
    expect(resampleTimedSignal(withGap)).toBeNull();
  });
});
