/**
 * Suavizado adaptativo para displays en vivo (BPM, SpO2, PA).
 * Alphas bajos: responde sin congelar el número en pantalla.
 *
 * La lógica de alpha adaptativo vive en `adaptiveEma.ts` (fuente de verdad
 * compartida con `src/modules/vital-signs/DisplaySmoothing.ts`); aquí solo
 * quedan las guardas de rango y el snap de presentación propios de la UI.
 */
import { computeAdaptiveAlpha, emaBlend, UI_EMA_PARAMS } from './adaptiveEma';

/** Pesos de suavizado por vital (solo UI, no afecta guardado clínico). */
export const DISPLAY_SMOOTH_ALPHAS = {
  hr: 0.18,
  spo2: 0.18,
  bp: 0.18,
} as const;

export function smoothDisplayValue(
  prev: number,
  next: number,
  alpha: number = DISPLAY_SMOOTH_ALPHAS.hr,
): number {
  const base = Math.min(1, Math.max(0.06, alpha));
  if (next <= 0) {
    if (prev <= 0) return 0;
    return prev + (0 - prev) * Math.min(1, base * 2.5);
  }
  if (prev <= 0) return next;

  const rel = Math.abs(next - prev) / Math.max(1, Math.abs(prev));
  const a = computeAdaptiveAlpha(rel, base, UI_EMA_PARAMS);
  let out = emaBlend(prev, next, a);
  if (Math.abs(next - out) < 0.55) out = next;
  return out;
}

export function smoothDisplayPair(
  prev: { systolic: number; diastolic: number },
  next: { systolic: number; diastolic: number },
  alpha: number = DISPLAY_SMOOTH_ALPHAS.bp,
): { systolic: number; diastolic: number } {
  return {
    systolic: Math.round(smoothDisplayValue(prev.systolic, next.systolic, alpha)),
    diastolic: Math.round(smoothDisplayValue(prev.diastolic, next.diastolic, alpha)),
  };
}
