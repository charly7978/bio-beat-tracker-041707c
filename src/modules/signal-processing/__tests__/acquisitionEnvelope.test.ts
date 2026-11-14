import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { AdaptivePixelRoi, type AdaptivePixelRoiFrame } from '../../../lib/signal/adaptivePixelRoi';
import { PPGSignalProcessor } from '../PPGSignalProcessor';
import { HeartBeatProcessor } from '../../HeartBeatProcessor';
import type { ProcessedSignal } from '../../../types/signal';

const ImageDataCtor: typeof ImageData = globalThis.ImageData ?? class {
  constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
} as unknown as typeof ImageData;
globalThis.ImageData = ImageDataCtor;

const START_MS = 10_000;
const WIDTH = 64;
const DURATION_SECONDS = 26;
const TARGET_BPM = 72;

type Scene = 'tissue' | 'translate' | 'exposure' | 'dropout' | 'selection' | 'selection-translate' | 'selection-exposure' | 'clipping-boundary' | 'low-perfusion' | 'low-perfusion-translate' | 'static-tissue' | 'moving-static-tissue' | 'neutral-flicker' | 'clipped';
interface Observation {
  seconds: number;
  signal: ProcessedSignal;
  roi: AdaptivePixelRoiFrame;
  heart: ReturnType<HeartBeatProcessor['processSignal']>;
}

// A shared cardiac phase with a systolic shoulder and a smaller harmonic;
// absorption amplitude and DC vary spatially. No downstream signal is replaced.
function pulseAt(seconds: number): number {
  const phase = 2 * Math.PI * TARGET_BPM / 60 * seconds;
  return (Math.sin(phase) + 0.22 * Math.sin(2 * phase - 0.5) + 0.08 * Math.sin(3 * phase + 0.8)) / 1.15;
}

function tissueFrame(seconds: number, scene: Scene): ImageData {
  const data = new Uint8ClampedArray(WIDTH * WIDTH * 4);
  const pulsatile = scene !== 'static-tissue' && scene !== 'moving-static-tissue' && scene !== 'neutral-flicker';
  const pulse = pulsatile ? pulseAt(seconds) * (scene.startsWith('low-perfusion') ? 0.1 : 1) : 0;
  const translating = scene === 'translate' || scene === 'selection-translate' || scene === 'low-perfusion-translate' || scene === 'moving-static-tissue';
  const dx = translating ? 1.5 * Math.sin(2 * Math.PI * 0.17 * seconds) : 0;
  const dy = translating ? 1.1 * Math.sin(2 * Math.PI * 0.13 * seconds + 0.4) : 0;
  const gain = scene === 'exposure' || scene === 'selection-exposure'
    ? 1 + 0.015 * Math.sin(2 * Math.PI * 0.07 * seconds) + (seconds >= 7 ? 0.045 : 0)
    : 1;
  for (let y = 0; y < WIDTH; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const sx = x - dx;
      const sy = y - dy;
      const u = (sx - WIDTH / 2) / WIDTH;
      const v = (sy - WIDTH / 2) / WIDTH;
      const patch = 0.5 + 0.5 * Math.sin(sx * 0.12 + sy * 0.065);
      const partialSelection = scene.startsWith('selection');
      const baseR = scene === 'clipping-boundary' ? 242 + 13 * patch : 183 + 26 * u + 7 * Math.sin(sy * 0.12) + 4 * Math.cos(sx * 0.18) + (partialSelection ? 28 * (patch - 0.5) : 0);
      const baseG = 91 + 15 * u + 10 * v + 4 * Math.cos(sx * 0.09 - sy * 0.06);
      const baseB = 67 + 9 * u + 5 * v + 3 * Math.sin(sy * 0.1);
      // Per-pixel absorption is coherent, with different channel sensitivities.
      const greenOd = -Math.log((baseG + 1) / 256);
      const readout = pulsatile ? 0.18 * Math.sin(17.7 * seconds + x * 1.13 + y * 2.17) : 0;
      let r = ((baseR + 1) * Math.exp(-(0.008 + 0.007 * patch) * pulse) - 1) * gain + readout;
      let g = ((baseG + 1) * Math.exp(-greenOd * (partialSelection ? 0.008 + 0.044 * patch : 0.012 + 0.014 * patch) * pulse) - 1) * gain + readout;
      let b = ((baseB + 1) * Math.exp(-(0.009 + 0.005 * patch) * pulse) - 1) * gain + readout;
      if (scene === 'neutral-flicker') {
        const illumination = 1 + 0.02 * Math.sin(2 * Math.PI * 1.2 * seconds);
        r = (105 + 15 * u + 3 * v) * illumination;
        g = (112 + 12 * u + 2 * v) * illumination;
        b = (108 + 13 * u + 3 * v) * illumination;
      } else if (scene === 'clipped') {
        r = 255;
        g = 135 + 4 * pulse + 2 * u;
        b = 98 + 3 * pulse + 2 * v;
      }
      const index = (y * WIDTH + x) * 4;
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 255;
    }
  }
  return new ImageDataCtor(data, WIDTH, WIDTH);
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
}

