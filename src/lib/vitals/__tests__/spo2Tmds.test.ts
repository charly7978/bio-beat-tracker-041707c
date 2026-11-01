import { describe, it, expect } from 'vitest';
import { computeTmdsDifferential, tmdsToRatios, TMDS_DEFAULT_K } from '../spo2Tmds';

describe('spo2Tmds — modulación de torch (F4)', () => {
  it('diferencial hi-lo con k por defecto', () => {
    const hi = { level: 'hi' as const, intensity: 1.0, dc: { red: 100, green: 80, blue: 60 } };
    const lo = { level: 'lo' as const, intensity: 0.6, dc: { red: 50, green: 40, blue: 30 } };
    const d = computeTmdsDifferential(hi, lo);
    expect(d.valid).toBe(true);
    expect(d.k).toBeCloseTo(TMDS_DEFAULT_K, 9);
    // Δ = hi - k*lo ; k=1/0.6≈1.6667 → lo*k = 100,48,60 → Δ=0,32,0
    expect(d.deltaDc.red).toBeCloseTo(16.6667, 4);
    expect(d.deltaDc.green).toBeCloseTo(13.3333333, 6);
    expect(d.deltaDc.blue).toBeCloseTo(10, 4);
  });

  it('k personalizado se respeta', () => {
    const hi = { level: 'hi' as const, intensity: 1.0, dc: { red: 100, green: 80, blue: 60 } };
    const lo = { level: 'lo' as const, intensity: 0.5, dc: { red: 50, green: 40, blue: 30 } };
    const d = computeTmdsDifferential(hi, lo, 2.0);
    expect(d.valid).toBe(true);
    expect(d.deltaDc.red).toBeCloseTo(0, 9);
  });

  it('intensidad lo <=0 o k inválido → inválido', () => {
    const hi = { level: 'hi' as const, intensity: 1.0, dc: { red: 100, green: 80, blue: 60 } };
    const lo = { level: 'lo' as const, intensity: 0, dc: { red: 50, green: 40, blue: 30 } };
    expect(computeTmdsDifferential(hi, lo).valid).toBe(false);
    expect(computeTmdsDifferential(hi, lo, 0).valid).toBe(false);
    expect(computeTmdsDifferential(hi, lo, -1).valid).toBe(false);
  });

  it('DC negativo o no finito → inválido', () => {
    const hi = { level: 'hi' as const, intensity: 1.0, dc: { red: NaN, green: 80, blue: 60 } };
    const lo = { level: 'lo' as const, intensity: 0.6, dc: { red: 50, green: 40, blue: 30 } };
    expect(computeTmdsDifferential(hi, lo).valid).toBe(false);
    const hi2 = { level: 'hi' as const, intensity: 1.0, dc: { red: 100, green: 80, blue: 60 } };
    const lo2 = { level: 'lo' as const, intensity: 0.6, dc: { red: -1, green: 40, blue: 30 } };
    expect(computeTmdsDifferential(hi2, lo2).valid).toBe(false);
  });

  it('tmdsToRatios convierte diferencial a AC/DC por canal', () => {
    const diff = { deltaDc: { red: 10, green: 20, blue: 5 }, k: 1.5, valid: true };
    const r = tmdsToRatios(diff, { red: 2, green: 4, blue: 1 });
    expect(r).not.toBeNull();
    expect(r!.red).toBeCloseTo(0.2, 9);
    expect(r!.green).toBeCloseTo(0.2, 9);
    expect(r!.blue).toBeCloseTo(0.2, 9);
  });

  it('tmdsToRatios con diferencial inválido o DC≈0 → null', () => {
    const diff = { deltaDc: { red: 0, green: 20, blue: 5 }, k: 1.5, valid: true };
    expect(tmdsToRatios(diff, { red: 2, green: 4, blue: 1 })).toBeNull();
    const inv = { deltaDc: { red: 10, green: 20, blue: 5 }, k: 1.5, valid: false };
    expect(tmdsToRatios(inv, { red: 2, green: 4, blue: 1 })).toBeNull();
  });
});