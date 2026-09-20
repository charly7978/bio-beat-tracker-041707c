import { describe, it, expect } from 'vitest';
import {
  computeAdaptiveAlpha,
  emaBlend,
  clampAlpha,
  UI_EMA_PARAMS,
  PROCESSOR_EMA_PARAMS,
  PROCESSOR_EMA_BASE,
} from '../adaptiveEma';

/**
 * ORÁCULO: fórmulas originales (previas a la consolidación), copiadas literalmente
 * de las implementaciones que quedaron atrás. Cualquier divergencia entre el
 * núcleo `adaptiveEma` y estas fórmulas rompe el test.
 */

// --- Oráculo capa UI (ex displaySmoothing.ts) ---
function uiAdaptiveAlpha(prev: number, next: number, baseAlpha: number): number {
  const base = Math.min(1, Math.max(0.06, baseAlpha));
  if (prev <= 0 || next <= 0) return Math.min(1, base * 2.2);
  const rel = Math.abs(next - prev) / Math.max(1, Math.abs(prev));
  if (rel > 0.12) return clamp(base * 2.8, base, 0.72);
  if (rel > 0.05) return clamp(base * 1.75, base, 0.5);
  return base;
}

// --- Oráculo capa procesador (ex DisplaySmoothing.ts, smoothValue) ---
function processorAlpha(current: number, newVal: number, type: 'stable' | 'dynamic'): number {
  const baseAlpha = type === 'stable' ? 0.20 : 0.35;
  const relativeChange = Math.abs(newVal - current) / (Math.abs(current) + 0.01);
  let adaptiveAlpha = baseAlpha;
  if (relativeChange > 0.5) adaptiveAlpha = baseAlpha * 2.0;
  else if (relativeChange > 0.3) adaptiveAlpha = baseAlpha * 1.5;
  else if (relativeChange < 0.05) adaptiveAlpha = baseAlpha * 0.5;
  return Math.max(0.05, Math.min(0.5, adaptiveAlpha));
}