// Least-squares sinusoidal power from the actual, timestamped filtered samples.
// This measures preserved fundamental frequency without assuming filter phase.
function frequencyPower(observations: Observation[], bpm: number): number {
  if (observations.length < 10) return 0;
  const mean = observations.reduce((sum, o) => sum + o.signal.filteredValue, 0) / observations.length;
  let sinEnergy = 0, cosEnergy = 0, cross = 0, withSin = 0, withCos = 0, energy = 0;
  for (const o of observations) {
    const phase = 2 * Math.PI * bpm / 60 * o.seconds;
    const sine = Math.sin(phase), cosine = Math.cos(phase);
    const value = o.signal.filteredValue - mean;
    sinEnergy += sine * sine;
    cosEnergy += cosine * cosine;
    cross += sine * cosine;
    withSin += value * sine;
    withCos += value * cosine;
    energy += value * value;
  }
  const determinant = sinEnergy * cosEnergy - cross * cross;
  if (determinant <= 1e-9 || energy <= 1e-9) return 0;
  return (cosEnergy * withSin ** 2 + sinEnergy * withCos ** 2 - 2 * cross * withSin * withCos) / determinant / energy;
}

function replay(scene: Scene, fps: number): Observation[] {
  const observations: Observation[] = [];
  const heart = new HeartBeatProcessor();
  const roi = new AdaptivePixelRoi();
  let roiFrame: AdaptivePixelRoiFrame;
  let previousEpoch: number | undefined;
  const processor = new PPGSignalProcessor(signal => {
    const continuity = signal.diagnostics?.continuity;
    if (continuity && previousEpoch !== undefined && continuity.epoch !== previousEpoch) heart.reset();
    previousEpoch = continuity?.epoch;
    // Match the router's observation gates; display SQI starts after a longer
    // statistics window and must not add an artificial capture delay here.
    const status = signal.diagnostics?.status;
    const valid = signal.fingerDetected && signal.contactState !== 'NO_CONTACT' &&
      !signal.motionArtifact && Number.isFinite(signal.filteredValue) && continuity?.valid !== false &&
      status !== 'SATURATED' && status !== 'UNDEREXPOSED' && status !== 'LOW_FPS' && status !== 'NO_FINGER';
    heart.setFingerContactConfirmed(signal.fingerDetected);
    heart.setFingerPlacementMode(signal.placementMode ?? 'hybrid');
    heart.setPpgQualityMetrics(signal.diagnostics?.sqm?.sqi ?? signal.quality, signal.perfusionIndex, signal.diagnostics?.sqm?.motionScore ?? 0);
    const result = heart.processSignal(signal.filteredValue, signal.timestamp, valid);
    observations.push({ seconds: (signal.timestamp - START_MS) / 1000, signal, roi: roiFrame, heart: result });
  });
  processor.start();
  try {
    for (let frame = 0; frame < fps * DURATION_SECONDS; frame++) {
      const seconds = frame / fps;
      // One three-frame-scale loss plus one 350 ms interruption. Missing frames
      // stay missing; neither benchmark nor detector receives interpolated data.
      if (scene === 'dropout' && ((seconds >= 10 && seconds < 10.1) || (seconds >= 15 && seconds < 15.35))) continue;
      const image = tissueFrame(seconds, scene);
      roiFrame = roi.processFrame(image, fps === 15 && seconds > 4 ? 4 : 3, START_MS + seconds * 1000);
      processor.processFrame(image, START_MS + seconds * 1000);
    }
  } finally {
    processor.stop();
    heart.dispose();
  }
  if (process.env.ACQUISITION_ENVELOPE_TRACE_DIR) {
    writeFileSync(`${process.env.ACQUISITION_ENVELOPE_TRACE_DIR}/${scene}-${fps}.json`, JSON.stringify(observations.map(o => ({
      seconds: o.seconds,
      contact: o.signal.contactState,
      finger: o.signal.fingerDetected,
      quality: o.signal.quality,
      filtered: o.signal.filteredValue,
      raw: o.signal.rawValue,
      continuity: o.signal.diagnostics?.continuity,
      sqi: o.signal.diagnostics?.sqm?.sqi,
      periodicity: o.signal.diagnostics?.sqm?.periodicity,
      pi: o.signal.perfusionIndex,
      bpm: o.heart.bpm,
      isPeak: o.heart.isPeak,
      rr: o.heart.rrData?.intervals,
      lastPeak: o.heart.rrData?.lastPeakTime,
      reason: o.heart.consensusReason ?? o.heart.ensembleDiagnostics?.emitReason,
    })), null, 2));
  }
  return observations;
}

