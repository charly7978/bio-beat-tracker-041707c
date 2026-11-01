import { describe, it, expect } from 'vitest';
import {
  NexusSessionEngine,
  createIdleNexusSnapshot,
  type NexusDistalSample,
  type NexusProximalSample,
} from '../nexusSessionEngine';

const FS = 30;
const FREQ_HZ = 1.25;

/**
 * Serie de pulso ANALÍTICA del banco de prueba (constructor matemático, no
 * señal de cámara): subida sistólica 80 ms + decaimiento exponencial 260 ms,
 * con retardo `tauMs` opcional (duplicado retardado de la misma forma).
 */
function buildSeries(params: {
  tauMs: number;
  seconds: number;
  faceSeen?: boolean;
  contactOk?: boolean;
}): { proximal: NexusProximalSample[]; distal: NexusDistalSample[] } {
  const n = Math.round(FS * params.seconds);
  const distal: NexusDistalSample[] = [];
  const proximal: NexusProximalSample[] = [];
  const pulseValue = (tMs: number): number => {
    const period = 1000 / FREQ_HZ;
    const t = ((tMs % period) + period) % period;
    if (t <= 80) return Math.sin((Math.PI * t) / 80);
    let v = Math.exp(-(t - 80) / 260);
    if (t > 300 && t < 420) v += 0.18 * Math.sin((Math.PI * (t - 300)) / 120);
    return Math.max(0, v);
  };
  for (let i = 0; i < n; i++) {
    const ts = Math.round((i * 1000) / FS);
    const latency = Math.round((params.tauMs / 1000) * FS) * (1000 / FS);
    proximal.push({ tsMs: ts, value: pulseValue(ts), faceSeen: params.faceSeen ?? true });
    distal.push({
      tsMs: ts,
      value: ts >= latency ? pulseValue(ts - latency) : 0,
      contactOk: params.contactOk ?? true,
    });
  }
  return { proximal, distal };
}

/**
 * Alimenta el motor con flujos asincronizados (los ts de ambos sitios son la
 * misma línea temporal) y evalúa al final de la alimentación.
 */
function feedAndEvaluate(
  engine: NexusSessionEngine,
  series: { proximal: NexusProximalSample[]; distal: NexusDistalSample[] },
  nowMs: number,
) {
  for (const s of series.distal) engine.pushDistal(s);
  for (const s of series.proximal) engine.pushProximal(s);
  return engine.maybeEvaluate(nowMs);
}

