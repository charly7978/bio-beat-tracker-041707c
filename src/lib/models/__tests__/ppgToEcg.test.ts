import { describe, expect, it } from 'vitest';
import weights from '../ppgToEcg.weights.json';
import { PpgToEcgEstimator, PpgToEcgNetwork, type PpgToEcgModel } from '../ppgToEcg';
import { BesselFilter } from '@/modules/signal-processing/shared/BesselFilter';
import type { EcgEstimate, ProcessedSignal } from '@/types/signal';

function identityModel(): PpgToEcgModel {
  return {
    modelId: 'test-linear', sampleRate: 30, inputLength: 60,
    outputStart: 22, outputLength: 15, filterWarmupSamples: 0,
    layers: [{
      weights: Array.from({ length: 60 }, (_, i) => Array.from({ length: 15 }, (_, j) => i === j + 22 ? 1 : 0)),
      bias: Array(15).fill(0), activation: 'linear',
    }],
  };
}

function observation(timestamp: number, changes: Partial<ProcessedSignal> = {}): ProcessedSignal {
  return {
    timestamp, rawValue: Math.sin(timestamp / 140), filteredValue: 8,
    quality: 90, fingerDetected: true, contactState: 'STABLE_CONTACT',
    roi: { x: 0, y: 0, width: 16, height: 16 },
    diagnostics: {
      message: '', hasPulsatility: true, pulsatilityValue: .1,
      continuity: { epoch: 1, valid: true, reason: '', overlap: 1, agreement: 1 },
    },
    ...changes,
  };
}

function collect(estimator: PpgToEcgEstimator, count: number, start = 0): EcgEstimate[] {
  return Array.from({ length: count }, (_, index) => estimator.ingest(observation(start + index * 1000 / 30)));
}

