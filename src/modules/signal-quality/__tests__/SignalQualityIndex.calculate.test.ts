import { describe, it, expect } from 'vitest';
import { SignalQualityIndex } from '../SignalQualityIndex';
import type { SignalQualityMetrics } from '../../../types/measurements';

function mobilePpg(partial: Partial<SignalQualityMetrics>): SignalQualityMetrics {
  return {
    sqi: 0,
    perfusionIndex: 0.002,
    snr: 0.75,
    periodicity: 0.26,
    motionScore: 0.18,
    saturationRatio: 0,
    underexposureRatio: 0.05,
    frameDropRatio: 0.04,
    fpsEffective: 28,
    timestampJitterMs: 30,
    ...partial,
  };
}

describe('SignalQualityIndex.calculate (móvil PPG)', () => {
  it('señal típica con dedo alcanza SQI usable (>28), no se anula por motion leve', () => {
    const sqi = SignalQualityIndex.calculate(mobilePpg({}));
    expect(sqi).toBeGreaterThanOrEqual(28);
    expect(sqi).toBeLessThanOrEqual(100);
  });

  it('PI muy bajo devuelve 0', () => {
    expect(SignalQualityIndex.calculate(mobilePpg({ perfusionIndex: 0.00005 }))).toBe(0);
  });

  it('smoothDisplayedSqi sube con EMA sin comprimir por UNSTABLE', () => {
    let ema = 0;
    for (let i = 0; i < 12; i++) {
      ema = SignalQualityIndex.smoothDisplayedSqi(ema, 42, 'UNSTABLE_CONTACT');
    }
    expect(ema).toBeGreaterThanOrEqual(20);
  });

  it('smoothDisplayedSqi es 0 en NO_CONTACT (sin arrastre)', () => {
    expect(SignalQualityIndex.smoothDisplayedSqi(55, 40, 'NO_CONTACT')).toBe(0);
  });
});