function metrics(scene: Scene, fps: number, observations: Observation[]) {
  const tail = observations.filter(o => o.seconds >= 18);
  const exposureTransition = observations.filter(o => o.seconds >= 7 && o.seconds < 11);
  const published = tail.filter(o => o.heart.bpm > 0);
  const errors = published.map(o => Math.abs(o.heart.bpm - TARGET_BPM));
  const fundamentalPower = frequencyPower(tail, TARGET_BPM);
  const red = tail.map(o => o.signal.rawRed ?? 0);
  const pulse = tail.map(o => pulseAt(o.seconds));
  const redMean = red.reduce((a, b) => a + b, 0) / red.length;
  const pulseMean = pulse.reduce((a, b) => a + b, 0) / pulse.length;
  let rawRedEnergy = 0, pulseEnergy = 0, covariance = 0;
  for (let i = 0; i < red.length; i++) {
    rawRedEnergy += (red[i] - redMean) ** 2;
    pulseEnergy += (pulse[i] - pulseMean) ** 2;
    covariance += (red[i] - redMean) * (pulse[i] - pulseMean);
  }
  let dominantBpm = 0, dominantPower = 0;
  for (let bpm = 40; bpm <= 180; bpm += 0.5) {
    const power = frequencyPower(tail, bpm);
    if (power > dominantPower) { dominantPower = power; dominantBpm = bpm; }
  }
  return {
    scene, fps,
    usable: tail.filter(o => o.signal.fingerDetected && !o.signal.motionArtifact && o.signal.quality > 0).length / tail.length,
    stable: tail.filter(o => o.signal.contactState === 'STABLE_CONTACT').length / tail.length,
    published: published.length / tail.length,
    medianBpm: percentile(published.map(o => o.heart.bpm), 0.5),
    p95ErrorBpm: percentile(errors, 0.95),
    firstBpmSeconds: observations.find(o => o.heart.bpm > 0)?.seconds ?? null,
    firstStableSeconds: observations.find(o => o.signal.contactState === 'STABLE_CONTACT')?.seconds ?? null,
    correctPublished: tail.filter(o => o.heart.bpm > 0 && Math.abs(60_000 / o.heart.bpm - 60_000 / TARGET_BPM) <= 1000 / fps + 1).length / tail.length,
    emittedPeaks: observations.filter(o => o.heart.isPeak).length,
    fundamentalPower, dominantBpm,
    transitionPulsePower: frequencyPower(exposureTransition, TARGET_BPM),
    rawRedRms: Math.sqrt(rawRedEnergy / red.length),
    rawPulseCorrelation: rawRedEnergy * pulseEnergy > 1e-9 ? covariance / Math.sqrt(rawRedEnergy * pulseEnergy) : 0,
    filteredRms: Math.sqrt(tail.reduce((sum, o) => sum + o.signal.filteredValue ** 2, 0) / tail.length),
    medianSqi: percentile(tail.map(o => o.signal.diagnostics?.sqm?.sqi ?? o.signal.quality), 0.5),
    medianPeriodicity: percentile(tail.map(o => o.signal.diagnostics?.sqm?.periodicity ?? 0), 0.5),
    medianPi: percentile(tail.map(o => o.signal.perfusionIndex ?? 0), 0.5),
    roiPenaltyP95: percentile(tail.map(o => o.roi.displacementPenalty), 0.95),
    roiCorrelationP05: percentile(tail.map(o => o.roi.maskCorrelation), 0.05),
    perfused: percentile(tail.map(o => o.roi.perfusionRatio), 0.5),
  };
}

