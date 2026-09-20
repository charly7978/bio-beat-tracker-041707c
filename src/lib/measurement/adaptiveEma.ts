/**
 * NÚCLEO ÚNICO DE EMA ADAPTATIVO (fuente de verdad anti-duplicación).
 *
 * Consume el cálculo de alpha adaptativo compartido por:
 *  - `src/lib/measurement/displaySmoothing.ts` (capa UI: BPM/SpO2/PA en pantalla)
 *  - `src/modules/vital-signs/DisplaySmoothing.ts` (capa procesador: Suavizado EMA con holds)
 *
 * Reglas de equivalencia (verificadas por `__tests__/adaptiveEma.test.ts` con oráculo):
 *  - `speedTiers` se evalúa en orden descendente; GANA el primer tier cuyo umbral
 *    sea estrictamente menor que el cambio relativo (comparación `>`).
 *  - Si ningún tier de aceleración aplica y existe `slowTier`, se frena cuando el
 *    cambio relativo es estrictamente menor que su umbral (comparación `<`).
 *  - Si no aplica nada, alpha = baseAlpha.
 *  - El clamping final es responsabilidad del llamador (cada capa tiene clamps
 *    propios y distintos); aquí solo se expone `clampAlpha`.
 *
 * NOTA: el denominador del cambio relativo es intencionalmente distinto por capa
 * (UI usa `max(1, |prev|)`, el procesador usa `|current| + 0.01`): cada wrapper
 * calcula su `relativeChange` y lo pasa ya normalizado.
 */

export interface EmaTier {
  /** Umbral de cambio relativo que activa el multiplicador (comparación estricta). */
  readonly relativeChange: number;
  /** Multiplicador sobre baseAlpha cuando el cambio supera (o frena por debajo de) el umbral. */
  readonly multiplier: number;
  /** Techo opcional del alpha para este tier (usado por la capa UI). */
  readonly alphaMax?: number;
}

export interface AdaptiveEmaParams {
  /** Tiers de aceleración, ordenados de umbral mayor a menor. */
  readonly speedTiers: readonly EmaTier[];
  /** Tier opcional de frenado para cambios muy pequeños. */
  readonly slowTier?: EmaTier;
}

/** Parámetros de la capa UI (ex `smoothDisplayValue` en displaySmoothing.ts). */
export const UI_EMA_PARAMS: AdaptiveEmaParams = {
  speedTiers: [
    { relativeChange: 0.12, multiplier: 2.8, alphaMax: 0.72 },
    { relativeChange: 0.05, multiplier: 1.75, alphaMax: 0.5 },
  ],
} as const;

/** Base alphas del procesador de signos vitales (ex DisplaySmoothing.ts). */
export const PROCESSOR_EMA_BASE = {
  stable: 0.2,
  dynamic: 0.35,
} as const;

/** Parámetros de la capa procesador (ex `smoothValue` en DisplaySmoothing.ts). */
export const PROCESSOR_EMA_PARAMS: AdaptiveEmaParams = {
  speedTiers: [
    { relativeChange: 0.5, multiplier: 2.0 },
    { relativeChange: 0.3, multiplier: 1.5 },
  ],
  slowTier: { relativeChange: 0.05, multiplier: 0.5 },
} as const;

/** Clampa un alpha a [min, max]. */
export function clampAlpha(alpha: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, alpha));
}

/**
 * Calcula el alpha adaptativo a partir de un cambio relativo ya normalizado.
 * `baseAlpha` debe venir previamente clamped por el llamador si su capa lo exige.
 */
export function computeAdaptiveAlpha(
  relativeChange: number,
  baseAlpha: number,
  params: AdaptiveEmaParams,
): number {
  for (const tier of params.speedTiers) {
    if (relativeChange > tier.relativeChange) {
      let alpha = baseAlpha * tier.multiplier;
      if (tier.alphaMax !== undefined) {
        // Semántica UI: clamp(candidate, baseAlpha, tier.alphaMax)
        // = max(baseAlpha, min(alphaMax, candidate)).
        alpha = Math.max(baseAlpha, Math.min(tier.alphaMax, alpha));
      }
      return alpha;
    }
  }
  if (params.slowTier && relativeChange < params.slowTier.relativeChange) {
    return baseAlpha * params.slowTier.multiplier;
  }
  return baseAlpha;
}

/** Mezcla EMA pura: `current*(1-alpha) + next*alpha`. */
export function emaBlend(current: number, next: number, alpha: number): number {
  return current * (1 - alpha) + next * alpha;
}
