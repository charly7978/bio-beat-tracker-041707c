import { describe, it, expect } from 'vitest';
import {
  computeRrHrv,
  calculateHRV,
  computePoincare,
  computeBaevskyStressIndex,
  isPhysiologicalRR,
  getMonotonicNow,
} from '../physio';

describe('physio utilities (Poincaré & Baevsky Stress Index)', () => {
  it('identifies physiological RR intervals', () => {
    expect(isPhysiologicalRR(800)).toBe(true);
    expect(isPhysiologicalRR(250)).toBe(false);
    expect(isPhysiologicalRR(2500)).toBe(false);
  });

  it('computes monotonic timestamps reliably', () => {
    const t1 = getMonotonicNow();
    const t2 = getMonotonicNow();
    expect(t2).toBeGreaterThanOrEqual(t1);
  });

  it('computes standard HRV metrics', () => {
    const rr = [800, 810, 790, 820, 800];
    const hrv = computeRrHrv(rr);
    expect(hrv.meanRR).toBe(804);
    expect(hrv.rmssd).toBeGreaterThan(0);
    expect(hrv.sdnn).toBeGreaterThan(0);
    expect(hrv.cv).toBeGreaterThan(0);

    const simpleHrv = calculateHRV(rr);
    expect(simpleHrv.rmssd).toBe(hrv.rmssd);
  });

  describe('Poincaré Geometry (SD1, SD2, Autonomic Balance)', () => {
    it('returns zeroes for insufficient intervals', () => {
      const p = computePoincare([800, 810]);
      expect(p.sd1).toBe(0);
      expect(p.sd2).toBe(0);
      expect(p.sd1Sd2Ratio).toBe(0);
      expect(p.ellipseArea).toBe(0);
    });

    it('computes valid SD1, SD2, ratio and ellipse area for normal rhythm', () => {
      const rr = [750, 770, 790, 810, 830, 840, 820, 800, 780, 760];
      const p = computePoincare(rr);

      expect(p.sd1).toBeGreaterThan(0);
      expect(p.sd2).toBeGreaterThan(0);
      expect(p.sd2).toBeGreaterThanOrEqual(p.sd1);
      expect(p.sd1Sd2Ratio).toBeGreaterThan(0);
      expect(p.ellipseArea).toBeGreaterThan(0);
    });
  });

  describe('Baevsky Stress Index (SI)', () => {
    it('returns normal defaults for insufficient intervals', () => {
      const b = computeBaevskyStressIndex([800, 810]);
      expect(b.stressIndex).toBe(0);
      expect(b.stressLevel).toBe('NORMAL');
    });

    it('computes stress index and classifies relaxed/normal state', () => {
      // Natural sinus rhythm with respiratory sinus arrhythmia variation
      const rr = [700, 750, 800, 850, 900, 880, 820, 760, 720, 780];
      const b = computeBaevskyStressIndex(rr);

      expect(b.stressIndex).toBeGreaterThan(0);
      expect(b.modeSec).toBeGreaterThan(0.5);
      expect(b.modeAmplitudePct).toBeGreaterThan(0);
      expect(b.variationRangeSec).toBeGreaterThan(0.04);
      expect(['RELAXED', 'NORMAL', 'ELEVATED']).toContain(b.stressLevel);
    });

    it('classifies rigid / low-variability rhythm as elevated/high stress', () => {
      // Highly rigid RR intervals (stress / sympathicotonia)
      const rr = [800, 802, 801, 799, 801, 800, 802, 798, 800, 801];
      const b = computeBaevskyStressIndex(rr);

      expect(b.stressIndex).toBeGreaterThan(150);
      expect(['ELEVATED', 'HIGH_STRESS']).toContain(b.stressLevel);
    });
  });
});