// --- Oráculo capa procesador (ex smoothWeightedValue) ---
function processorWeightedAlpha(current: number, newVal: number, weight: number, type: 'stable' | 'dynamic'): number {
  const baseAlpha = type === 'stable' ? 0.20 : 0.35;
  const relativeChange = Math.abs(newVal - current) / (Math.abs(current) + 0.01);
  let adaptiveAlpha = baseAlpha;
  if (relativeChange > 0.5) adaptiveAlpha = baseAlpha * 2.0;
  else if (relativeChange > 0.3) adaptiveAlpha = baseAlpha * 1.5;
  else if (relativeChange < 0.05) adaptiveAlpha = baseAlpha * 0.5;
  const w = Math.max(0, Math.min(1, weight));
  adaptiveAlpha = adaptiveAlpha * (0.15 + 0.85 * w);
  return Math.max(0.015, Math.min(0.5, adaptiveAlpha));
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

const BASE_ALPHAS = [0.06, 0.18, 0.2, 0.35, 0.5, 1];
const PAIRS: Array<[number, number]> = [
  [0, 0], [0, 72], [72, 0], [72, 71], [72, 72], [72, 73],
  [70, 40], [40, 70], [98, 97], [97, 98], [100, 60], [60, 100],
  [120, 80], [80, 121], [120.5, 121.2], [1, 2], [2, 1], [1, 1000],
  [1000, 1], [-5, 5], [5, -5],
];
const WEIGHTS = [0, 0.3, 0.5, 0.85, 1, -0.2, 1.5];

describe('adaptiveEma — equivalencia con las fórmulas originales (oráculo)', () => {
  it('capa UI: computeAdaptiveAlpha replica uiAdaptiveAlpha bit a bit', () => {
    for (const base of BASE_ALPHAS) {
      for (const [prev, next] of PAIRS) {
        const expected = uiAdaptiveAlpha(prev, next, base);
        // La rama prev<=0||next<=0 del oráculo vive en el wrapper UI; aquí solo
        // comparamos la lógica de tiers para entradas positivas.
        if (prev > 0 && next > 0) {
          const rel = Math.abs(next - prev) / Math.max(1, Math.abs(prev));
          const baseClamped = Math.min(1, Math.max(0.06, base));
          expect(computeAdaptiveAlpha(rel, baseClamped, UI_EMA_PARAMS)).toBe(expected);
        }
      }
    }
  });

  it('capa procesador: computeAdaptiveAlpha + clamp replica processorAlpha', () => {
    for (const type of ['stable', 'dynamic'] as const) {
      for (const [current, newVal] of PAIRS) {
        if (current === 0) continue; // guardas del wrapper, no del núcleo
        const expected = processorAlpha(current, newVal, type);
        const rel = Math.abs(newVal - current) / (Math.abs(current) + 0.01);
        const base = type === 'stable' ? PROCESSOR_EMA_BASE.stable : PROCESSOR_EMA_BASE.dynamic;
        const alpha = clampAlpha(computeAdaptiveAlpha(rel, base, PROCESSOR_EMA_PARAMS), 0.05, 0.5);
        expect(alpha).toBe(expected);
      }
    }
  });

  it('capa procesador ponderada: réplica de processorWeightedAlpha', () => {
    for (const type of ['stable', 'dynamic'] as const) {
      for (const [current, newVal] of PAIRS) {
        if (current === 0) continue;
        for (const w of WEIGHTS) {
          const expected = processorWeightedAlpha(current, newVal, w, type);
          const rel = Math.abs(newVal - current) / (Math.abs(current) + 0.01);
          const base = type === 'stable' ? PROCESSOR_EMA_BASE.stable : PROCESSOR_EMA_BASE.dynamic;
          const raw = computeAdaptiveAlpha(rel, base, PROCESSOR_EMA_PARAMS);
          const alpha = clampAlpha(raw * (0.15 + 0.85 * Math.max(0, Math.min(1, w))), 0.015, 0.5);
          expect(alpha).toBe(expected);
        }
      }
    }
  });

  it('emaBlend mezcla exactamente como la fórmula original', () => {
    for (const a of [0.05, 0.1, 0.18, 0.2, 0.35, 0.5, 0.72]) {
      for (const [c, n] of [[72, 71], [40, 70], [0, 5], [100, 0], [7, 7]]) {
        expect(emaBlend(c, n, a)).toBe(c * (1 - a) + n * a);
      }
    }
  });

  it('umbrales límite: comparaciones estrictas (> / <) preservadas', () => {
    // rel exactamente 0.05 → ni tier rápido ni slow (base)
    expect(computeAdaptiveAlpha(0.05, 0.18, UI_EMA_PARAMS)).toBe(0.18);
    // rel justo por encima de 0.05 → tier 2 de UI
    expect(computeAdaptiveAlpha(0.051, 0.18, UI_EMA_PARAMS)).toBeCloseTo(0.18 * 1.75, 12);
    // rel exactamente 0.5 en procesador → tier 1.5x (no 2.0x)
    const rel05 = Math.abs(100 - 150) / (150 + 0.01);
    const base = PROCESSOR_EMA_BASE.stable;
    expect(computeAdaptiveAlpha(rel05, base, PROCESSOR_EMA_PARAMS)).toBe(base * 1.5);
    // rel justo por debajo de 0.05 en procesador → slowTier 0.5x
    const slow = computeAdaptiveAlpha(0.049, base, PROCESSOR_EMA_PARAMS);
    expect(slow).toBe(base * 0.5);
  });

  it('clampAlpha respeta rangos', () => {
    expect(clampAlpha(0.01, 0.05, 0.5)).toBe(0.05);
    expect(clampAlpha(0.9, 0.05, 0.5)).toBe(0.5);
    expect(clampAlpha(0.3, 0.05, 0.5)).toBe(0.3);
  });
});
