import { describe, expect, it } from 'vitest';
import { PPGSignalProcessor } from '../PPGSignalProcessor';
import { HeartBeatProcessor } from '../../HeartBeatProcessor';
import type { ProcessedSignal } from '../../../types/signal';

const ImageDataCtor: typeof ImageData = globalThis.ImageData ?? class {
  constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
} as unknown as typeof ImageData;
globalThis.ImageData = ImageDataCtor;

function frame(r: number, g: number, b: number): ImageData {
  const data = new Uint8ClampedArray(48 * 48 * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
  return new ImageDataCtor(data, 48, 48);
}

function replay(hz: number, kind: 'pulse' | 'static' | 'step' | 'clipped' = 'pulse', bpm = 72) {
  const outputs: ProcessedSignal[] = [];
  const bpms: number[] = [];
  const heart = new HeartBeatProcessor();
  const proc = new PPGSignalProcessor(signal => {
    outputs.push(signal);
    const valid = signal.fingerDetected && !signal.motionArtifact && signal.quality > 0;
    heart.setFingerContactConfirmed(signal.fingerDetected);
    heart.setPpgQualityMetrics(signal.diagnostics?.sqm?.sqi ?? signal.quality, signal.perfusionIndex, signal.diagnostics?.sqm?.motionScore ?? 0);
    const result = heart.processSignal(valid ? signal.filteredValue : 0, signal.timestamp, valid);
    if (signal.timestamp >= 18_000 && result.bpm > 0) bpms.push(result.bpm);
  });
  proc.start();
  for (let i = 0; i < hz * 16; i++) {
    const t = i / hz;
    const s = kind === 'static' ? 0 : Math.sin(2 * Math.PI * (bpm / 60) * t);
    const step = kind === 'step' && t >= 5 ? 25 : 0;
    proc.processFrame(frame(kind === 'clipped' ? 255 : 180 + 8 * s + step, 95 + 5 * s + step * 0.4, 75 + 4 * s + step * 0.3), 10_000 + t * 1000);
  }
  proc.stop(); heart.dispose();
  const tail = outputs.filter(s => s.timestamp >= 18_000);
  const median = (xs: number[]) => [...xs].sort((a,b)=>a-b)[Math.floor(xs.length / 2)] ?? 0;
  return { outputs, bpms, medianBpm: median(bpms), usableFraction: tail.filter(s=>s.quality>0 && !s.motionArtifact).length / tail.length,
    medianQuality: median(tail.map(s=>s.quality)), stableFraction: tail.filter(s=>s.contactState==='STABLE_CONTACT').length / tail.length };
}

describe('RGB → filtros → detector, sin sustituir la señal entre etapas', () => {
  it.each([15, 24, 30, 60])('recupera un pulso de 72 BPM a %i fps, también tras cambio de iluminación', hz => {
    for (const kind of ['pulse', 'step'] as const) {
      const result = replay(hz, kind);
      expect(result.bpms.length).toBeGreaterThan(hz * 3);
      expect(Math.abs(result.medianBpm - 72)).toBeLessThan(5);
      expect(result.usableFraction).toBeGreaterThan(0.8);
      expect(result.outputs.every(s => Number.isFinite(s.filteredValue))).toBe(true);
    }
  });

  it.each([15, 24, 30])('no publica pulso desde imagen estática ni rojo recortado a %i fps', hz => {
    for (const kind of ['static', 'clipped'] as const) {
      const result = replay(hz, kind);
      expect(result.bpms).toEqual([]);
      expect(result.usableFraction).toBe(0);
      expect(result.stableFraction).toBe(0);
      if (kind === 'clipped') {
        const last = result.outputs.at(-1)!;
        expect(last.diagnostics?.photometry).toEqual({ sealRatio: 1, tissueRed: 255, clippedRatio: 1 });
        expect(last.diagnostics?.placementEvidence?.etiology.cause).toBe('SATURATED');
      }
    }
  });

  it.each([48, 120])('conserva pulsos de %i BPM con cámaras de distinta cadencia', bpm => {
    for (const hz of [15, 30]) {
      const result = replay(hz, 'pulse', bpm);
      expect(result.bpms.length).toBeGreaterThan(hz * 2);
      // Una muestra de incertidumbre en RR: 15 fps no resuelve subcuadros.
      expect(Math.abs(60_000 / result.medianBpm - 60_000 / bpm)).toBeLessThanOrEqual(1000 / hz);
    }
  });

  it('no integra timestamps repetidos, invertidos o no finitos y reinicia tras una pausa', () => {
    const outputs: ProcessedSignal[] = [];
    const proc = new PPGSignalProcessor(signal => outputs.push(signal));
    proc.start();
    try {
      const image = frame(180, 95, 75);
      proc.processFrame(image, 1000);
      for (const time of [1000, 999, NaN, Infinity, 0]) proc.processFrame(image, time);
      expect(outputs.map(s => s.timestamp)).toEqual([1000]);
      proc.processFrame(image, 1033);
      expect(outputs).toHaveLength(2);
      proc.processFrame(image, 5000);
      const fresh: ProcessedSignal[] = [];
      const reference = new PPGSignalProcessor(signal => fresh.push(signal));
      reference.start();
      try {
        reference.processFrame(image, 5000);
        expect(outputs.at(-1)?.diagnostics?.continuity?.epoch).toBeGreaterThan(outputs[0].diagnostics?.continuity?.epoch ?? 0);
        const omitEpoch = (signal: ProcessedSignal) => ({ ...signal, diagnostics: { ...signal.diagnostics,
          continuity: { ...signal.diagnostics?.continuity, epoch: 0 } } });
        expect(omitEpoch(outputs.at(-1)!)).toEqual(omitEpoch(fresh[0]));
      } finally { reference.stop(); }
    } finally { proc.stop(); }
  });
});
