import { describe, it, expect } from 'vitest';
import { computeFloorPreviewGeometry, computeCapturePreviewLayout, mapCapturePreviewRoi, drawPreviewWell3D } from '../ppg3dProjection';
import type { PpgRenderState } from '../ppgCanvasRenderer';

// Geometría real de un móvil de 390×844 (misma que `recomputeLayout`).
const PLOT = { x: 12, y: 132, w: 366, h: 542, centerY: 403 };

function makeState(): PpgRenderState {
  return {
    layout: {
      width: 390,
      height: 844,
      header: { x: 0, y: 0, w: 390, h: 36 },
      metrics: { x: 0, y: 36, w: 390, h: 93 },
      plot: PLOT,
      trend: { x: 12, y: 677, w: 366, h: 80 },
      footer: { x: 0, y: 754, w: 390, h: 42 },
    },
    threeD: { enabled: true, intensity: 1 },
  } as unknown as PpgRenderState;
}

const quadWidthNear = (q: ReturnType<typeof computeFloorPreviewGeometry>['quad']) =>
  q.nearRight.x - q.nearLeft.x;
const quadWidthFar = (q: ReturnType<typeof computeFloorPreviewGeometry>['quad']) =>
  q.farRight.x - q.farLeft.x;

describe('computeFloorPreviewGeometry — ventana acostada sobre la grilla', () => {
  it('ancla el borde lejano y abre la ventana hacia el observador', () => {
    const closed = computeFloorPreviewGeometry(makeState(), 0);
    const open = computeFloorPreviewGeometry(makeState(), 1);

    // El borde lejano no se mueve: la ventana queda sujeta a la misma fila.
    expect(open.farY).toBeCloseTo(closed.farY, 6);
    // El borde cercano baja (se acerca al observador) al abrirse.
    expect(open.nearY).toBeGreaterThan(closed.nearY);
    // La profundidad visible crece con la colocación.
    expect(open.nearY - open.farY).toBeGreaterThan(closed.nearY - closed.farY);
    // Y también el ancho: la ventana se despliega sobre el piso.
    expect(quadWidthNear(open.quad)).toBeGreaterThan(quadWidthNear(closed.quad));
    expect(quadWidthFar(open.quad)).toBeGreaterThan(quadWidthFar(closed.quad));
  });

  it('proyecta un trapecio keystone: el borde cercano es más ancho', () => {
    const geo = computeFloorPreviewGeometry(makeState(), 1);
    const nearW = quadWidthNear(geo.quad);
    const farW = quadWidthFar(geo.quad);

    expect(nearW).toBeGreaterThan(farW);
    // Lados convergentes hacia el punto de fuga (misma x de fuga).
    expect(geo.quad.nearLeft.x).toBeLessThan(geo.quad.farLeft.x);
    expect(geo.quad.nearRight.x).toBeGreaterThan(geo.quad.farRight.x);
    expect((geo.quad.nearLeft.x + geo.quad.nearRight.x) / 2).toBeCloseTo(geo.proj.vpX, 6);
    expect((geo.quad.farLeft.x + geo.quad.farRight.x) / 2).toBeCloseTo(geo.proj.vpX, 6);
  });

  it('mantiene las cuatro esquinas dentro del monitor en toda la apertura', () => {
    for (const size of [0, 0.25, 0.5, 0.75, 1]) {
      const { quad } = computeFloorPreviewGeometry(makeState(), size);
      for (const p of [quad.nearLeft, quad.nearRight, quad.farLeft, quad.farRight]) {
        expect(p.x).toBeGreaterThanOrEqual(PLOT.x);
        expect(p.x).toBeLessThanOrEqual(PLOT.x + PLOT.w);
        expect(p.y).toBeGreaterThanOrEqual(PLOT.y);
        expect(p.y).toBeLessThanOrEqual(PLOT.y + PLOT.h);
      }
    }
  });

  it('muestrea el video de forma monótona: arriba→lejos, abajo→cerca', () => {
    const geo = computeFloorPreviewGeometry(makeState(), 1);
    const vFar = geo.sourceVAt(geo.farY + 0.001);
    const vMid = geo.sourceVAt((geo.farY + geo.nearY) / 2);
    const vNear = geo.sourceVAt(geo.nearY - 0.001);

    expect(vFar).toBeLessThan(0.02);       // fila superior del recorte = borde lejano
    expect(vNear).toBeGreaterThan(0.98);   // fila inferior = borde cercano
    expect(vMid).toBeGreaterThan(vFar);
    expect(vMid).toBeLessThan(vNear);
    // Profundidad creciente: el borde lejano está más lejos que el cercano.
    expect(geo.quad.zn).toBeLessThan(geo.quad.zf);
  });

  it('deja la ventana abierta detrás de la cinta de la onda', () => {
    const geo = computeFloorPreviewGeometry(makeState(), 1);
    // La cinta ocupa d∈[0.05..0.17]; su borde trasero es la referencia inferior.
    const waveBackY = geo.proj.horizonY + geo.proj.floorSpanY * geo.proj.scaleAt(0.17);
    expect(geo.nearY).toBeLessThan(waveBackY);
  });
});

