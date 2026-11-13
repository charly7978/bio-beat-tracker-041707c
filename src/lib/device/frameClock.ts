/**
 * Reloj de captura por hardware para las muestras PPG.
 *
 * `requestVideoFrameCallback` entrega varias marcas de tiempo del frame:
 *  - `captureTime`: instante en que la cámara capturó el frame (reloj del
 *    hardware, misma base que `performance.now()`). Es la marca que interesa a
 *    la PPG porque describe CUÁNDO se integró la luz del pulso.
 *  - `presentationTime`: instante en que el frame se envió a composición; llega
 *    después de la captura y añade la latencia del pipeline.
 *  - `mediaTime`: PTS del stream en segundos; identifica frames pero puede ser 0
 *    en streams en vivo, así que no sirve como reloj de muestra.
 *  - `now`: despacho del callback en el event loop; arrastra el jitter de JS.
 *
 * La especificación WICG define `captureTime` para fuentes locales y sus
 * marcas usan la misma referencia que `performance.now()`, por lo que se puede
 * comparar directamente con `presentationTime`/`now`. Si un UA la reportara en
 * otra época, la diferencia sería de segundos u horas: se descarta con una
 * guarda de cordura y se cae a `presentationTime`.
 */

export type FrameClockSource = 'capture' | 'presentation' | 'callback' | 'perf';

export interface FrameClockMetadata {
  captureTime?: number;
  presentationTime?: number;
  mediaTime?: number;
}

export interface FrameTimestamp {
  timestamp: number;
  source: FrameClockSource;
}

/** Latencia máxima plausible captura → composición (misma base de reloj). */
export const MAX_CAPTURE_TO_PRESENTATION_MS = 250;
/** Latencia máxima plausible captura → callback cuando no hay presentationTime. */
export const MAX_CAPTURE_TO_CALLBACK_MS = 1000;

function isClockValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Resuelve la marca temporal de la muestra con prioridad al reloj de captura.
 * Puro y determinista: sin acceso a `performance` salvo el valor de respaldo.
 */
export function resolveFrameClock(
  metadata: FrameClockMetadata | undefined,
  callbackTime?: number,
  perfNow?: number,
): FrameTimestamp {
  const cb = isClockValue(callbackTime) ? callbackTime : undefined;
  const perf = isClockValue(perfNow)
    ? perfNow
    : typeof performance !== 'undefined' && Number.isFinite(performance.now())
      ? performance.now()
      : 0;

  const capture = metadata?.captureTime;
  const presentation = metadata?.presentationTime;

  if (isClockValue(capture)) {
    const reference = isClockValue(presentation) ? presentation : cb ?? perf;
    const maxSkew = isClockValue(presentation)
      ? MAX_CAPTURE_TO_PRESENTATION_MS
      : MAX_CAPTURE_TO_CALLBACK_MS;
    if (reference > 0 && Math.abs(reference - capture) <= maxSkew) {
      return { timestamp: capture, source: 'capture' };
    }
  }

  if (isClockValue(presentation)) {
    return { timestamp: presentation, source: 'presentation' };
  }
  if (cb !== undefined) {
    return { timestamp: cb, source: 'callback' };
  }
  return { timestamp: perf, source: 'perf' };
}
