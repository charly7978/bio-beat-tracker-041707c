import { describe, it, expect } from 'vitest';
import {
  estimateCrossSiteTransitTime,
  onsetIndexNearPeak,
  type CrossSiteTimingOptions,
} from '../crossSiteTransitTime';

/**
 * Banco de señales ANALÍTICAS de referencia para el test (no señales de
 * cámara): forma de pulso sistólico realista — subida rápida, caída exponencial
 * con muesca dicrótica pequeña — construida matemáticamente.
 */
function pulseTrain(
  pulseHz: number,
  fs: number,
  seconds: number,
  latencyMs = 0,
  amplitude = 1,
): { series: number[]; peakIndices: number[] } {
  const n = Math.round(fs * seconds);
  const series = new Array<number>(n).fill(0);
  const beatPeriodSamples = Math.round(fs / pulseHz);
  const peakIndices: number[] = [];
  const latencySamples = Math.round((latencyMs / 1000) * fs);

  for (let beat = 0; ; beat++) {
    const start = beat * beatPeriodSamples + latencySamples;
    if (start + beatPeriodSamples >= n) break;
    peakIndices.push(start + Math.round(fs * 0.18)); // pico sistólico ~18% del ciclo
    for (let k = 0; k < beatPeriodSamples * 2 && start + k < n; k++) {
      const t = k / fs;
      const riseMs = 80;
      const decayTcMs = 260;
      const dicroticMs = 300;
      let value = 0;
      if (t <= riseMs / 1000) {
        value = Math.sin((Math.PI * t * 1000) / riseMs);
      } else {
        value = Math.exp(-(t * 1000 - riseMs) / decayTcMs);
        const dtDicrotic = t * 1000 - dicroticMs;
        if (dtDicrotic > 0 && dtDicrotic < 120) value += 0.18 * Math.sin((Math.PI * dtDicrotic) / 120);
        value = Math.max(0, value);
      }
      series[start + k] += amplitude * value;
    }
  }
  return { series, peakIndices };
}

const FS = 100;
const SECONDS = 12;
const TAU_TRUE_MS = 120;

function baseOptions(extensions: Partial<CrossSiteTimingOptions> = {}): CrossSiteTimingOptions {
  return { sampleRateHz: FS, ...extensions };
}

