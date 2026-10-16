/**
 * Utilidades matemáticas compartidas.
 * Evita duplicar helpers numéricos en cada módulo del pipeline.
 */

/** Clamp numérico — limita `value` al rango [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamp al rango unitario [0, 1]. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
