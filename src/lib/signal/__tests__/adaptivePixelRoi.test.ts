import { describe, expect, it } from 'vitest';
import {
  AdaptivePixelRoi,
  displacementPenaltyFrom,
  maskTemporalCorrelation,
  opticalDensity,
  perfusionIndexFromOpticalDensity,
} from '../adaptivePixelRoi';

const ImageDataCtor: typeof ImageData =
  (globalThis as unknown as { ImageData?: typeof ImageData }).ImageData ??
  (class {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(data: Uint8ClampedArray, w: number, h: number) {
      this.data = data;
      this.width = w;
      this.height = h;
    }
  } as unknown as typeof ImageData);
(globalThis as unknown as { ImageData: typeof ImageData }).ImageData =
  ImageDataCtor;

function makeFrame(
  w: number,
  h: number,
  colorAt: (x: number, y: number) => [number, number, number],
): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colorAt(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return new ImageDataCtor(data, w, h);
}

describe('Beer-Lambert diferencial — utilidades', () => {
  it('la densidad óptica es monótona y finita', () => {
    expect(opticalDensity(255)).toBeCloseTo(0, 6);
    expect(opticalDensity(0)).toBeCloseTo(Math.log(256), 6);
    expect(opticalDensity(128)).toBeGreaterThan(opticalDensity(200));
  });

  it('convierte varianza de OD en AC/DC fisiológico', () => {
    expect(perfusionIndexFromOpticalDensity(1, 0)).toBe(0);
    const ac = perfusionIndexFromOpticalDensity(1, 0.5 * 0.02 * 0.02);
    expect(ac).toBeCloseTo(0.02, 5);
  });

  it('calcula Jaccard temporal entre máscaras', () => {
    const a = new Uint8Array([1, 1, 1, 0, 0, 0]);
    const b = new Uint8Array([1, 1, 0, 0, 0, 0]);
    const c = new Uint8Array([0, 0, 0, 1, 1, 1]);
    expect(maskTemporalCorrelation(a, a)).toBe(1);
    expect(maskTemporalCorrelation(a, b)).toBeCloseTo(2 / 3, 6);
    expect(maskTemporalCorrelation(a, c)).toBe(0);
  });

  it('penaliza más cuando cae la correlación y crece el desplazamiento', () => {
    expect(displacementPenaltyFrom(1, 0, 100)).toBe(0);
    const soft = displacementPenaltyFrom(0.8, 2, 100);
    const hard = displacementPenaltyFrom(0.1, 20, 100);
    expect(hard).toBeGreaterThan(soft);
    expect(hard).toBeLessThanOrEqual(1);
  });
});

