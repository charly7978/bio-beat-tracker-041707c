import { describe, it, expect } from 'vitest';
import { computeTripleRatioFeatures } from '../spo2TripleRatio';

describe('spo2TripleRatio — ratio triple R/G/B (F4)', () => {
  it('calcula ratios y cruzados válidos', () => {
    const f = computeTripleRatioFeatures({ redAC: 2, redDC: 100, greenAC: 1, greenDC: 50, blueAC: 0.5, blueDC: 25 });
    expect(f.valid).toBe(true);
    expect(f.ratioRed).toBeCloseTo(0.02, 9);
    expect(f.ratioGreen).toBeCloseTo(0.02, 9);
    expect(f.ratioBlue).toBeCloseTo(0.02, 9);
    expect(f.rg).toBeCloseTo(1, 9);
    expect(f.rb).toBeCloseTo(1, 9);
    expect(f.bg).toBeCloseTo(1, 9);
  });

  it('DC <=0 → inválido', () => {
    const f = computeTripleRatioFeatures({ redAC: 2, redDC: 0, greenAC: 1, greenDC: 50, blueAC: 0.5, blueDC: 25 });
    expect(f.valid).toBe(false);
  });

  it('no finito → inválido', () => {
    const f = computeTripleRatioFeatures({ redAC: NaN, redDC: 100, greenAC: 1, greenDC: 50, blueAC: 0.5, blueDC: 25 });
    expect(f.valid).toBe(false);
  });

  it('ratioGreen o ratioBlue <=0 → cruzados inválidos aunque AC/DC finitos', () => {
    // blueAC=0 ⇒ ratioBlue=0 ⇒ bg=0/... invalid cross
    const f = computeTripleRatioFeatures({ redAC: 2, redDC: 100, greenAC: 1, greenDC: 50, blueAC: 0, blueDC: 25 });
    expect(f.valid).toBe(false);
    expect(f.ratioBlue).toBe(0);
  });
});