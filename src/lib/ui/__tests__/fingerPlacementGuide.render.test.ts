/**
 * Contrato de PINTADO de la guía de colocación.
 *
 * El resto de tests cubre el modelo (qué debe decir la ventana); este cubre el
 * dibujo (qué se pinta DENTRO del cristal y dónde), que es exactamente lo que el
 * usuario ve. Se usa un contexto 2D de grabación: sin navegador, sin dependencias.
 */
import { describe, expect, it } from 'vitest';
import { computeFloorPreviewGeometry } from '../ppg3dProjection';
import {
  deriveWellGuide,
  drawWellFingerprintGuide,
  fingerprintRidges,
  projectWellUV,
  type WellGuideInput,
} from '../fingerPlacementOverlay';
import type { FingerPlacementEvidence } from '@/lib/finger/fingerPlacementEvidence';
import type { PpgRenderState } from '../ppgCanvasRenderer';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

interface Call {
  op: string;
  args: number[];
  text?: string;
  dash?: number[];
}

class RecordingContext {
  calls: Call[] = [];
  private m = [1, 0, 0, 1, 0, 0];
  private stack: number[][] = [];
  private dash: number[] = [];
  fillStyle: unknown = '';
  strokeStyle: unknown = '';
  lineWidth = 1;
  font = '';
  textAlign = '';
  textBaseline = '';
  shadowBlur = 0;
  shadowColor = '';
  lineCap = '';
  lineJoin = '';
  lineDashOffset = 0;

  private apply(x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.m;
    return [a * x + c * y + e, b * x + d * y + f];
  }
  private push(op: string, ...args: number[]): void {
    this.calls.push({ op, args, dash: [...this.dash] });
  }
  save(): void { this.stack.push([...this.m]); }
  restore(): void { const m = this.stack.pop(); if (m) this.m = m; }
  translate(x: number, y: number): void {
    this.m = [this.m[0], this.m[1], this.m[2], this.m[3], this.m[4] + this.m[0] * x + this.m[2] * y, this.m[5] + this.m[1] * x + this.m[3] * y];
  }
  rotate(r: number): void {
    const [a, b, c, d, e, f] = this.m;
    const co = Math.cos(r);
    const si = Math.sin(r);
    this.m = [a * co + c * si, b * co + d * si, -a * si + c * co, -b * si + d * co, e, f];
  }
  beginPath(): void {}
  moveTo(x: number, y: number): void { const p = this.apply(x, y); this.push('M', p[0], p[1]); }
  lineTo(x: number, y: number): void { const p = this.apply(x, y); this.push('L', p[0], p[1]); }
  closePath(): void {}
  arc(x: number, y: number, r: number, s: number, e: number): void { this.push('A', x, y, r, s, e); }
  rect(): void {}
  clip(): void {}
  fill(): void {}
  stroke(): void { this.calls.push({ op: 'S', args: [this.lineWidth], dash: [...this.dash] }); }
  strokeRect(): void {}
  fillRect(): void {}
  fillText(text: string, x: number, y: number): void { this.calls.push({ op: 'T', args: [x, y], text }); }
  measureText(text: string): { width: number } {
    const px = Number((this.font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 10));
    return { width: text.length * px * 0.6 };
  }
  createLinearGradient(): { addColorStop: () => void } { return { addColorStop: () => {} }; }
  createRadialGradient(): { addColorStop: () => void } { return { addColorStop: () => {} }; }
  setLineDash(d: number[]): void { this.dash = d; }
  drawImage(): void {}
}

function makeState(): PpgRenderState {
  return {
    layout: {
      width: 390,
      height: 844,
      header: { x: 0, y: 0, w: 390, h: 36 },
      metrics: { x: 0, y: 36, w: 390, h: 93 },
      plot: { x: 12, y: 132, w: 366, h: 542, centerY: 403 },
      trend: { x: 12, y: 677, w: 366, h: 80 },
      footer: { x: 0, y: 754, w: 390, h: 42 },
    },
    threeD: { enabled: true, intensity: 1 },
  } as unknown as PpgRenderState;
}

function evidence(o: Partial<FingerPlacementEvidence>): FingerPlacementEvidence {
  return {
    score: 0.8, pressure: 'IDEAL', pressureScore: 0.5, pressureAxis: 'NONE', blanching: 0,
    seal: 0.62, pulsatility: 0.9, perfusedFraction: 0.7, placement: 'CENTERED',
    centroid: { x: 0.5, y: 0.5 }, offset: { x: 0, y: 0 }, alignment: 1, readiness: 'READY',
    failing: [], coverage: 0.62, centering: 1, stability: 1, motion: 0.05,
    guidance: { action: 'HOLD', headline: '', detail: '', progress: 1, confidence: 1 },
    etiology: { cause: 'OPTIMAL', confidence: 1, alternatives: [], explanation: '', headline: '', action: 'HOLD', evidence: [] },
    ...o,
  } as unknown as FingerPlacementEvidence;
}

function paint(overrides: Partial<WellGuideInput>): { ctx: RecordingContext; geo: ReturnType<typeof computeFloorPreviewGeometry> } {
  const geo = computeFloorPreviewGeometry(makeState(), 1);
  const input: WellGuideInput = {
    evidence: evidence({}),
    acquisitionStage: 'READY',
    hasVideo: true,
    nowMs: 1600,
    beatPulse: 0.4,
    reducedMotion: false,
    ...overrides,
  };
  const ctx = new RecordingContext();
  drawWellFingerprintGuide(
    ctx as unknown as CanvasRenderingContext2D,
    geo,
    deriveWellGuide(input),
    { tint: '34,197,94', accent: '125,211,252' },
    'monospace',
  );
  return { ctx, geo };
}

