import weights from './ppgToEcg.weights.json';
import { CAPTURE_TIMING_DEFAULTS } from '@/config/signalProcessing';
import { BesselFilter } from '@/modules/signal-processing/shared/BesselFilter';
import type { EcgEstimate, ProcessedSignal } from '@/types/signal';

interface DenseLayer {
  /** Matriz con el orden de scikit-learn: entrada × salida. */
  weights: number[][];
  bias: number[];
  activation: 'tanh' | 'relu' | 'linear';
}

export interface PpgToEcgModel {
  modelId: string;
  sampleRate: number;
  inputLength: number;
  outputStart: number;
  outputLength: number;
  filterWarmupSamples: number;
  layers: DenseLayer[];
}

interface CompiledLayer {
  inputSize: number;
  outputSize: number;
  coefficients: Float64Array;
  bias: Float64Array;
  activation: DenseLayer['activation'];
}

const trainedModel = weights as unknown as PpgToEcgModel;

function compileModel(model: PpgToEcgModel): CompiledLayer[] {
  if (!model.modelId || model.sampleRate !== 30 || model.inputLength !== 60 ||
      !Number.isInteger(model.outputStart) || !Number.isInteger(model.outputLength) ||
      model.outputStart < 0 || model.outputLength < 1 ||
      model.outputStart + model.outputLength > model.inputLength ||
      !Number.isInteger(model.filterWarmupSamples) || model.filterWarmupSamples < 0 ||
      !Array.isArray(model.layers) || model.layers.length === 0) {
    throw new Error('Invalid PPG to ECG model contract');
  }
  let inputSize = model.inputLength;
  const layers = model.layers.map(layer => {
    const outputSize = layer.bias.length;
    if (outputSize === 0 || layer.weights.length !== inputSize ||
        !['tanh', 'relu', 'linear'].includes(layer.activation) ||
        !layer.bias.every(Number.isFinite) ||
        layer.weights.some(row => row.length !== outputSize || !row.every(Number.isFinite))) {
      throw new Error('Invalid PPG to ECG model layer');
    }
    const compiled = {
      inputSize, outputSize,
      coefficients: new Float64Array(layer.weights.flat()),
      bias: new Float64Array(layer.bias),
      activation: layer.activation,
    };
    inputSize = outputSize;
    return compiled;
  });
  if (inputSize !== model.outputLength) throw new Error('Invalid PPG to ECG output dimensions');
  return layers;
}

/** Regresión aprendida. La salida conserva las unidades relativas del objetivo de entrenamiento. */
export class PpgToEcgNetwork {
  private readonly layers: CompiledLayer[];

  constructor(readonly model: PpgToEcgModel = trainedModel) {
    this.layers = compileModel(model);
  }

  predict(input: readonly number[]): number[] | null {
    if (input.length !== this.model.inputLength || !input.every(Number.isFinite)) return null;
    const mean = input.reduce((sum, value) => sum + value, 0) / input.length;
    const variance = input.reduce((sum, value) => sum + (value - mean) ** 2, 0) / input.length;
    const scale = Math.sqrt(variance);
    if (!Number.isFinite(scale) || scale <= 0) return null;
    let values: Float64Array = Float64Array.from(input, value => (value - mean) / scale);
    for (const layer of this.layers) {
      const output = new Float64Array(layer.bias);
      for (let i = 0; i < layer.inputSize; i++) {
        const row = i * layer.outputSize;
        for (let j = 0; j < layer.outputSize; j++) output[j] += values[i] * layer.coefficients[row + j];
      }
      if (layer.activation === 'tanh') {
        for (let j = 0; j < output.length; j++) output[j] = Math.tanh(output[j]);
      } else if (layer.activation === 'relu') {
        for (let j = 0; j < output.length; j++) output[j] = Math.max(0, output[j]);
      }
      values = output;
    }
    return values.every(Number.isFinite) ? Array.from(values) : null;
  }
}

/**
 * Inferencia en el Worker canónico. Sólo consume observaciones ópticas válidas;
 * no modifica detección de latidos, RR, signos vitales ni sus gates.
 */
export class PpgToEcgEstimator {
  private readonly network: PpgToEcgNetwork;
  private readonly filter: BesselFilter;
  private previous: { timestamp: number; value: number } | null = null;
  private nextGridTime = 0;
  private epoch: number | null = null;
  private filteredSamples = 0;
  private head = 0;
  private size = 0;
  private sincePrediction = 0;
  private published = false;
  private readonly values: Float64Array;
  private readonly times: Float64Array;

  constructor(model: PpgToEcgModel = trainedModel) {
    this.network = new PpgToEcgNetwork(model);
    this.filter = new BesselFilter(30, .5, 12);
    this.values = new Float64Array(model.inputLength);
    this.times = new Float64Array(model.inputLength);
  }