// --- ORÁCULO: fórmulas originales (pre-refactor), copiadas literalmente ---
// Cada valor hardcodeado en SignalQualityIndex.calculate() se reimplementa
// aquí; el test falla si el refactor cambió el comportamiento numérico.
function oraclePiScore(PI: number) {
  return clamp((PI - 0.00012) / 0.002, 0, 1) * 26;
}
function oracleSnrScore(SNR: number) {
  return clamp((SNR - 0.12) / 1.35, 0, 1) * 20;
}
function oraclePeriodicityScore(P: number) {
  return clamp((P - 0.1) / 0.38, 0, 1) * 18;
}
function oracleRpScore(RP: number) {
  return clamp((RP - 0.15) / 0.55, 0, 1) * 10;
}
function oracleMotionPenalty(M: number) {
  return clamp((M - 0.22) / 0.55, 0, 1) * 12;
}
function oracleJitterPenalty(J: number) {
  return clamp((J - 38) / 48, 0, 1) * 8;
}
function oracleDropPenalty(D: number) {
  return Math.min(12, D * 36);
}
function oracleLowFpsPenalty(FPS: number) {
  return FPS < 22 ? (22 - FPS) * 3 : 0;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function oracleCalculate(m: {
  perfusionIndex: number;
  snr: number;
  periodicity: number;
  motionScore: number;
  saturationRatio: number;
  underexposureRatio: number;
  frameDropRatio: number;
  fpsEffective: number;
  timestampJitterMs: number;
  skewness?: number;
  relativePower?: number;
  detectorAgreement?: number;
}): number {
  if (m.perfusionIndex < 0.00008) return 0;
  if (m.saturationRatio > 0.8) return 5;
  const under = m.underexposureRatio ?? 0;
  if (under > 0.82) return 4;
  let score = 0;
  score += oraclePiScore(m.perfusionIndex);
  score += oracleSnrScore(m.snr ?? 0);
  score += oraclePeriodicityScore(m.periodicity ?? 0);
  if (m.relativePower !== undefined && m.relativePower > 0) {
    score += oracleRpScore(m.relativePower);
  }
  const motion = m.motionScore ?? 0;
  score -= oracleMotionPenalty(motion);
  score -= oracleJitterPenalty(m.timestampJitterMs);
  score -= oracleDropPenalty(m.frameDropRatio ?? 0);
  score -= oracleLowFpsPenalty(m.fpsEffective);
  const agree = m.detectorAgreement ?? 0;
  score += agree > 0 ? clamp(agree, 0, 1) * 8 : 0;
  const snrVal = m.snr ?? 0;
  const pVal = m.periodicity ?? 0;
  const bonus = (m.perfusionIndex > 0.0018 && snrVal > 0.55 ? 8 : 0) +
                (pVal > 0.22 && m.perfusionIndex > 0.0005 ? 6 : 0);
  score += bonus;
  return Math.round(clamp(score, 0, 100));
}

describe('SignalQualityIndex.calculate — oráculo numérico', () => {
  const CASES = [
    { name: "señal típica con dedo", base: { perfusionIndex: 0.002, snr: 0.75, periodicity: 0.26, motionScore: 0.18, saturationRatio: 0, underexposureRatio: 0.05, frameDropRatio: 0.04, fpsEffective: 28, timestampJitterMs: 30 } },
    { name: "PI muy bajo → 0", base: { perfusionIndex: 0.00005, snr: 0.75, periodicity: 0.26, motionScore: 0.18, saturationRatio: 0, underexposureRatio: 0.05, frameDropRatio: 0.04, fpsEffective: 28, timestampJitterMs: 30 } },
    { name: "señal limpia", base: { perfusionIndex: 0.01, snr: 3.5, periodicity: 0.9, motionScore: 0.02, saturationRatio: 0, underexposureRatio: 0, frameDropRatio: 0, fpsEffective: 30, timestampJitterMs: 2, relativePower: 0.7, detectorAgreement: 0.95 } },
    { name: "señal ruidosa", base: { perfusionIndex: 0.0003, snr: 0.3, periodicity: 0.05, motionScore: 0.7, saturationRatio: 0.1, underexposureRatio: 0.3, frameDropRatio: 0.2, fpsEffective: 18, timestampJitterMs: 60 } },
    { name: "sin contacto", base: { perfusionIndex: 0, snr: 0, periodicity: 0, motionScore: 0, saturationRatio: 0, underexposureRatio: 0, frameDropRatio: 0, fpsEffective: 30, timestampJitterMs: 0 } },
    { name: "saturación → 5", base: { perfusionIndex: 0.01, snr: 3.5, periodicity: 0.9, motionScore: 0.02, saturationRatio: 0.95, underexposureRatio: 0, frameDropRatio: 0, fpsEffective: 30, timestampJitterMs: 2 } },
    { name: "subexposición → 4", base: { perfusionIndex: 0.01, snr: 3.5, periodicity: 0.9, motionScore: 0.02, saturationRatio: 0, underexposureRatio: 0.9, frameDropRatio: 0, fpsEffective: 30, timestampJitterMs: 2 } },
  ];

  it('coincide con las fórmulas originales en todos los casos', () => {
    for (const c of CASES) {
      const expected = oracleCalculate(c.base as any);
      const actual = SignalQualityIndex.calculate(c.base as any);
      expect(actual).toBe(expected);
    }
  });

  it('cada métrica contribuye exactamente como la fórmula original', () => {
    // PI score solo
    expect(SignalQualityIndex.calculate({
      ...mobilePpg({}),
      snr: 0, periodicity: 0, motionScore: 0,
      saturationRatio: 0, underexposureRatio: 0.05, frameDropRatio: 0,
      fpsEffective: 30, timestampJitterMs: 0,
    })).toBe(Math.round(clamp((0.002 - 0.00012) / 0.002, 0, 1) * 26));
  });
});
