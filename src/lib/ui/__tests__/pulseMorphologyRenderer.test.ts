import { describe, expect, it } from 'vitest';
import { CircularBuffer } from '@/utils/CircularBuffer';
import { drawPulseMorphology } from '../pulseMorphologyRenderer';
import type { PpgRenderState } from '../ppgCanvasRenderer';

function contextRecorder() {
  const labels: Array<{ text: string; font: string; x: number; y: number; align: string }> = [];
  const strokes: Array<{ color: string; lineCount: number }> = [];
  const rectangles: Array<{ color: string; width: number; height: number }> = [];
  let lineCount = 0;
  const fields: Record<string, unknown> = { font: '', strokeStyle: '', fillStyle: '', textAlign: '' };
  const methods: Record<string, (...args: never[]) => unknown> = {
    beginPath: () => { lineCount = 0; },
    lineTo: () => { lineCount++; },
    stroke: () => { strokes.push({ color: String(fields.strokeStyle), lineCount }); },
    fillText: (text: string, x: number, y: number) => {
      labels.push({ text, x, y, font: String(fields.font), align: String(fields.textAlign) });
    },
    fillRect: (_x: number, _y: number, width: number, height: number) => {
      rectangles.push({ color: String(fields.fillStyle), width, height });
    },
    measureText: (text: string) => ({ width: text.length * (parseFloat(String(fields.font).match(/\d+(?:\.\d+)?(?=px)/)?.[0] ?? '10')) * .6 }),
  };
  const ctx = new Proxy(fields, {
    get: (target, key: string) => methods[key] ?? target[key] ?? (() => undefined),
    set: (target, key: string, value) => { target[key] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, labels, strokes, rectangles };
}

function stateWithContact(contact: boolean, sourceValid = true, width = 296): PpgRenderState {
  const buffer = new CircularBuffer(30);
  for (const time of [0, 50, 100, 150, 200, 250]) {
    buffer.push({ time, value: time * time, sourceValue: sourceValid ? time / 1000 : NaN, isArrhythmia: false });
  }
  return {
    layout: { plot: { x: 12, y: 100, w: width, h: 84, centerY: 142 } },
    props: { isMonitoring: true, isFingerDetected: contact, contactState: contact ? 'STABLE_CONTACT' : 'NO_CONTACT' },
    now: 250, windowMs: 1000, buffer,
  } as unknown as PpgRenderState;
}

describe('canales diferenciales del monitor', () => {
  const signalColors = new Set(['#79dce9', '#b4a6f4']);

  it('retira trazos y escalas de señal cuando se pierde contacto aunque queden muestras', () => {
    const recorder = contextRecorder();
    drawPulseMorphology(recorder.ctx, stateWithContact(false));
    expect(recorder.labels.some(label => label.text === 'Esperando señal del dedo')).toBe(true);
    expect(recorder.labels.filter(label => label.text.startsWith('±'))).toEqual([]);
    expect(recorder.strokes.filter(stroke => signalColors.has(stroke.color))).toEqual([]);
    expect(recorder.rectangles.filter(rectangle => signalColors.has(rectangle.color))).toEqual([]);
  });

  it('un canal original inválido no se reemplaza por el display para pintar una derivada', () => {
    const recorder = contextRecorder();
    drawPulseMorphology(recorder.ctx, stateWithContact(true, false));
    expect(recorder.labels.some(label => label.text === 'Esperando muestras continuas')).toBe(true);
    expect(recorder.strokes.filter(stroke => signalColors.has(stroke.color))).toEqual([]);
    expect(recorder.labels.filter(label => label.text.startsWith('±'))).toEqual([]);
  });

  it('representa la fuente lineal con escalas de 1 u.r./s y 0 u.r./s² sin reducir el texto móvil por debajo de 10 px', () => {
    const recorder = contextRecorder();
    drawPulseMorphology(recorder.ctx, stateWithContact(true));
    expect(recorder.labels.some(label => label.text === '±1.0 u.r./s')).toBe(true);
    expect(recorder.labels.some(label => label.text === '±0 u.r./s²')).toBe(true);
    expect(recorder.strokes.filter(stroke => signalColors.has(stroke.color) && stroke.lineCount > 0)).toHaveLength(2);
    for (const label of recorder.labels) expect(Number(label.font.match(/(\d+)px/)?.[1])).toBeGreaterThanOrEqual(10);
  });

  it('mantiene título y escala separados en una banda estrecha sin achicar la tipografía', () => {
    const recorder = contextRecorder();
    drawPulseMorphology(recorder.ctx, stateWithContact(true, true, 180));
    const title = recorder.labels.find(label => label.text === 'APG · d²PPG/dt²')!;
    const scale = recorder.labels.find(label => label.text === '±0 u.r./s²')!;
    expect(scale.y).toBeGreaterThan(title.y);
    expect(scale.align).toBe('right');
  });
});