  reset(): void {
    this.previous = null;
    this.nextGridTime = 0;
    this.epoch = null;
    this.filteredSamples = 0;
    this.head = 0;
    this.size = 0;
    this.sincePrediction = 0;
    this.published = false;
    this.filter.reset();
  }

  private result(status: EcgEstimate['status'], reason?: string): EcgEstimate {
    const model = this.network.model;
    return {
      modelId: model.modelId, status, samples: [], reason,
      latencyMs: (model.inputLength - model.outputStart - model.outputLength) * 1000 / model.sampleRate,
      warmupProgress: Math.min(1, this.filteredSamples / (model.filterWarmupSamples + model.inputLength)),
    };
  }

  ingest(signal: ProcessedSignal): EcgEstimate {
    const invalidStatus = ['SATURATED', 'UNDEREXPOSED', 'LOW_FPS', 'NO_FINGER', 'MOTION_ARTIFACT'];
    const valid = signal.fingerDetected && signal.contactState === 'STABLE_CONTACT' &&
      signal.diagnostics?.hasPulsatility === true &&
      !signal.motionArtifact && signal.diagnostics?.continuity?.valid !== false &&
      !invalidStatus.includes(signal.diagnostics?.status ?? '') &&
      Number.isFinite(signal.rawValue) && Number.isFinite(signal.timestamp);
    if (!valid) {
      this.reset();
      return this.result('INSUFFICIENT', 'QUALITY');
    }
    const epoch = signal.diagnostics?.continuity?.epoch;
    if (epoch !== undefined && this.epoch !== null && epoch !== this.epoch) {
      this.reset();
      this.epoch = epoch;
      return this.result('INSUFFICIENT', 'EPOCH_CHANGED');
    }
    if (epoch !== undefined) this.epoch = epoch;
    const current = { timestamp: signal.timestamp, value: signal.rawValue };
    if (this.previous) {
      const elapsed = current.timestamp - this.previous.timestamp;
      if (elapsed <= 0 || elapsed > CAPTURE_TIMING_DEFAULTS.maxFrameGapMs) {
        this.reset();
        this.epoch = epoch ?? null;
        return this.result('INSUFFICIENT', elapsed <= 0 ? 'CLOCK' : 'CAPTURE_GAP');
      }
    } else {
      this.previous = current;
      this.nextGridTime = current.timestamp;
    }
    const previous = this.previous;
    let result = this.result(this.published ? 'AVAILABLE' : 'WARMUP', this.filteredSamples < this.network.model.filterWarmupSamples ? 'FILTER_WARMUP' : 'CONTEXT');
    const samples: EcgEstimate['samples'] = [];
    const intervalMs = 1000 / this.network.model.sampleRate;
    while (this.nextGridTime <= current.timestamp + 1e-6) {
      const fraction = current.timestamp === previous.timestamp ? 0 :
        (this.nextGridTime - previous.timestamp) / (current.timestamp - previous.timestamp);
      const value = previous.value + (current.value - previous.value) * Math.max(0, Math.min(1, fraction));
      const next = this.acceptUniform(value, this.nextGridTime);
      if (next) {
        result = next;
        samples.push(...next.samples);
      }
      this.nextGridTime += intervalMs;
    }
    this.previous = current;
    if (samples.length) result.samples = samples;
    result.warmupProgress = Math.min(1, this.filteredSamples / (this.network.model.filterWarmupSamples + this.network.model.inputLength));
    return result;
  }

  private acceptUniform(value: number, timestamp: number): EcgEstimate | null {
    const model = this.network.model;
    const filtered = this.filter.filter(value);
    this.filteredSamples++;
    if (this.filteredSamples <= model.filterWarmupSamples) return null;
    this.values[this.head] = filtered;
    this.times[this.head] = timestamp;
    this.head = (this.head + 1) % model.inputLength;
    this.size = Math.min(model.inputLength, this.size + 1);
    this.sincePrediction++;
    if (this.size < model.inputLength || (this.published && this.sincePrediction < model.outputLength)) return null;
    this.sincePrediction = 0;
    const input = Array.from({ length: model.inputLength }, (_, index) => this.values[(this.head + index) % model.inputLength]);
    const output = this.network.predict(input);
    if (!output) {
      this.published = false;
      return this.result('INSUFFICIENT', 'MODEL_INPUT');
    }
    this.published = true;
    return {
      ...this.result('AVAILABLE'),
      samples: output.map((predicted, index) => ({
        timestamp: this.times[(this.head + model.outputStart + index) % model.inputLength],
        value: predicted,
      })),
    };
  }
}