describe('visor de captura frontal', () => {
  it('mantiene el visor legible dentro del plot en móvil, escritorio y horizontal', () => {
    for (const [width, height, plotH] of [[390, 844, 440], [1440, 900, 580], [844, 390, 155]]) {
      const state = makeState();
      state.layout.width = width;
      state.layout.height = height;
      state.layout.plot = { x: 12, y: 80, w: width - 24, h: plotH, centerY: 80 + plotH / 2 };
      const { card, video, text } = computeCapturePreviewLayout(state);
      const plot = state.layout.plot;
      expect(card.x).toBeGreaterThanOrEqual(plot.x);
      expect(card.y).toBeGreaterThanOrEqual(plot.y);
      expect(card.x + card.w).toBeLessThanOrEqual(plot.x + plot.w);
      expect(card.y + card.h).toBeLessThanOrEqual(plot.y + plot.h);
      expect(video.x + video.w).toBeLessThan(text.x);
      expect(text.w).toBeGreaterThan(80);
    }
  });

  it('superpone las coordenadas observadas al encuadre completo y acota el ROI', () => {
    const video = { x: 100, y: 200, w: 80, h: 60 };
    expect(mapCapturePreviewRoi({ x: 80, y: 60, width: 160, height: 120 }, { width: 320, height: 240 }, video))
      .toEqual({ x: 120, y: 215, w: 40, h: 30 });
    expect(mapCapturePreviewRoi({ x: -20, y: -30, width: 400, height: 300 }, { width: 320, height: 240 }, video))
      .toEqual(video);
    expect(mapCapturePreviewRoi(undefined, { width: 320, height: 240 }, video)).toBeNull();
    expect(mapCapturePreviewRoi({ x: 0, y: 0, width: 20, height: 20 }, { width: 0, height: 240 }, video)).toBeNull();
    expect(mapCapturePreviewRoi({ x: NaN, y: 0, width: 20, height: 20 }, { width: 320, height: 240 }, video)).toBeNull();
    expect(mapCapturePreviewRoi({ x: 400, y: 0, width: 20, height: 20 }, { width: 320, height: 240 }, video)).toBeNull();
  });

  it('retira imagen y valores previos al detener la captura, aunque el vídeo conserve su último frame', () => {
    const state = makeState();
    state.props = { isMonitoring: false, diagnostics: { sqm: { fpsEffective: 30, saturationRatio: 0, underexposureRatio: 0 } } } as PpgRenderState['props'];
    const texts: string[] = [];
    let drawnVideo = 0;
    const ctx = new Proxy({
      measureText: (value: string) => ({ width: value.length * 5 }),
      createLinearGradient: () => ({ addColorStop: () => undefined }),
      fillText: (value: string) => texts.push(value),
      drawImage: () => { drawnVideo++; },
    }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined }) as unknown as CanvasRenderingContext2D;
    const source = { readyState: 4, videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;
    drawPreviewWell3D(ctx, state, source);
    expect(drawnVideo).toBe(0);
    expect(texts).toContain('Sin imagen');
    expect(texts).toContain('— fps');
    expect(texts.filter(value => value === '—')).toHaveLength(4);
    expect(texts).not.toContain('100%');
  });
});
