import { describe, expect, it } from 'vitest';
import {
  MAX_CAPTURE_TO_CALLBACK_MS,
  MAX_CAPTURE_TO_PRESENTATION_MS,
  resolveFrameClock,
} from '../frameClock';

describe('resolveFrameClock — reloj de captura por hardware', () => {
  it('prefiere captureTime cuando es coherente con presentationTime', () => {
    const r = resolveFrameClock(
      { captureTime: 1000.4, presentationTime: 1001.2, mediaTime: 3.5 },
      1002,
      1002.5,
    );
    expect(r.source).toBe('capture');
    expect(r.timestamp).toBe(1000.4);
  });

  it('acepta captureTime sin presentationTime si cae dentro de la ventana del callback', () => {
    const r = resolveFrameClock(
      { captureTime: 5000, mediaTime: 0 },
      5000 + MAX_CAPTURE_TO_CALLBACK_MS - 1,
      5000 + MAX_CAPTURE_TO_CALLBACK_MS,
    );
    expect(r.source).toBe('capture');
    expect(r.timestamp).toBe(5000);
  });

  it('descarta captureTime de otra época y usa presentationTime', () => {
    const r = resolveFrameClock(
      { captureTime: 987654321, presentationTime: 1200.5, mediaTime: 2 },
      1201,
      1201.5,
    );
    expect(r.source).toBe('presentation');
    expect(r.timestamp).toBe(1200.5);
  });

  it('descarta captureTime con skew excesivo a composición', () => {
    const r = resolveFrameClock(
      { captureTime: 1000, presentationTime: 1000 + MAX_CAPTURE_TO_PRESENTATION_MS + 1 },
      1500,
      1500,
    );
    expect(r.source).toBe('presentation');
  });

  it('cae a presentationTime cuando captureTime falta', () => {
    const r = resolveFrameClock({ presentationTime: 2000.25 }, 2001, 2001.5);
    expect(r.source).toBe('presentation');
    expect(r.timestamp).toBe(2000.25);
  });

  it('cae al instante del callback cuando no hay metadatos útiles', () => {
    const r = resolveFrameClock({ mediaTime: 12 }, 3000, 3000.5);
    expect(r.source).toBe('callback');
    expect(r.timestamp).toBe(3000);
  });

  it('cae a performance.now() como último recurso', () => {
    const r = resolveFrameClock(undefined, undefined, 4000);
    expect(r.source).toBe('perf');
    expect(r.timestamp).toBe(4000);
  });

  it('ignora marcas no finitas, cero o negativas', () => {
    const r = resolveFrameClock(
      { captureTime: Number.NaN, presentationTime: 0 },
      -1,
      5000,
    );
    expect(r.source).toBe('perf');
    expect(r.timestamp).toBe(5000);
  });
});