describe('nexusSessionEngine — estados y degradación de la sesión dual', () => {
  it('ruta feliz: τ=100 ms coherente → ACTIVE_NEXUS con observación lista', () => {
    const engine = new NexusSessionEngine();
    engine.activate();
    engine.setProximalCapture('L2', true, 'PROXIMAL_ABIERTO');
    const series = buildSeries({ tauMs: 100, seconds: 10 });
    const snap = feedAndEvaluate(engine, series, 10_000);

    expect(snap.status).toBe('ACTIVE_NEXUS');
    expect(snap.tauMs).not.toBeNull();
    expect(Math.abs((snap.tauMs ?? 0) - 100)).toBeLessThanOrEqual(15);
    expect(snap.observation).not.toBeNull();
    expect(snap.observation?.source).toBe('CROSS_SITE_PTT');
    expect(snap.dualWindowSeconds).toBeGreaterThan(7.9);
    expect(snap.reason).toBe('OK');
  });

  it('sin negociación de captura → WAITING_PROXIMAL_CAPTURE con motivo del intento', () => {
    const engine = new NexusSessionEngine();
    engine.activate();
    const series = buildSeries({ tauMs: 100, seconds: 10 });
    const snap = feedAndEvaluate(engine, series, 10_000);
    expect(snap.status).toBe('WAITING_PROXIMAL_CAPTURE');
    expect(snap.reason).toBe('SIN_INTENTO_DE_CAPTURA');

    engine.setProximalCapture('L0', false, 'API_NO_DISPONIBLE');
    engine.activate(); // re-activación limpia buffers y motivos pendientes
    const series2 = buildSeries({ tauMs: 100, seconds: 10 });
    const snap2 = feedAndEvaluate(engine, series2, 20_000);
    expect(snap2.status).toBe('WAITING_PROXIMAL_CAPTURE');

    // Motivo técnico del puente: la captura fracasó (frontal no disponible)
    const engine3 = new NexusSessionEngine();
    engine3.activate();
    engine3.setProximalCapture('L0', false, 'API_NO_DISPONIBLE');
    const snap3 = feedAndEvaluate(engine3, buildSeries({ tauMs: 100, seconds: 10 }), 10_000);
    expect(snap3.status).toBe('WAITING_PROXIMAL_CAPTURE');
    expect(snap3.reason).toBe('API_NO_DISPONIBLE');
  });

  it('solo sitio distal (proximal mudo) → estado degradado con motivo claro', () => {
    const engine = new NexusSessionEngine();
    engine.activate();
    engine.setProximalCapture('L2', true, 'PROXIMAL_ABIERTO');
    for (const s of buildSeries({ tauMs: 100, seconds: 10 }).distal) engine.pushDistal(s);
    const snap = engine.maybeEvaluate(10_000);
    expect(snap.status).toBe('DEGRADED_NO_EVIDENCE');
    expect(snap.reason).toBe('SITIO_PROXIMAL_MUDO');
  });

  it('contacto del dedo perdido en la última muestra → degradación honesta', () => {
    const engine = new NexusSessionEngine();
    engine.activate();
    engine.setProximalCapture('L2', true, 'PROXIMAL_ABIERTO');
    const series = buildSeries({ tauMs: 100, seconds: 10, contactOk: false });
    const snap = feedAndEvaluate(engine, series, 10_000);
    expect(snap.status).toBe('DEGRADED_NO_EVIDENCE');
    expect(snap.reason).toBe('CONTACTO_DISTAL_PERDIDO');
  });

  it('rostro fuera de encuadre en la última muestra (gyms) → degradación honesta', () => {
    const engine = new NexusSessionEngine();
    engine.activate();
    engine.setProximalCapture('L2', true, 'PROXIMAL_ABIERTO');
    const series = buildSeries({ tauMs: 100, seconds: 10, faceSeen: false });
    const snap = feedAndEvaluate(engine, series, 10_000);
    expect(snap.status).toBe('DEGRADED_NO_EVIDENCE');
    expect(snap.reason).toBe('ROSTRO_PROXIMAL_AUSENTE');
  });

  it('ventana incompleta al arrancar → WARMING_UP (sin evaluación falsa)', () => {
    const engine = new NexusSessionEngine();
    engine.activate();
    engine.setProximalCapture('L2', true, 'PROXIMAL_ABIERTO');
    const series = buildSeries({ tauMs: 100, seconds: 3.5 });
    const snap = feedAndEvaluate(engine, series, 3_500);
    expect(snap.status).toBe('WARMING_UP');
    expect(snap.reason).toBe('VENTANA_COMUN_INCOMPLETA');
    expect(snap.observation).toBeNull();
  });

  it('coherencia rechazada entre señales no relacionadas → DEGRADED_INCOMPATIBLE', () => {
    const engine = new NexusSessionEngine();
    engine.activate();
    engine.setProximalCapture('L2', true, 'PROXIMAL_ABIERTO');

    // sitios con pulsos en frecuencia distinta (no representan el mismo corazón)
    const proximal: NexusProximalSample[] = [];
    const distal: NexusDistalSample[] = [];
    const valueAt = (t: number, hz: number): number =>
      Math.sin((2 * Math.PI * hz * t) / 1000);
    for (let i = 0; i < FS * 10; i++) {
      const ts = Math.round((i * 1000) / FS);
      proximal.push({ tsMs: ts, value: valueAt(ts, 2.4), faceSeen: true });
      distal.push({ tsMs: ts, value: valueAt(ts, 0.8), contactOk: true });
    }
    const snap = feedAndEvaluate(engine, { proximal, distal }, 10_000);
    expect(snap.status).toBe('DEGRADED_INCOMPATIBLE');
    expect(snap.observation).toBeNull();
  });

  it('cadencia: evaluaciones dentro del intervalo devuelven el snapshot vigente', () => {
    const engine = new NexusSessionEngine();
    engine.activate();
    engine.setProximalCapture('L2', true, 'PROXIMAL_ABIERTO');
    const series = buildSeries({ tauMs: 100, seconds: 10 });
    for (const s of series.distal) engine.pushDistal(s);
    for (const s of series.proximal) engine.pushProximal(s);
    const first = engine.maybeEvaluate(10_000);
    const second = engine.maybeEvaluate(10_400);
    expect(second).toBe(first); // mismo objeto: sin re-trabajo
    const third = engine.maybeEvaluate(12_000);
    expect(third).not.toBe(first); // tras la cadencia se vuelve a evaluar
  });

  it('desactivar limpia buffers y vuelve a INACTIVE; feed desactivado no acumula', () => {
    const engine = new NexusSessionEngine();
    engine.activate();
    engine.setProximalCapture('L2', true, 'PROXIMAL_ABIERTO');
    const series = buildSeries({ tauMs: 100, seconds: 10 });
    feedAndEvaluate(engine, series, 10_000);
    engine.deactivate();
    const snap = engine.maybeEvaluate(20_000);
    expect(snap.status).toBe('INACTIVE');
    expect(snap.reason).toBe('SESION_INACTIVA');
    expect(createIdleNexusSnapshot().status).toBe('INACTIVE');
  });
});
