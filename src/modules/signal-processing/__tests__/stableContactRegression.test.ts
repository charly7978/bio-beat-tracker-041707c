import { describe, it, expect, beforeEach } from 'vitest';
import { PPGSignalProcessor } from '../PPGSignalProcessor';
import type { ProcessedSignal } from '../../../types/signal';

// Polyfill ImageData if not in jsdom env
const ImageDataCtor: typeof ImageData =
  (globalThis as any).ImageData ??
  (class {
    data: Uint8ClampedArray; width: number; height: number;
    constructor(data: Uint8ClampedArray, w: number, h: number) {
      this.data = data; this.width = w; this.height = h;
    }
  } as any);
(globalThis as any).ImageData = ImageDataCtor;

function makeFrame(w: number, h: number, r: number, g: number, b: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4 + 0] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return new ImageDataCtor(data, w, h);
}

/**
 * REGRESIÓN ANTI FALSO-POSITIVO "posición perfecta":
 * antes, un escena roja SIN pulso real alcanzaba STABLE_CONTACT porque
 * QUALITY.MIN_PI*0.75 (0.000675) era superado por el ruido del AE con flash.
 * Ahora reconcileStableContact exige PI >= STABLE_MIN_PI (0.0020) y evidencia
 * de pulso (hemoglobina+CV o periodicidad), y degrada tras ~1 s sin pulso.
 */
describe('STABLE_CONTACT no se alcanza sin pulso real (anti falso-positivo)', () => {
  let proc: PPGSignalProcessor;
  let signals: ProcessedSignal[] = [];
  let frameTimestampMs = 1_000;

  // Capture time follows the fixture's 30 fps, independently of CPU loop speed.
  const processFrameAt30Fps = (frame: ImageData): void => {
    proc.processFrame(frame, frameTimestampMs);
    frameTimestampMs += 1_000 / 30;
  };

  beforeEach(() => {
    signals = [];
    frameTimestampMs = 1_000;
    proc = new PPGSignalProcessor((s) => signals.push(s));
    proc.start();
  });

  it('escena roja CONSTANTE (flash sin pulso) nunca llega a STABLE_CONTACT', () => {
    for (let i = 0; i < 300; i++) {
      processFrameAt30Fps(makeFrame(64, 64, 200, 80, 60));
    }
    const states = signals.map(s => s.contactState);
    expect(states).not.toContain('STABLE_CONTACT');
  });

  it('escena roja con DERIVA lenta (dedo medio apoyado, sin flujo) nunca llega a STABLE', () => {
    // Deriva DC lenta: el PI instantáneo por frame es ~0 — no hay pulso.
    for (let i = 0; i < 300; i++) {
      const r = 180 + Math.round(4 * (i / 300));
      processFrameAt30Fps(makeFrame(64, 64, r, 80, 60));
    }
    const states = signals.map(s => s.contactState);
    expect(states).not.toContain('STABLE_CONTACT');
  });

  it('señal pulsátil REAL (0.7-3.5 Hz, todos los canales) SÍ alcanza STABLE_CONTACT', () => {
    // Tejido real pulsa en TODOS los canales (el PI se computa de greenAC/greenDC).
    // 1.2 Hz, AC≈4-8% del DC por canal — típico de un dedo bien perfundido.
    for (let i = 0; i < 300; i++) {
      const s = Math.sin(2 * Math.PI * 1.2 * (i / 30));
      processFrameAt30Fps(makeFrame(64, 64,
        Math.round(180 + 8 * s),
        Math.round(95 + 5 * s),
        Math.round(75 + 4 * s)));
    }
    const states = signals.map(s => s.contactState);
    expect(states).toContain('STABLE_CONTACT');
  });
});

