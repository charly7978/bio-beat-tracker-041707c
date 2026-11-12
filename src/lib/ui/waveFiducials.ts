/**
 * Detección fiducial compartida de la onda PPG renderizada (SYS / DIA / DIC).
 * Fuente única para los modos 2D (ppgCanvasRenderer) y 3D (ppg3dProjection):
 * un solo criterio → ambos modos marcan exactamente los mismos puntos.
 */

/** Calidad mínima de señal para anotar la etiqueta DIC. */
export const DIC_QUALITY_MIN = 70;

/** Pico sistólico: máximo local de 5 puntos por encima de la línea media. */
export function isLocalMax(i: number, vals: number[], midValue: number): boolean {
  const v = vals[i];
  return v > vals[i - 1] && v > vals[i + 1]
    && v > vals[i - 2] && v > vals[i + 2]
    && v > midValue;
}

/** Valle diastólico: mínimo local de 5 puntos por debajo de la línea media. */
export function isLocalMin(i: number, vals: number[], midValue: number): boolean {
  const v = vals[i];
  return v < vals[i - 1] && v < vals[i + 1]
    && v < vals[i - 2] && v < vals[i + 2]
    && v < midValue;
}

/** Muesca dícrota: desaceleración de la bajada (pendiente aún negativa) sobre la línea media. */
export function isDicroticNotch(i: number, vals: number[], midValue: number): boolean {
  const dCurr = vals[i] - vals[i - 1];
  const dNext = vals[i + 1] - vals[i];
  return dCurr < 0 && dNext > dCurr && dNext < 0 && vals[i] > midValue;
}
