import { CAPTURE_TIMING_DEFAULTS } from '@/config/signalProcessing';

export interface PulseMorphologyInput {
  /** Reloj de adquisición convertido a milisegundos de la vista. */
  time: number;
  value: number;
  /** Canal PPG lineal filtrado, previo al AGC y a la ganancia visual. */
  sourceValue?: number;
}

export interface PulseMorphologySample {
  time: number;
  velocity: number;
  acceleration: number;
}

export type PulseMorphologySegment = PulseMorphologySample[];

/**
 * Diferencias divididas de tres observaciones con tiempos no uniformes.
 * Las dos derivadas se sitúan en el tiempo de la muestra central: no se
 * reconstruyen componentes eléctricos ni se modifica el estimador de pulso.
 * El canal productivo es sourceValue (PPG filtrada sin AGC). El respaldo value
 * sólo permite abrir registros antiguos que no tenían ese campo. Un NaN
 * explícito en sourceValue corta el segmento y nunca cae al canal de display.
 */
export function derivePulseMorphology(points: readonly PulseMorphologyInput[]): PulseMorphologySegment[] {
  const segments: PulseMorphologySegment[] = [];
  let left: { time: number; value: number } | undefined;
  let center: { time: number; value: number } | undefined;
  let active: PulseMorphologySegment | undefined;

  for (const point of points) {
    const value = point.sourceValue === undefined ? point.value : point.sourceValue;
    if (!Number.isFinite(point.time) || !Number.isFinite(value)) {
      left = undefined;
      center = undefined;
      active = undefined;
      continue;
    }

    const right = { time: point.time, value };
    if (center) {
      const intervalMs = right.time - center.time;
      if (intervalMs <= 0 || intervalMs > CAPTURE_TIMING_DEFAULTS.maxFrameGapMs) {
        left = undefined;
        center = right;
        active = undefined;
        continue;
      }
    }

    if (left && center) {
      const beforeSeconds = (center.time - left.time) / 1000;
      const afterSeconds = (right.time - center.time) / 1000;
      const beforeSlope = (center.value - left.value) / beforeSeconds;
      const afterSlope = (right.value - center.value) / afterSeconds;
      const spanSeconds = beforeSeconds + afterSeconds;
      const velocity = (afterSeconds * beforeSlope + beforeSeconds * afterSlope) / spanSeconds;
      // La resta de pendientes casi iguales puede magnificar el redondeo
      // IEEE-754 al autoescalar. Sólo anulamos diferencias por debajo del
      // error aritmético de esas restas; no es un umbral fisiológico.
      const subtractionError = Number.EPSILON * 8 * Math.max(Math.abs(left.value), Math.abs(center.value), Math.abs(right.value))
        * (1 / beforeSeconds + 1 / afterSeconds);
      const slopeDifference = afterSlope - beforeSlope;
      const acceleration = Math.abs(slopeDifference) <= subtractionError ? 0 : 2 * slopeDifference / spanSeconds;

      if (Number.isFinite(velocity) && Number.isFinite(acceleration)) {
        if (!active) {
          active = [];
          segments.push(active);
        }
        active.push({ time: center.time, velocity, acceleration });
      } else {
        active = undefined;
      }
    }

    left = center;
    center = right;
  }

  return segments;
}
