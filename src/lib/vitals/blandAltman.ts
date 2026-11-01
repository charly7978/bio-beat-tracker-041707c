import { robustPercentile } from '@/modules/signal-processing/shared/dsp';
/**
 * Bland–Altman genérico (F6) — acuerdo entre dos métodos (estimado vs referencia).
 * Reutilizable para BP, SpO2, HR. d = método_nuevo − referencia.
 */
export interface BlandAltmanChannel {
  n: number;
  direction: 'NEW_MINUS_REFERENCE';
  bias: number;
  sd: number;
  loaLow: number;
  loaHigh: number;
  p5: number;
  p95: number;
}

export interface BlandAltmanResult {
  bias: number;
  sd: number;
  loaLow: number;
  loaHigh: number;
  p5: number;
  p95: number;
  n: number;
}

export function blandAltman(pairs: { estimate: number; reference: number }[]): BlandAltmanResult | null {
  const diffs = pairs
    .filter((p) => Number.isFinite(p.estimate) && Number.isFinite(p.reference))
    .map((p) => p.estimate - p.reference);
  if (diffs.length === 0) return null;
  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const sorted = [...diffs].sort((a, b) => a - b);
  return {
    bias: mean,
    sd,
    loaLow: mean - 1.96 * sd,
    loaHigh: mean + 1.96 * sd,
    p5: robustPercentile(sorted, 0.05),
    p95: robustPercentile(sorted, 0.95),
    n,
  };
}