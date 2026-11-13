import { describe, expect, it } from 'vitest';
import { canCollectMorphologyFrame, evaluateMeasurementReadiness, type MorphologyFrameInput } from '../measurementReadiness';
import {
  createMeasurementSessionLatch,
  updateMeasurementSessionLatch,
} from '../measurementSessionLatch';

describe('measurementReadiness', () => {
  const goodFrame: MorphologyFrameInput = {
    vitalsDspReady: true, hasUsableContact: true, contactState: 'STABLE_CONTACT',
    motionArtifact: false, value: 0.2, timestampMs: 1000,
  };

  it('un cruce por cero conserva la ventana morfológica', () => {
    for (const value of [-0.01, 0, 0.01]) {
      expect(canCollectMorphologyFrame({ ...goodFrame, value })).toBe(true);
    }
  });

  it.each([
    { motionArtifact: true }, { hasUsableContact: false }, { value: NaN },
    { value: undefined }, { timestampMs: Infinity }, { timestampMs: 0 },
    { contactState: 'NO_CONTACT' as const }, { vitalsDspReady: false },
  ])('conserva el rechazo de artefactos o muestras no utilizables: %o', overrides => {
    expect(canCollectMorphologyFrame({ ...goodFrame, ...overrides })).toBe(false);
  });
  it('habilita vitales con dedo, SQI y al menos un pico en latch', () => {
    let latch = createMeasurementSessionLatch();
    latch = updateMeasurementSessionLatch(latch, true, 72, 12, 1000, true);
    latch = updateMeasurementSessionLatch(latch, true, 72, 12, 1800, true);
    const r = evaluateMeasurementReadiness({
      hasUsableContact: true,
      contactState: 'UNSTABLE_CONTACT',
      rawSqi: 15,
      perfusionIndex: 0.002,
      piMin: 0.0001,
      bpm: 72,
      peakRecent: true,
      ensembleConfidence: 0.2,
      minEnsembleConf: 0.12,
      latch,
      nowMs: 1100,
    });
    expect(r.spo2PipelineReady).toBe(true);
    expect(r.vitalsDspReady).toBe(true);
    expect(r.fullVitalsReady).toBe(true);
    expect(r.hrDisplayReady).toBe(true);
  });

  it('no habilita vitales sin contacto', () => {
    const latch = createMeasurementSessionLatch();
    const r = evaluateMeasurementReadiness({
      hasUsableContact: false,
      contactState: 'NO_CONTACT',
      rawSqi: 40,
      perfusionIndex: 0.01,
      piMin: 0.0001,
      bpm: 0,
      peakRecent: false,
      ensembleConfidence: 0,
      minEnsembleConf: 0.12,
      latch,
      nowMs: 1000,
    });
    expect(r.spo2PipelineReady).toBe(false);
    expect(r.vitalsDspReady).toBe(false);
    expect(r.fullVitalsReady).toBe(false);
    expect(r.hrDisplayReady).toBe(false);
  });
});