describe('AdaptivePixelRoi — máscara por píxel', () => {
  it('excluye saturación y subexposición y conserva solo la zona válida', () => {
    const roi = new AdaptivePixelRoi();
    const frame = makeFrame(150, 150, (x) => {
      if (x < 50) return [255, 255, 255];
      if (x < 100) return [180, 96, 80];
      return [5, 4, 3];
    });

    let last = roi.processFrame(frame, 3);
    for (let i = 0; i < 14; i++) last = roi.processFrame(frame, 3);

    expect(last.excludedSaturated).toBeGreaterThan(0);
    expect(last.excludedUnderexposed).toBeGreaterThan(0);
    expect(last.rawRed).toBeGreaterThan(177);
    expect(last.rawRed).toBeLessThan(183);
    expect(last.coverageRatio).toBeGreaterThan(0.2);
    expect(last.coverageRatio).toBeLessThan(0.45);
  });

  it('aplica el filtro fisiológico AC/DC 0.1%–3% y descarta píxeles estáticos', () => {
    const roi = new AdaptivePixelRoi();
    const w = 180;
    const frameAt = (t: number) =>
      makeFrame(w, w, (x) => {
        if (x < w / 2) return [180, 96, 80];
        const g = Math.round(96 + 2 * Math.sin(2 * Math.PI * 1.2 * (t / 30)));
        return [180, g, 80];
      });

    let last = roi.processFrame(frameAt(0), 3);
    for (let t = 1; t < 60; t++) last = roi.processFrame(frameAt(t), 3);

    expect(last.physiologicalPixels).toBeGreaterThan(0);
    expect(last.physiologicalPixels / last.sampledPixels).toBeGreaterThan(0.25);
    expect(last.physiologicalPixels / last.sampledPixels).toBeLessThan(0.75);
    expect(last.excludedNonPhysiological).toBeGreaterThan(0);
  });

  it('rechaza modulación AC/DC fuera del rango superior y usa fallback de exposición', () => {
    const roi = new AdaptivePixelRoi();
    const frameAt = (t: number) =>
      makeFrame(150, 150, () => {
        const g = Math.round(96 + 8 * Math.sin(2 * Math.PI * 1.2 * (t / 30)));
        return [180, g, 80];
      });

    let last = roi.processFrame(frameAt(0), 3);
    for (let t = 1; t < 60; t++) last = roi.processFrame(frameAt(t), 3);

    expect(last.physiologicalPixels).toBe(0);
    expect(last.excludedNonPhysiological).toBeGreaterThan(0);
    expect(last.rawRed).toBeGreaterThan(170);
    expect(last.rawRed).toBeLessThan(190);
  });

  it('pondera la agregación hacia la región con pulsatilidad real', () => {
    const roi = new AdaptivePixelRoi();
    const w = 180;
    const frameAt = (t: number) =>
      makeFrame(w, w, (x) => {
        if (x < w / 2) return [140, 96, 80];
        const g = Math.round(96 + 2 * Math.sin(2 * Math.PI * 1.2 * (t / 30)));
        return [200, g, 80];
      });

    let last = roi.processFrame(frameAt(0), 3);
    for (let t = 1; t < 60; t++) last = roi.processFrame(frameAt(t), 3);

    expect(last.rawRed).toBeGreaterThan(180);
    expect(last.rawGreen).toBeGreaterThan(90);
    expect(last.rawGreen).toBeLessThan(102);
  });

  it('detecta desplazamiento del dedo por correlación temporal de máscaras', () => {
    const roi = new AdaptivePixelRoi();
    const w = 180;
    const frameWithRect = (x0: number) =>
      makeFrame(w, w, (x, y) => {
        const inside = x >= x0 && x < x0 + 50 && y >= 55 && y < 125;
        return inside ? [200, 100, 80] : [15, 10, 5];
      });

    let before = roi.processFrame(frameWithRect(20), 3);
    for (let i = 0; i < 12; i++) {
      before = roi.processFrame(frameWithRect(20), 3);
    }
    const after = roi.processFrame(frameWithRect(110), 3);

    expect(after.centroidX).toBeGreaterThan(before.centroidX + 0.25);
    expect(after.roiX).toBeGreaterThan(before.roiX);
    expect(after.maskCorrelation).toBeLessThan(0.2);
    expect(after.displacementPenalty).toBeGreaterThan(0.2);
    expect(after.centroidMotion).toBeGreaterThan(0.2);
  });

  it('no produce NaN en frames oscuros y reinicia su estado', () => {
    const roi = new AdaptivePixelRoi();
    const dark = makeFrame(120, 120, () => [5, 4, 3]);
    let last = roi.processFrame(dark, 3);
    for (let i = 0; i < 5; i++) last = roi.processFrame(dark, 3);

    expect(Number.isFinite(last.rawRed)).toBe(true);
    expect(Number.isFinite(last.rawGreen)).toBe(true);
    expect(Number.isFinite(last.rawBlue)).toBe(true);
    expect(Number.isFinite(last.displacementPenalty)).toBe(true);
    expect(last.rawRed).toBe(0);
    expect(last.effectivePixels).toBe(0);

    roi.reset();
    const light = roi.processFrame(makeFrame(120, 120, () => [180, 96, 80]), 3);
    expect(light.rawRed).toBeGreaterThan(170);
    expect(light.displacementPenalty).toBe(0);
  });

  describe('sellado óptico por tejido (robustez numérica)', () => {
    it('tissueRatio y perfusionRatio son finitos y están en [0,1] en todo frame', () => {
      // El sellado se calcula con contadores LOCALES que se reinician en cada
      // frame: no puede acumularse entre frames ni dividir por cero (hay guarda
      // explícita de `sampled > 0` y `tissuePixels > 0`).
      const roi = new AdaptivePixelRoi();
      const scenes: Array<(x: number, y: number) => [number, number, number]> = [
        () => [180, 96, 80],   // tejido pleno
        () => [255, 255, 255], // saturado
        () => [5, 4, 3],       // oscuridad total
        () => [128, 128, 128], // pared neutra (sin dominancia roja)
      ];

      for (const scene of scenes) {
        const frame = makeFrame(150, 150, scene);
        for (let i = 0; i < 40; i++) {
          const out = roi.processFrame(frame, 3);
          expect(Number.isFinite(out.tissueRatio)).toBe(true);
          expect(Number.isFinite(out.perfusionRatio)).toBe(true);
          expect(Number.isFinite(out.tissueRed)).toBe(true);
          expect(out.tissueRatio).toBeGreaterThanOrEqual(0);
          expect(out.tissueRatio).toBeLessThanOrEqual(1);
          expect(out.perfusionRatio).toBeGreaterThanOrEqual(0);
          expect(out.perfusionRatio).toBeLessThanOrEqual(1);
        }
      }
    });

    it('separa sellado de pulso: la pared neutra no cuenta como tejido', () => {
      const roi = new AdaptivePixelRoi();
      const wall = makeFrame(150, 150, () => [128, 128, 128]);
      let wallOut = roi.processFrame(wall, 3);
      for (let i = 0; i < 20; i++) wallOut = roi.processFrame(wall, 3);
      // Sin dominancia roja no hay tejido: el sellado es 0 aunque la escena esté
      // perfectamente expuesta. Antes "cobertura" se confundía con exposición.
      expect(wallOut.tissueRatio).toBe(0);

      const finger = makeFrame(150, 150, () => [200, 90, 70]);
      let fingerOut = roi.processFrame(finger, 3);
      for (let i = 0; i < 20; i++) fingerOut = roi.processFrame(finger, 3);
      expect(fingerOut.tissueRatio).toBeGreaterThan(0.9);
    });
  });
});
