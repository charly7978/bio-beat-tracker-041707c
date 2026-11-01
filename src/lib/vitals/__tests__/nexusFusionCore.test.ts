import { describe, it, expect } from 'vitest';
import {
  NexusFusionCore,
  crossSiteObservationFromTiming,
  pwaObservationFromEstimate,
  pttModelToPressures,
  UNCALIBRATED_PTT_MODEL,
  deriveCrossSiteObservation,
  type PttPersonalModel,
  type NexusBpObservation,
} from '../nexusFusionCore';

/** Par de señales de pulso ANALÍTICAS del banco de test (no señales de cámara):
 *  distal = copia retardada de la proximal con τ real conocido. */
function pulsePair(
  pulseHz: number,
  fs: number,
  seconds: number,
  tauMs: number,
): { prox: number[]; dist: number[]; proxPeaks: number[]; distPeaks: number[] } {
  const n = Math.round(fs * seconds);
  const T = fs / pulseHz;
  const latencySamples = Math.round((tauMs / 1000) * fs);
  const build = (latency: number): { series: number[]; peaks: number[] } => {
    const series = new Array<number>(n).fill(0);
    const peaks: number[] = [];
    const beatCount = Math.floor((n - Math.round(2.2 * T)) / T);
    for (let b = 0; b < beatCount; b++) {
      const start = Math.round(b * T) + latency;
      peaks.push(start + Math.round(fs * 0.18));
      for (let k = 0; k < Math.round(2.2 * T) && start + k < n; k++) {
        const t = k / fs;
        let v: number;
        if (t <= 0.08) {
          v = Math.sin((Math.PI * t) / 0.08);
        } else {
          v = Math.exp(-(t - 0.08) / 0.26);
          if (t > 0.3 && t < 0.42) v += 0.15 * Math.sin((Math.PI * (t - 0.3)) / 0.12);
          v = Math.max(0, v);
        }
        series[start + k] += v;
      }
    }
    return { series, peaks };
  };
  const proximal = build(0);
  const distal = build(latencySamples);
  return { prox: proximal.series, dist: distal.series, proxPeaks: proximal.peaks, distPeaks: distal.peaks };
}

const CALIBRATED: PttPersonalModel = {
  kSbpMmHgS2: 4.6,
  cSbpMmHg: 17,
  kDbpMmHgS2: 2.4,
  cDbpMmHg: 20,
  calibrated: true,
};

const T0 = 1_000_000;

describe('nexusFusionCore — motor de fusión [MAP, PP]', () => {
  it('pttModelToPressures: monotonicidad inversa con τ y fórmula clásica aplicada', () => {
    const a = pttModelToPressures(200, CALIBRATED);
    const b = pttModelToPressures(260, CALIBRATED);
    expect(a.sbp).toBeGreaterThan(b.sbp);
    expect(a.dbp).toBeGreaterThan(b.dbp);
    // Verificación numérica directa de la forma k/τ² + c (τ=200 ms → 0.2²)
    const expected = 4.6 / (0.2 * 0.2) + 17;
    expect(a.sbp).toBeCloseTo(expected, 5);
  });

  it('la observación sin calibrar tiene varianza dominante (no pesa casi nada entre fuentes calibradas)', () => {
    const uncal = crossSiteObservationFromTiming(
      { tauMs: 150, quality: 90, spectralCoherence: 0.8, beatsAgreed: 6 },
      UNCALIBRATED_PTT_MODEL,
      T0,
    );
    const cal = crossSiteObservationFromTiming(
      { tauMs: 150, quality: 90, spectralCoherence: 0.8, beatsAgreed: 6 },
      CALIBRATED,
      T0,
    );
    expect(uncal).not.toBeNull();
    expect(cal).not.toBeNull();
    expect(uncal.mapVariance).toBeGreaterThan(cal.mapVariance * 2);
  });

  it('la fusión converge a la referencia del usuario (USER_REFERENCE domina con varianza pequeña)', () => {
    const core = new NexusFusionCore();
    const pwa = pwaObservationFromEstimate(95, 45, 60, T0); // MAP+PP del motor físico
    core.pushObservation(pwa);
    const ref: NexusBpObservation = {
      // SBP=115, DBP=85 → PP=30, MAP=DBP+PP/3=95 (coherente con el motor PWA)
      source: 'USER_REFERENCE',
      map: 95,
      pulsePressure: 30,
      mapVariance: 4, // σ=2 mmHg: referencia de tensiómetro
      pulsePressureVariance: 6,
      quality: 100,
      timestampMs: T0 + 5000,
    };
    core.pushObservation(ref);
    const st = core.getState();
    expect(st.sourcesUsed).toContain('USER_REFERENCE');
    expect(st.systolic).toBeGreaterThan(100);
    expect(st.systolic).toBeLessThan(120);
    expect(st.diastolic).toBeGreaterThan(78);
    expect(st.diastolic).toBeLessThan(98);
    expect(st.confidence).toBe('HIGH');
    // La banda p5–p95 contiene el estimado central
    expect(st.sbpBand.p5).toBeLessThan(st.systolic);
    expect(st.sbpBand.p95).toBeGreaterThan(st.systolic);
  });

  it('una fuente de baja calidad y varianza enorme no arrastra el estado', () => {
    const core = new NexusFusionCore();
    core.pushObservation(pwaObservationFromEstimate(100, 40, 90, T0));
    core.pushObservation({
      source: 'HRV_PROXY',
      map: 130,
      pulsePressure: 70,
      mapVariance: 900, // σ=30 mmHg: evidencia casi nula
      pulsePressureVariance: 900,
      quality: 10,
      timestampMs: T0 + 1000,
    });
    const st = core.getState();
    expect(st.map).toBeGreaterThan(97);
    expect(st.map).toBeLessThan(103);
  });

  it('el paseo del estado crece la banda cuando pasa el tiempo y NO llega evidencia nueva', () => {
    const core = new NexusFusionCore();
    core.pushObservation(pwaObservationFromEstimate(100, 40, 90, T0));
    const tight = core.getState();
    // Observación sin evidencia (varianza casi infinita): el proceso caminante
    // suma Q·dt y la actualización apenas reduce la varianza.
    core.pushObservation({
      source: 'MLP_REGRESSOR',
      map: 100,
      pulsePressure: 40,
      mapVariance: 9_000_000,
      pulsePressureVariance: 9_000_000,
      quality: 0,
      timestampMs: T0 + 300_000, // +5 min
    });
    const loose = core.getState();
    expect(loose.sbpBand.p95 - loose.sbpBand.p5).toBeGreaterThan(tight.sbpBand.p95 - tight.sbpBand.p5);
  });

  it('estado vacío → nulls con confidence null (nada se inventa)', () => {
    const core = new NexusFusionCore();
    const st = core.getState();
    expect(st.systolic).toBeNull();
    expect(st.confidence).toBeNull();
    expect(st.sourcesUsed).toHaveLength(0);
  });

  it('reset limpia todo el estado', () => {
    const core = new NexusFusionCore();
    core.pushObservation(pwaObservationFromEstimate(100, 40, 90, T0));
    core.reset();
    expect(core.getState().systolic).toBeNull();
    expect(core.getState().sourcesUsed).toHaveLength(0);
  });

  it('varianzas inválidas se descartan explícitamente', () => {
    const core = new NexusFusionCore();
    core.pushObservation({ source: 'MLP_REGRESSOR', map: 100, pulsePressure: 40, mapVariance: -5, pulsePressureVariance: 10, quality: 50, timestampMs: T0 });
    expect(core.getState().systolic).toBeNull();
    core.pushObservation({ source: 'MLP_REGRESSOR', map: 100, pulsePressure: 40, mapVariance: 10, pulsePressureVariance: 10, quality: 50, timestampMs: T0 });
    expect(core.getState().systolic).not.toBeNull();
  });
});