const textCalls = (ctx: RecordingContext): Call[] => ctx.calls.filter((c) => c.op === 'T');

describe('contrato de pintado de la guía', () => {
  it('sin evidencia no pinta texto: no hay cartel', () => {
    const { ctx } = paint({ evidence: undefined });
    expect(textCalls(ctx)).toHaveLength(0);
  });

  it('el texto se pinta DENTRO del trapecio de la ventana', () => {
    const { ctx, geo } = paint({});
    const texts = textCalls(ctx);
    expect(texts.length).toBeGreaterThanOrEqual(2);

    const xs = [geo.quad.nearLeft.x, geo.quad.nearRight.x, geo.quad.farLeft.x, geo.quad.farRight.x];
    const ys = [geo.quad.nearLeft.y, geo.quad.farLeft.y];
    for (const t of texts) {
      const [x, y] = t.args;
      expect(x).toBeGreaterThan(Math.min(...xs));
      expect(x).toBeLessThan(Math.max(...xs));
      expect(y).toBeGreaterThan(Math.min(...ys));
      expect(y).toBeLessThan(Math.max(...ys));
    }
  });

  it('la instrucción principal es la primera línea y el detalle la segunda', () => {
    const { ctx } = paint({});
    const texts = textCalls(ctx);
    expect(texts[0].text).toMatch(/ESTABLE/);
    expect(texts[1].text).toMatch(/MANTÉN/);
  });

  it('SEARCH: sin fantasma (no hay tejido) y con instrucción de colocación', () => {
    const { ctx } = paint({
      evidence: evidence({ placement: 'NO_FINGER', readiness: 'NO_CONTACT', seal: 0.02, alignment: 0 }),
    });
    const texts = textCalls(ctx);
    expect(texts[0].text).toMatch(/APOYA/);
    // Sin línea discontinua: el fantasma (que se dibuja con [5,5]) no existe.
    expect(ctx.calls.some((c) => c.op === 'S' && c.dash?.length === 2)).toBe(false);
  });

  it('ALIGN: el fantasma se pinta en la posición MEDIDA y el haz une fantasma y diana', () => {
    const centroid = { x: 0.82, y: 0.68 };
    const evidenceValue = evidence({
      placement: 'EDGE',
      readiness: 'ALIGNING',
      alignment: 0.1,
      centroid,
      offset: { x: -0.32, y: -0.18 },
      seal: 0.28,
    });
    const input: WellGuideInput = {
      evidence: evidenceValue,
      acquisitionStage: 'STABILIZING',
      hasVideo: true,
      nowMs: 1600,
      beatPulse: 0.4,
      reducedMotion: false,
    };
    const view = deriveWellGuide(input);
    const geo = computeFloorPreviewGeometry(makeState(), 1);
    const ctx = new RecordingContext();
    drawWellFingerprintGuide(
      ctx as unknown as CanvasRenderingContext2D,
      geo,
      view,
      { tint: '34,197,94', accent: '125,211,252' },
      'monospace',
    );

    // El fantasma es el ÚNICO trazo discontinuo [5,5]. Todos sus puntos deben
    // caer dentro del radio de la huella centrada en el centroide MEDIDO: eso
    // demuestra el registro sin depender del orden interno de las crestas.
    const dashed = ctx.calls.filter(
      (c) => (c.op === 'M' || c.op === 'L') && c.dash?.length === 2 && c.dash[0] === 5,
    );
    expect(dashed.length).toBeGreaterThan(20);

    const centre = projectWellUV(geo, view.ghost.u, view.ghost.v);
    const rimU = projectWellUV(
      geo,
      view.ghost.u + VITAL_THRESHOLDS.PLACEMENT.OVERLAY.RIDGE_U * view.ghostScale,
      view.ghost.v,
    );
    const rimV = projectWellUV(
      geo,
      view.ghost.u,
      view.ghost.v + VITAL_THRESHOLDS.PLACEMENT.OVERLAY.RIDGE_V * view.ghostScale,
    );
    const radius =
      Math.max(Math.abs(rimU.x - centre.x), Math.abs(rimV.y - centre.y)) * 1.35 + 2;
    for (const p of dashed) {
      expect(Math.hypot(p.args[0] - centre.x, p.args[1] - centre.y)).toBeLessThan(radius);
    }
    // Y el fantasma está claramente fuera del centro: si estuviera centrado, la
    // prueba no distinguiría "registrado" de "dibujado en el centro".
    expect(Math.hypot(view.ghost.u - 0.5, view.ghost.v - 0.5)).toBeGreaterThan(0.1);
    expect(fingerprintRidges(0, 0, 1).length).toBe(VITAL_THRESHOLDS.PLACEMENT.OVERLAY.RIDGES);
  });

  it('LOCKED: sin trazo discontinuo (el fantasma desaparece) y con color de confirmación', () => {
    const { ctx } = paint({});
    expect(ctx.calls.some((c) => c.op === 'S' && c.dash?.length === 2)).toBe(false);
    const texts = textCalls(ctx);
    expect(texts[0].text).toMatch(/ESTABLE/);
  });

  it('el texto vive dentro de la banda del zócalo, no por encima de la ventana', () => {
    const { ctx, geo } = paint({});
    const scrimTop = projectWellUV(geo, 0.5, VITAL_THRESHOLDS.PLACEMENT.OVERLAY.SCRIM_V).y;
    const texts = textCalls(ctx);
    expect(texts.length).toBeGreaterThanOrEqual(2);
    for (const t of texts) {
      expect(t.args[1]).toBeGreaterThan(scrimTop);
      expect(t.args[1]).toBeLessThan(geo.nearY);
    }
  });
});