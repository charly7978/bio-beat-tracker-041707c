import { describe, expect, it } from 'vitest';
import { CircularBuffer } from '@/utils/CircularBuffer';
import type { EcgEstimate } from '@/types/signal';
import { drawEstimatedEcg } from '../estimatedEcgRenderer';
import type { PpgRenderState } from '../ppgCanvasRenderer';

const SIGNAL_COLOR = '#e8c080';

function contextRecorder() {
  const labels: Array<{ text: string; font: string }> = [];
  const strokes: Array<{ color: string; points: Array<{ x: number; y: number }> }> = [];
  const dots: Array<{ x: number; y: number }> = [];
  let path: Array<{ x: number; y: number }> = [];
  const fields: Record<string, unknown> = { font: '', strokeStyle: '', fillStyle: '', textAlign: '' };
  const methods: Record<string, (...args: never[]) => unknown> = {
    beginPath: () => { path = []; },
    moveTo: (x: number, y: number) => { path.push({ x, y }); },
    lineTo: (x: number, y: number) => { path.push({ x, y }); },
    stroke: () => { strokes.push({ color: String(fields.strokeStyle), points: path.slice() }); },
    fillText: (text: string) => { labels.push({ text, font: String(fields.font) }); },
    fillRect: (x: number, y: number, width: number, height: number) => {
      if (fields.fillStyle === SIGNAL_COLOR && width < 2 && height < 2) dots.push({ x, y });
    },
    measureText: (text: string) => ({ width: text.length * 6 }),
  };
  const ctx = new Proxy(fields, {
    get: (target, key: string) => methods[key] ?? target[key] ?? (() => undefined),
    set: (target, key: string, value) => { target[key] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, labels, strokes, dots };
}

function state(): PpgRenderState {
  return {
    layout: { plot: { x: 12, y: 100, w: 296, h: 100, centerY: 150 } },
    props: { isMonitoring: true, isFingerDetected: true, contactState: 'STABLE_CONTACT' },
    now: 2000, windowMs: 2000,
  } as unknown as PpgRenderState;
}

function prediction(status: EcgEstimate['status'] = 'AVAILABLE', reason?: string): EcgEstimate {
  return { modelId: 'paired-recordings-model', status, samples: [], latencyMs: 766.7, reason };
}

function recording(points: Array<[number, number]> = [[100, 0], [150, 1], [200, -.4], [250, .2]]): CircularBuffer {
  const buffer = new CircularBuffer(50);
  for (const [time, value] of points) buffer.push({ time, value, isArrhythmia: false });
  return buffer;
}

describe('representación de la salida del modelo PPG a ECG', () => {
  it('dibuja salidas ya recibidas entre lotes, declara el retardo y deja sin trazo el tiempo todavía no estimado', () => {
    const recorder = contextRecorder();
    const view = state();
    drawEstimatedEcg(recorder.ctx, view, recording(), prediction());
    const signals = recorder.strokes.filter(stroke => stroke.color === SIGNAL_COLOR);
    expect(signals).toHaveLength(1);
    expect(signals[0].points.map(point => point.x)).toEqual([26.8, 34.2, 41.6, 49]);
    expect(Math.max(...signals[0].points.map(point => point.x))).toBeLessThan(view.layout.plot.x + view.layout.plot.w);
    expect(recorder.labels.some(label => label.text === 'Experimental · retardo 0.77 s · u.r.')).toBe(true);
    expect(recorder.labels.some(label => label.text === 'PPG→ECG · CONCORDANCIA BAJA')).toBe(true);
    expect(recorder.labels.some(label => label.text.includes('ECG ESTIMADO'))).toBe(false);
    for (const label of recorder.labels) expect(Number(label.font.match(/(\d+)px/)?.[1])).toBeGreaterThanOrEqual(11);
  });

  it.each(['WARMUP', 'INSUFFICIENT'] as const)('retira salidas antiguas durante %s sin crear una línea de espera', status => {
    const recorder = contextRecorder();
    drawEstimatedEcg(recorder.ctx, state(), recording(), prediction(status, 'QUALITY'));
    expect(recorder.strokes).toEqual([]);
    expect(recorder.dots).toEqual([]);
    expect(recorder.labels.some(label => label.text.startsWith('±'))).toBe(false);
  });

  it.each(['contact', 'monitoring'] as const)('retira el trazado al perder %s aunque el último estado sea AVAILABLE', condition => {
    const recorder = contextRecorder();
    const view = state();
    if (condition === 'contact') view.props.isFingerDetected = false;
    else view.props.isMonitoring = false;
    drawEstimatedEcg(recorder.ctx, view, recording(), prediction());
    expect(recorder.strokes).toEqual([]);
    expect(recorder.dots).toEqual([]);
  });

  it('corta huecos, valores inválidos y cambios de reloj en vez de unirlos con una onda', () => {
    const recorder = contextRecorder();
    drawEstimatedEcg(recorder.ctx, state(), recording([
      [100, 0], [150, 1], [600, -.4], [650, .2], [700, NaN], [750, .1], [800, -.1], [780, 0], [830, .2],
    ]), prediction());
    const signals = recorder.strokes.filter(stroke => stroke.color === SIGNAL_COLOR);
    expect(signals).toHaveLength(4);
    expect(signals.map(stroke => stroke.points.length)).toEqual([2, 2, 2, 2]);
  });

  it('no transforma una predicción cero en amplitud ni presenta sus unidades como voltaje', () => {
    const recorder = contextRecorder();
    drawEstimatedEcg(recorder.ctx, state(), recording([[100, 0], [150, 0], [200, 0]]), prediction());
    const points = recorder.strokes.find(stroke => stroke.color === SIGNAL_COLOR)!.points;
    expect(new Set(points.map(point => point.y)).size).toBe(1);
    expect(recorder.labels.some(label => label.text === '±0 u.r.')).toBe(true);
    expect(recorder.labels.some(label => /mV|volt/.test(label.text))).toBe(false);
  });

  it('usa el reloj y buffer congelados de inspección aunque la captura actual pierda contacto', () => {
    const recorder = contextRecorder();
    const view = state();
    view.now = 10000;
    view.props.isFingerDetected = false;
    view.inspection = { endMs: 2000 } as PpgRenderState['inspection'];
    drawEstimatedEcg(recorder.ctx, view, recording(), prediction('INSUFFICIENT'));
    expect(recorder.strokes.some(stroke => stroke.color === SIGNAL_COLOR)).toBe(true);
  });

  it('traduce las causas de falta de salida sin exponer códigos internos', () => {
    const recorder = contextRecorder();
    drawEstimatedEcg(recorder.ctx, state(), null, prediction('INSUFFICIENT', 'CAPTURE_GAP'));
    expect(recorder.labels.some(label => label.text === 'Recuperando continuidad de captura')).toBe(true);
    expect(recorder.labels.some(label => label.text === 'CAPTURE_GAP')).toBe(false);
  });
});