describe('deriveCrossSiteObservation — pipeline completo de la fuente cross-site', () => {
  const FS_P = 100;
  const MODEL: PttPersonalModel = {
    kSbpMmHgS2: 4.6,
    cSbpMmHg: 17,
    kDbpMmHgS2: 2.4,
    cDbpMmHg: 20,
    calibrated: true,
  };

  it('ruta feliz: τ=200 ms con coherencia total → observación CROSS_SITE_PTT fisiológica', () => {
    const pair = pulsePair(1.25, FS_P, 12, 200);
    const r = deriveCrossSiteObservation({
      proximal: pair.prox,
      distal: pair.dist,
      sampleRateHz: FS_P,
      timestampMs: T0,
      proximalBpm: 75,
      distalBpm: 75,
      proximalPeakIndices: pair.proxPeaks,
      distalPeakIndices: pair.distPeaks,
      personalModel: MODEL,
    });
    expect(r.timing.reason).toBe('OK');
    expect(r.timing.tauMs).not.toBeNull();
    expect(Math.abs(r.timing.tauMs - 200)).toBeLessThanOrEqual(15);
    expect(r.coherence.level).toBe('CONGRUENT');
    expect(r.observation).not.toBeNull();
    expect(r.observation.source).toBe('CROSS_SITE_PTT');
    expect(r.observation.pulsePressure).toBeGreaterThan(30);
    expect(r.observation.map).toBeGreaterThan(70);
    expect(r.observation.map).toBeLessThan(130);
    expect(r.observation.quality).toBeGreaterThan(50);
  });

  it('HR inter-sitio divergente (72 vs 80) → INCOMPATIBLE y SIN observación', () => {
    const pair = pulsePair(1.25, FS_P, 12, 120);
    const r = deriveCrossSiteObservation({
      proximal: pair.prox,
      distal: pair.dist,
      sampleRateHz: FS_P,
      timestampMs: T0,
      proximalBpm: 72,
      distalBpm: 80,
      proximalPeakIndices: pair.proxPeaks,
      distalPeakIndices: pair.distPeaks,
      personalModel: MODEL,
    });
    expect(r.coherence.level).toBe('INCOMPATIBLE');
    expect(r.observation).toBeNull();
  });

  it('señal sin contenido de pulso → sin τ y SIN observación (nada se inventa)', () => {
    const n = FS_P * 6;
    const plano = new Array<number>(n).fill(0.5);
    const r = deriveCrossSiteObservation({
      proximal: plano,
      distal: plano.slice(0),
      sampleRateHz: FS_P,
      timestampMs: T0,
      personalModel: MODEL,
    });
    expect(r.timing.tauMs).toBeNull();
    expect(r.observation).toBeNull();
  });
});