describe('modelo entrenado PPG→ECG', () => {
  it('reproduce la predicción Python de un segmento real reservado', () => {
    const network = new PpgToEcgNetwork();
    const actual = network.predict(weights.parity.input);
    expect(actual).not.toBeNull();
    actual!.forEach((value, index) => expect(value).toBeCloseTo(weights.parity.expected[index], 10));
  });

  it('reproduce el preprocesamiento causal Python con datos reales', () => {
    const filter = new BesselFilter(30, .5, 12);
    weights.filterParity.input.forEach((value, index) => {
      expect(filter.filter(value)).toBeCloseTo(weights.filterParity.expected[index], 10);
    });
  });

  it('usa desviación poblacional y conserva salida aprendida sin autoescala', () => {
    const network = new PpgToEcgNetwork(identityModel());
    const input = Array.from({ length: 60 }, (_, index) => index);
    const mean = 29.5;
    const std = Math.sqrt(input.reduce((sum, value) => sum + (value - mean) ** 2, 0) / input.length);
    expect(network.predict(input)).toEqual(input.slice(22, 37).map(value => (value - mean) / std));
    const scaled = network.predict(input.map(value => value * 7 + 30))!;
    scaled.forEach((value, index) => expect(value).toBeCloseTo(network.predict(input)![index], 12));
    expect(network.predict(Array(60).fill(3))).toBeNull();
    expect(network.predict([...input.slice(1), NaN])).toBeNull();
  });

  it('rechaza pesos o dimensiones incompatibles', () => {
    const model = identityModel();
    expect(() => new PpgToEcgNetwork({ ...model, inputLength: 30 })).toThrow();
    model.layers[0].weights[0][0] = Infinity;
    expect(() => new PpgToEcgNetwork(model)).toThrow();
  });

  it('sitúa la salida central en tiempos observados y publica cada 15 muestras', () => {
    const estimator = new PpgToEcgEstimator(identityModel());
    const results = collect(estimator, 90);
    const batches = results.filter(result => result.samples.length > 0);
    expect(batches).toHaveLength(3);
    expect(batches.every(result => result.status === 'AVAILABLE' && result.samples.length === 15)).toBe(true);
    expect(batches[0].samples[0].timestamp).toBeCloseTo(22 * 1000 / 30);
    expect(batches[0].samples[14].timestamp).toBeCloseTo(36 * 1000 / 30);
    expect(batches[0].latencyMs).toBeCloseTo(23 * 1000 / 30);
    const times = batches.flatMap(batch => batch.samples.map(point => point.timestamp));
    for (let index = 1; index < times.length; index++) expect(times[index] - times[index - 1]).toBeCloseTo(1000 / 30);
    expect(results[60].status).toBe('AVAILABLE');
    expect(results[60].samples).toEqual([]);
  });

  it('exige el calentamiento del filtro y contexto completo del modelo real', () => {
    const estimator = new PpgToEcgEstimator();
    const results = collect(estimator, weights.filterWarmupSamples + weights.inputLength);
    expect(results.slice(0, -1).every(result => result.status === 'WARMUP' && result.samples.length === 0)).toBe(true);
    expect(results[results.length - 1].status).toBe('AVAILABLE');
    expect(results[results.length - 1].samples).toHaveLength(weights.outputLength);
  });

  it('remuestrea observaciones irregulares con el mismo reloj y acondicionamiento', () => {
    const regular = new PpgToEcgEstimator(identityModel());
    const irregular = new PpgToEcgEstimator(identityModel());
    let expected: EcgEstimate | undefined;
    for (let index = 0; index < 60; index++) {
      const time = index * 1000 / 30;
      const result = regular.ingest(observation(time, { rawValue: time / 1000 }));
      if (result.samples.length) expected = result;
    }
    let actual: EcgEstimate | undefined;
    let time = 0;
    for (let index = 0; index < 90 && !actual; index++) {
      const result = irregular.ingest(observation(time, { rawValue: time / 1000 }));
      if (result.samples.length) actual = result;
      time += [17, 43, 28, 44, 31][index % 5];
    }
    expect(actual?.samples.length).toBe(15);
    actual!.samples.forEach((point, index) => {
      expect(point.timestamp).toBeCloseTo(expected!.samples[index].timestamp, 8);
      expect(point.value).toBeCloseTo(expected!.samples[index].value, 9);
    });
  });

  it('respeta fotometría y continuidad sin modificar la señal ni sus diagnósticos', () => {
    for (const status of ['SATURATED', 'UNDEREXPOSED', 'LOW_FPS', 'NO_FINGER'] as const) {
      const estimator = new PpgToEcgEstimator(identityModel());
      const signal = observation(0);
      signal.diagnostics!.status = status;
      const before = structuredClone(signal);
      expect(estimator.ingest(signal).status).toBe('INSUFFICIENT');
      expect(signal).toEqual(before);
    }
    const estimator = new PpgToEcgEstimator(identityModel());
    const signal = observation(0);
    signal.diagnostics!.continuity!.valid = false;
    expect(estimator.ingest(signal).status).toBe('INSUFFICIENT');
  });

  it.each([
    { fingerDetected: false }, { contactState: 'NO_CONTACT' as const },
    { motionArtifact: true }, { rawValue: NaN },
  ])('retira salida y reinicia contexto con captura inválida %j', change => {
    const estimator = new PpgToEcgEstimator(identityModel());
    collect(estimator, 60);
    const result = estimator.ingest(observation(2000, change));
    expect(result.status).toBe('INSUFFICIENT');
    expect(result.samples).toEqual([]);
    expect(collect(estimator, 30, 2034).every(item => item.samples.length === 0)).toBe(true);
  });

  it('no acredita un contacto sin evidencia pulsátil y no usa el canal con AGC', () => {
    const estimator = new PpgToEcgEstimator(identityModel());
    const noPulse = observation(0);
    noPulse.diagnostics!.hasPulsatility = false;
    expect(estimator.ingest(noPulse).status).toBe('INSUFFICIENT');
    const a = new PpgToEcgEstimator(identityModel());
    const b = new PpgToEcgEstimator(identityModel());
    let first!: EcgEstimate;
    let second!: EcgEstimate;
    for (let index = 0; index < 60; index++) {
      first = a.ingest(observation(index * 1000 / 30, { displayValue: index * 900, filteredValue: index ** 2 }));
      second = b.ingest(observation(index * 1000 / 30, { displayValue: -index, filteredValue: -1000 }));
    }
    expect(first.samples).toEqual(second.samples);
  });

  it.each([2500, 1950])('corta huecos y reloj invertido sin unir ventanas (%s ms)', nextTime => {
    const estimator = new PpgToEcgEstimator(identityModel());
    collect(estimator, 60);
    const result = estimator.ingest(observation(nextTime));
    expect(result.status).toBe('INSUFFICIENT');
    expect(result.samples).toEqual([]);
    expect(result.reason).toBe(nextTime > 2000 ? 'CAPTURE_GAP' : 'CLOCK');
  });

  it('reinicia ante una época nueva incluso si no hay hueco temporal', () => {
    const estimator = new PpgToEcgEstimator(identityModel());
    collect(estimator, 60);
    const signal = observation(2000);
    signal.diagnostics!.continuity!.epoch = 2;
    expect(estimator.ingest(signal).reason).toBe('EPOCH_CHANGED');
    expect(collect(estimator, 30, 2034).every(item => item.samples.length === 0)).toBe(true);
  });
});