describe('crossSiteTransitTime — estimador GCC-PHAT + pie de onda', () => {
  it('recupera τ de una señal distal retardada (camino GCC-PHAT, sin picos dados)', () => {
    const prox = pulseTrain(1.25, FS, SECONDS).series;
    const dist = pulseTrain(1.25, FS, SECONDS, TAU_TRUE_MS, 0.65).series;

    const r = estimateCrossSiteTransitTime(prox, dist, baseOptions());
    expect(r.reason).toBe('OK');
    expect(r.tauMs).not.toBeNull();
    expect(Math.abs(r.tauMs - TAU_TRUE_MS)).toBeLessThanOrEqual(12);
    expect(r.quality).toBeGreaterThanOrEqual(55);
  });

  it('camino de pie de onda: τ por latidos con picos explícitos', () => {
    const proxRes = pulseTrain(1.25, FS, SECONDS);
    const distRes = pulseTrain(1.25, FS, SECONDS, TAU_TRUE_MS, 0.6);
    const r = estimateCrossSiteTransitTime(proxRes.series, distRes.series, baseOptions({
      proximalPeakIndices: proxRes.peakIndices,
      distalPeakIndices: distRes.peakIndices,
    }));
    expect(r.tauMs).not.toBeNull();
    expect(r.onsetLagMs).not.toBeNull();
    expect(Math.abs(r.onsetLagMs - TAU_TRUE_MS)).toBeLessThanOrEqual(10);
    expect(r.beatsAgreed).toBeGreaterThanOrEqual(3);
    expect(Math.abs(r.tauMs - TAU_TRUE_MS)).toBeLessThanOrEqual(10);
  });

  it('invarianza de amplitud: la señal distal con 40% de amplitud sigue dando τ', () => {
    const prox = pulseTrain(1.4, FS, SECONDS).series;
    const dist = pulseTrain(1.4, FS, SECONDS, TAU_TRUE_MS, 0.4).series;
    const r = estimateCrossSiteTransitTime(prox, dist, baseOptions());
    expect(r.tauMs).not.toBeNull();
    expect(Math.abs(r.tauMs - TAU_TRUE_MS)).toBeLessThanOrEqual(14);
  });

  it('τ fuera de banda fisiológica se RECHAZA (con picos provistos, sin recorte)', () => {
    const proxRes = pulseTrain(1.25, FS, SECONDS);
    // τ real=500 ms (>350 mmHg del máximo por defecto): el pie de onda lo mide
    // y la banda fisiológica lo condena.
    const distRes = pulseTrain(1.25, FS, SECONDS, 500, 0.8);
    const r = estimateCrossSiteTransitTime(proxRes.series, distRes.series, baseOptions({
      proximalPeakIndices: proxRes.peakIndices,
      distalPeakIndices: distRes.peakIndices,
    }));
    expect(r.tauMs).toBeNull();
    expect(r.onsetLagMs).not.toBeNull();
    expect(r.onsetLagMs).toBeGreaterThan(400);
    expect(r.reason).toBe('PHYSIOLOGICAL_RANGE');
  });

  it('señal degenerada (plana) → rechazo con motivo técnico', () => {
    const prox = pulseTrain(1.25, FS, 6).series;
    const dist = new Array<number>(prox.length).fill(0.001);
    const r = estimateCrossSiteTransitTime(prox, dist, baseOptions());
    expect(r.tauMs).toBeNull();
    expect(r.reason).toBe('DEGENERATE_SIGNAL');
  });

  it('energía fuera de banda de pulso → rechazo por contenido', () => {
    // Señal respiratoria pura (0.25 Hz) — debajo de la banda de pulso
    const n = FS * SECONDS;
    const respiratoria: number[] = [];
    for (let i = 0; i < n; i++) {
      respiratoria.push(Math.sin((2 * Math.PI * 0.25 * i) / FS));
    }
    const r = estimateCrossSiteTransitTime(respiratoria, respiratoria.slice(0), baseOptions());
    expect(r.tauMs).toBeNull();
    expect(r.reason).toBe('LOW_PULSE_BAND_ENERGY');
  });

  it('acuerdo dual: ambos caminos miden el mismo τ (210 ms) → OK con calidad alta', () => {
    const proxRes = pulseTrain(1.25, FS, SECONDS);
    const distRes = pulseTrain(1.25, FS, SECONDS, 210, 0.7);
    const r = estimateCrossSiteTransitTime(proxRes.series, distRes.series, baseOptions({
      proximalPeakIndices: proxRes.peakIndices,
      distalPeakIndices: distRes.peakIndices,
    }));
    expect(r.reason).toBe('OK');
    expect(r.tauMs).not.toBeNull();
    expect(Math.abs(r.tauMs - 210)).toBeLessThanOrEqual(14);
    expect(Math.abs(r.gccLagMs - 210)).toBeLessThanOrEqual(14);
    expect(Math.abs(r.onsetLagMs - 210)).toBeLessThanOrEqual(14);
    expect(r.quality).toBeGreaterThan(75);
    expect(r.confidenceLevel).toBe('HIGH');
  });

  it('ventana demasiado corta → TOO_SHORT_WINDOW', () => {
    const short = pulseTrain(1.25, FS, 2).series;
    const r = estimateCrossSiteTransitTime(short, short.slice(0), baseOptions());
    expect(r.tauMs).toBeNull();
    expect(r.reason).toBe('TOO_SHORT_WINDOW');
  });

  it('onsetIndexNearPeak: tangente del frente sistólico cae antes del pico', () => {
    const { series, peakIndices } = pulseTrain(1.25, FS, 4);
    const period = FS / 1.25;
    const smoothed = series.map((_, i) => {
      const a = series[Math.max(0, i - 1)];
      const b = series[i];
      const c = series[Math.min(series.length - 1, i + 1)];
      return (a + b + c) / 3;
    });
    for (const p of peakIndices.slice(1, 5)) {
      const onset = onsetIndexNearPeak(smoothed, p, period);
      expect(onset).toBeLessThan(p);
      expect(p - onset).toBeGreaterThan(Math.round(period * 0.05));
      expect(p - onset).toBeLessThan(Math.round(period * 0.45));
    }
  });
});
