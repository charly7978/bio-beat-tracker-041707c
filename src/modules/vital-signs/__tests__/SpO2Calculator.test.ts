import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpO2Calculator, type RGBData } from '../SpO2Calculator';
import * as ica from '../../../utils/ica';

function observation(timeSeconds: number): RGBData {
  const pulse = Math.sin(2 * Math.PI * 2 * timeSeconds);
  return {
    redAC: 0.6 * pulse + 0.1 * Math.cos(2 * Math.PI * 0.3 * timeSeconds), redDC: 160,
    greenAC: 1.2 * pulse, greenDC: 100,
    blueAC: 0.4 * pulse + 0.2 * Math.cos(2 * Math.PI * 0.7 * timeSeconds), blueDC: 80,
  };
}

function feed(calc: SpO2Calculator, hz: number, count = 64, startMs = 10_000) {
  for (let i = 0; i < count; i++) calc.calculate(observation(i / hz), i + 1, startMs + i * 1000 / hz);
}

describe('SpO2 optical observation clock', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([8, 10, 20, 30])('derives ICA lags from %i Hz RGB observations', hz => {
    const split = vi.spyOn(ica, 'fastICA').mockReturnValue(null);
    const calc = new SpO2Calculator();
    feed(calc, hz);
    const timing = calc.getTimingDiagnostics();
    expect(timing.sampleRateHz).toBeCloseTo(hz, 3);
    expect(timing.lagMin).toBe(Math.max(2, Math.floor(hz * 60 / 220)));
    expect(timing.lagMax).toBeLessThanOrEqual(Math.ceil(hz * 60 / 30));
    expect(timing.detectedLag).toBeGreaterThanOrEqual(timing.lagMin!);
    expect(timing.detectedLag).toBeLessThanOrEqual(timing.lagMax!);
    expect(split).toHaveBeenCalledOnce();
    const channels = split.mock.calls[0][0];
    expect(channels[0]).toHaveLength(channels[1].length);
    expect(channels[1]).toHaveLength(channels[2].length);
  });

  it('includes a 120 BPM fundamental at 10 Hz instead of imposing a 10-sample minimum', () => {
    vi.spyOn(ica, 'fastICA').mockReturnValue(null);
    const calc = new SpO2Calculator();
    feed(calc, 10);
    const timing = calc.getTimingDiagnostics();
    expect(timing.lagMin).toBeLessThanOrEqual(5);
    expect(timing.detectedLag).toBe(5);
  });

  it.each([40, 60, 120])('keeps enough acquisition time for ICA at %i Hz', hz => {
    const split = vi.spyOn(ica, 'fastICA').mockReturnValue(null);
    const calc = new SpO2Calculator();
    feed(calc, hz, Math.ceil(2 * hz) + 2);
    expect(calc.getTimingDiagnostics().sampleRateHz).toBeCloseTo(hz, 3);
    expect(calc.getTimingDiagnostics().samples).toBeGreaterThan(64);
    expect(calc.getTimingDiagnostics().samples).toBeLessThanOrEqual(256);
    expect(split).toHaveBeenCalled();
  });

  it('does not turn repeated delivery of the same frame into new optical evidence', () => {
    const calc = new SpO2Calculator();
    feed(calc, 10, 20);
    const before = calc.getTimingDiagnostics();
    const history = [...calc.getRValueHistory()];
    for (let i = 0; i < 20; i++) expect(calc.calculate(observation(1.9), 20, 11_900)).toBe(0);
    expect(calc.getTimingDiagnostics()).toEqual(before);
    expect(calc.getRValueHistory()).toEqual(history);
  });

  it.each([9000, 14_000])('starts a fresh optical window after clock rewind or acquisition gap at %i ms', nextTime => {
    const calc = new SpO2Calculator();
    feed(calc, 10, 20);
    expect(calc.getRValueHistory().length).toBeGreaterThan(0);
    expect(calc.calculate(observation(2), 21, nextTime)).toBe(0);
    expect(calc.getTimingDiagnostics().samples).toBe(1);
    expect(calc.getTimingDiagnostics().sampleRateHz).toBeNull();
    expect(calc.getRValueHistory()).toEqual([]);
  });

  it('never assumes a sampling frequency for legacy observations without timestamps', () => {
    const split = vi.spyOn(ica, 'fastICA');
    const calc = new SpO2Calculator();
    for (let i = 0; i < 70; i++) calc.calculate(observation(i / 10), i + 1);
    expect(split).not.toHaveBeenCalled();
    expect(calc.getTimingDiagnostics().sampleRateHz).toBeNull();
    expect(calc.getTimingDiagnostics().timestamped).toBe(false);
    expect(calc.getRValueHistory().length).toBeGreaterThan(0);
  });

  it('does not mix timed and untimed optical windows', () => {
    const calc = new SpO2Calculator();
    feed(calc, 10, 20);
    expect(calc.calculate(observation(2), 21)).toBe(0);
    expect(calc.getTimingDiagnostics().samples).toBe(1);
    expect(calc.getRValueHistory()).toEqual([]);
  });

  it.each([NaN, Infinity, 0, -1])('rejects invalid acquisition timestamp %s', timestamp => {
    const calc = new SpO2Calculator();
    feed(calc, 10, 20);
    expect(calc.calculate(observation(2), 21, timestamp)).toBe(0);
    expect(calc.getTimingDiagnostics().samples).toBe(0);
    expect(calc.getRValueHistory()).toEqual([]);
  });
});
