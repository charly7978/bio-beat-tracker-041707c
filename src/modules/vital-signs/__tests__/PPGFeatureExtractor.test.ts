import { describe, it, expect } from 'vitest';
import { PPGFeatureExtractor } from '../PPGFeatureExtractor';

describe('PPGFeatureExtractor (pyPPG 2024 & PWA Biomarkers)', () => {
  // Generate a realistic synthetic PPG signal cycle (~1 Hz, 30 fps, 90 samples = 3 s)
  function generateTestPpgSignal(length = 90, sampleRate = 30): number[] {
    const signal: number[] = [];
    const periodSamples = sampleRate; // 1 beat per second
    for (let i = 0; i < length; i++) {
      const phase = (i % periodSamples) / periodSamples;
      // Asymmetric pulse wave with systolic peak (~0.2 phase) and dicrotic notch (~0.45 phase)
      let val = 0;
      if (phase < 0.2) {
        val = Math.sin((phase / 0.2) * (Math.PI / 2));
      } else if (phase < 0.45) {
        val = 0.5 + 0.5 * Math.cos(((phase - 0.2) / 0.25) * Math.PI);
      } else if (phase < 0.6) {
        // Dicrotic notch + diastolic peak
        val = 0.35 + 0.15 * Math.sin(((phase - 0.45) / 0.15) * Math.PI);
      } else {
        // Diastolic runoff
        val = 0.35 * Math.cos(((phase - 0.6) / 0.4) * (Math.PI / 2));
      }
      signal.push(Math.max(0, val));
    }
    return signal;
  }

  it('detects cardiac cycles from valid signal buffer', () => {
    const signal = generateTestPpgSignal(120, 30);
    const cycles = PPGFeatureExtractor.detectCardiacCycles(signal, 30);
    expect(cycles.length).toBeGreaterThanOrEqual(1);

    const first = cycles[0];
    expect(first.onset).toBeGreaterThanOrEqual(0);
    expect(first.systolicPeak).toBeGreaterThan(first.onset);
    expect(first.nextOnset).toBeGreaterThan(first.systolicPeak);
  });

  it('extracts pyPPG biomarkers including VPG, reflection index and elastic modulus', () => {
    const signal = generateTestPpgSignal(120, 30);
    const cycles = PPGFeatureExtractor.detectCardiacCycles(signal, 30);
    expect(cycles.length).toBeGreaterThanOrEqual(1);

    const features = PPGFeatureExtractor.extractCycleFeatures(signal, cycles[0], 30);
    expect(features).not.toBeNull();
    if (features) {
      // Basic morphological features
      expect(features.sutMs).toBeGreaterThan(0);
      expect(features.systolicAmplitude).toBeGreaterThan(0);
      expect(features.diastolicTimeMs).toBeGreaterThan(0);
      expect(features.pw50Ms).toBeGreaterThan(0);

      // pyPPG 2024 standardized biomarkers
      expect(features.totalArea).toBeGreaterThan(0);
      expect(features.totalArea).toBe(features.systolicArea + features.diastolicArea);
      expect(features.reflectionIndex).toBeGreaterThanOrEqual(0);
      expect(features.reflectionIndex).toBeLessThanOrEqual(100);
      expect(features.elasticModulusProxy).toBeGreaterThan(0);
      expect(Number.isFinite(features.vascularAgingProxy)).toBe(true);

      // VPG derivatives
      expect(features.vpg).toBeDefined();
      if (features.vpg) {
        expect(features.vpg.w).toBeGreaterThan(0); // Peak systolic velocity
      }

      // APG second derivative
      expect(features.apg).toBeDefined();
      expect(Number.isFinite(features.apg.agi)).toBe(true);
    }
  });

  it('handles invalid or flat signals gracefully', () => {
    const flat = new Array(60).fill(10);
    const cycles = PPGFeatureExtractor.detectCardiacCycles(flat, 30);
    expect(cycles).toEqual([]);

    const short = [1, 2, 3];
    const shortCycles = PPGFeatureExtractor.detectCardiacCycles(short, 30);
    expect(shortCycles).toEqual([]);
  });
});
