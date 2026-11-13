/** Presentación temporal: nunca remuestrea ni modifica las observaciones. */
export const MONITOR_VIEW = { minWindowMs: 1000, maxWindowMs: 8000, defaultWindowMs: 4000 } as const;

export function clampWindowMs(ms: number): number {
  return Math.round(Math.min(MONITOR_VIEW.maxWindowMs, Math.max(MONITOR_VIEW.minWindowMs,
    Number.isFinite(ms) ? ms : MONITOR_VIEW.defaultWindowMs)) / 25) * 25;
}

export function clampInspectionEnd(end: number, first: number, last: number, windowMs: number): number {
  return Math.min(last, Math.max(Math.min(last, first + windowMs), end));
}
