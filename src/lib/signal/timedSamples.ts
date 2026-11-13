/**
 * Uniformiza una señal escalar muestreada con timestamps de captura.
 *
 * Se usa para características morfológicas PPG: el estimador debe recibir
 * muestras uniformes y su frecuencia REAL, nunca una frecuencia nominal
 * asumida por el router. Las brechas grandes/jitter excesivo invalidan la
 * ventana en vez de deformar silenciosamente las escalas temporales.
 */
export interface TimedSignalSample {
  value: number;
  timestampMs: number;
}

export interface ResampledTimedSignal {
  samples: number[];
  sampleRateHz: number;
  medianIntervalMs: number;
  jitterRatio: number;
  maxGapRatio: number;
}

export interface ResampleTimedSignalOptions {
  targetRateHz?: number;
  minRateHz?: number;
  maxRateHz?: number;
  maxGapMultiple?: number;
  maxJitterRatio?: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Devuelve una serie uniformemente muestreada mediante interpolación lineal.
 * No extrapola, no ordena timestamps fuera de secuencia y no rellena huecos
 * grandes. La frecuencia de salida nunca supera la frecuencia observada.
 */
export function resampleTimedSignal(
  input: readonly TimedSignalSample[],
  options: ResampleTimedSignalOptions = {},
): ResampledTimedSignal | null {
  const targetRateHz = options.targetRateHz ?? 30;
  const minRateHz = options.minRateHz ?? 20;
  const maxRateHz = options.maxRateHz ?? 60;
  const maxGapMultiple = options.maxGapMultiple ?? 2.25;
  const maxJitterRatio = options.maxJitterRatio ?? 0.35;

  if (
    !Number.isFinite(targetRateHz) ||
    !Number.isFinite(minRateHz) ||
    !Number.isFinite(maxRateHz) ||
    targetRateHz <= 0 ||
    minRateHz <= 0 ||
    maxRateHz < minRateHz ||
    input.length < 3
  ) {
    return null;
  }

  const samples: TimedSignalSample[] = [];
  for (const sample of input) {
    if (
      !Number.isFinite(sample.value) ||
      !Number.isFinite(sample.timestampMs) ||
      sample.timestampMs <= 0
    ) {
      return null;
    }

    const previous = samples[samples.length - 1];
    if (previous && sample.timestampMs < previous.timestampMs) return null;

    // Elimina timestamps duplicados sin inventar una separación temporal.
    if (previous && sample.timestampMs === previous.timestampMs) {
      previous.value = sample.value;
      continue;
    }
    samples.push({ value: sample.value, timestampMs: sample.timestampMs });
  }

  if (samples.length < 3) return null;

  const intervals: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const delta = samples[i].timestampMs - samples[i - 1].timestampMs;
    if (!(delta > 0)) return null;
    intervals.push(delta);
  }

  const medianIntervalMs = median(intervals);
  if (!(medianIntervalMs > 0)) return null;

  const deviations = intervals.map((delta) => Math.abs(delta - medianIntervalMs));
  const jitterRatio = (1.4826 * median(deviations)) / medianIntervalMs;
  const maxGapRatio = Math.max(...intervals) / medianIntervalMs;

  if (jitterRatio > maxJitterRatio || maxGapRatio > maxGapMultiple) return null;

  const observedRateHz = 1000 / medianIntervalMs;
  if (observedRateHz < minRateHz || observedRateHz > maxRateHz) return null;

  const sampleRateHz = Math.min(targetRateHz, observedRateHz);
  const stepMs = 1000 / sampleRateHz;
  const durationMs = samples[samples.length - 1].timestampMs - samples[0].timestampMs;
  const outputCount = Math.floor(durationMs / stepMs) + 1;

  // PPGFeatureExtractor necesita al menos dos segundos para localizar ciclos.
  if (outputCount < Math.ceil(sampleRateHz * 2)) return null;

  const output: number[] = [];
  let right = 1;
  const startMs = samples[0].timestampMs;

  for (let i = 0; i < outputCount; i++) {
    const timestamp = startMs + i * stepMs;
    while (right < samples.length - 1 && samples[right].timestampMs < timestamp) {
      right++;
    }

    const left = right - 1;
    const a = samples[left];
    const b = samples[right];
    const span = b.timestampMs - a.timestampMs;
    if (!(span > 0)) return null;

    const fraction = (timestamp - a.timestampMs) / span;
    if (fraction < -1e-6 || fraction > 1 + 1e-6) return null;
    output.push(a.value + (b.value - a.value) * Math.min(1, Math.max(0, fraction)));
  }

  return {
    samples: output,
    sampleRateHz,
    medianIntervalMs,
    jitterRatio,
    maxGapRatio,
  };
}
