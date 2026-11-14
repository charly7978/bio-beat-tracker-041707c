import { describe, expect, it } from 'vitest';
import { computeMonitorLayout } from '../monitorLayout';
import { drawFooter, drawMetricsBar, type PpgRenderState } from '../ppgCanvasRenderer';

class ReadoutContext {
  font = '10px monospace';
  textAlign: CanvasTextAlign = 'left';
  texts: { text: string; x: number; y: number; width: number }[] = [];
  save() {}
  restore() {}
  beginPath() {}
  roundRect() {}
  fill() {}
  stroke() {}
  fillRect() {}
  moveTo() {}
  lineTo() {}
  measureText(text: string) {
    const size = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 10);
    return { width: text.length * size * .6 };
  }
  fillText(text: string, x: number, y: number) {
    const width = this.measureText(text).width;
    this.texts.push({ text, x: this.textAlign === 'right' ? x - width : x, y, width });
  }
}

function readoutState(width: number, height: number): PpgRenderState {
  return {
    layout: computeMonitorLayout(width, height),
    props: { rrIntervals: [], isMonitoring: true, respirationRate: 17 },
    displayBpm: 123, displaySpo2: 97, displaySys: 138, displayDia: 85,
    hrv: { sdnn: 0, rmssd: 0, pnn50: 0, cv: 0 }, ibiDisplay: 0,
  } as unknown as PpgRenderState;
}

describe('legibilidad de lecturas del monitor', () => {
  for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1440, 900]]) {
    it(`mantiene valores y unidades dentro del instrumento ${width}×${height}`, () => {
      const ctx = new ReadoutContext();
      const state = readoutState(width, height);
      drawMetricsBar(ctx as unknown as CanvasRenderingContext2D, state);
      expect(ctx.texts.some(t => t.text.includes('EXP.')) || ctx.texts.some(t => t.text.includes('EXPERIMENTAL'))).toBe(true);
      expect(ctx.texts.some(t => t.text.includes('mmHg'))).toBe(true);
      for (const text of ctx.texts) {
        expect(text.x).toBeGreaterThanOrEqual(0);
        expect(text.x + text.width).toBeLessThanOrEqual(width);
        expect(text.y).toBeGreaterThan(0);
        expect(text.y).toBeLessThanOrEqual(height);
      }
    });
  }

  it('muestra ausencia de variabilidad cuando aún no hay intervalos', () => {
    const ctx = new ReadoutContext();
    const state = readoutState(390, 844);
    drawFooter(ctx as unknown as CanvasRenderingContext2D, state);
    expect(ctx.texts.filter(t => t.text === '—')).toHaveLength(5);
    expect(ctx.texts.every(t => t.y <= state.layout.footer.y + state.layout.footer.h)).toBe(true);
  });
});