const reports: ReturnType<typeof metrics>[] = [];
function report(result: ReturnType<typeof metrics>): void {
  reports.push(result);
  if (process.env.ACQUISITION_ENVELOPE_REPORT) {
    writeFileSync(process.env.ACQUISITION_ENVELOPE_REPORT, JSON.stringify(reports, null, 2));
  }
}

describe('acquisition envelope: textured RGB through the real ROI, filters and heart detector', () => {
  const positiveCases: { fps: number; scene: Scene }[] = [15, 24, 30, 60].flatMap(fps =>
    (['tissue', 'translate', 'exposure', 'dropout', 'selection', 'selection-translate', 'selection-exposure', 'clipping-boundary'] as const)
      .map(scene => ({ scene, fps })),
  );
  positiveCases.push(...[15, 30, 60].flatMap(fps =>
    (['low-perfusion', 'low-perfusion-translate'] as const).map(scene => ({ scene, fps })),
  ));

  it.each(positiveCases)('preserves a coherent tissue pulse: $scene at $fps fps', ({ scene, fps }) => {
    const observations = replay(scene, fps);
    const result = metrics(scene, fps, observations);
    report(result);
    expect(observations.every(o => Number.isFinite(o.signal.filteredValue))).toBe(true);
    expect(result.usable, 'fraction of real filtered samples accepted after settling').toBeGreaterThan(0.85);
    expect(result.fundamentalPower, 'filtered energy explained by the actual 72 BPM input').toBeGreaterThan(0.8);
    expect(Math.abs(result.dominantBpm - TARGET_BPM)).toBeLessThanOrEqual(1);
    if (scene.startsWith('low-perfusion')) {
      // A pulse near the one-count quantization floor adds timing uncertainty
      // beyond capture cadence. Keep waveform and availability requirements,
      // and bound the published rate error throughout the settled window.
      expect(result.published, 'weak-pulse reading availability').toBeGreaterThan(0.8);
      expect(Math.abs(result.medianBpm - TARGET_BPM), 'weak-pulse median BPM error').toBeLessThanOrEqual(5);
      expect(result.p95ErrorBpm, 'weak-pulse 95th percentile BPM error').toBeLessThanOrEqual(5);
    } else {
      expect(result.correctPublished, 'fraction with BPM present and RR error no larger than one frame').toBeGreaterThan(0.8);
    }
    expect(result.firstBpmSeconds, 'pulse acquisition within eight seconds').not.toBeNull();
    expect(result.firstBpmSeconds!).toBeLessThan(8);
  });

  it.each(['static-tissue', 'moving-static-tissue', 'neutral-flicker', 'clipped'] as const)('publishes no pulse from %s', scene => {
    const observations = replay(scene, 30);
    report(metrics(scene, 30, observations));
    expect(observations.filter(o => o.heart.bpm > 0), 'no reading from static texture or common illumination').toHaveLength(0);
    expect(observations.filter(o => o.heart.isPeak), 'no fabricated heartbeat during acquisition').toHaveLength(0);
  });
});
