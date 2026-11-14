import { describe, expect, it } from 'vitest';
import { computeMonitorLayout, hasInlineMonitorControls, splitMorphologyPlot } from '../monitorLayout';
import { computeCapturePreviewLayout } from '../ppg3dProjection';
import type { PpgRenderState } from '../ppgCanvasRenderer';

describe('monitor layout', () => {
  for (const [w, h] of [[320, 568], [390, 844], [844, 390], [1440, 900], [2560, 1440]]) {
    it(`keeps the plot, controls and metrics within ${w}×${h}`, () => {
      const layout = computeMonitorLayout(w, h, 24);
      const { main, morphology } = splitMorphologyPlot(layout.plot, true);
      expect(main.h).toBeGreaterThan(60);
      expect(main.x + main.w).toBeLessThanOrEqual(w);
      expect(layout.plot.y + layout.plot.h + (hasInlineMonitorControls(w, h) ? 0 : 50)).toBeLessThanOrEqual(layout.footer.y);
      expect(morphology.y + morphology.h).toBeLessThanOrEqual(layout.plot.y + layout.plot.h);
      if (w >= 1024) expect(main.x + main.w).toBeLessThan(layout.metrics.x);
      else expect(layout.metrics.y + layout.metrics.h).toBeLessThan(main.y);
    });
  }
  it('gives a phone more than half its height to the observed channels', () => {
    expect(computeMonitorLayout(390, 844).plot.h).toBeGreaterThan(844 * .55);
  });
  it('preserves the complete plot when the hybrid view is disabled', () => {
    const plot = computeMonitorLayout(1440, 900).plot;
    expect(splitMorphologyPlot(plot, false).main).toEqual(plot);
    expect(splitMorphologyPlot(plot, false).morphology.h).toBe(0);
  });
  it('expands the signal on a phone and keeps hybrid channels in landscape', () => {
    expect(computeMonitorLayout(390, 844, 0, true).plot.h).toBeGreaterThan(computeMonitorLayout(390, 844).plot.h);
    expect(splitMorphologyPlot(computeMonitorLayout(844, 390, 24).plot, true).morphology.h).toBeGreaterThan(0);
  });
  it('retains a legible capture guide beside the channels in short landscape', () => {
    const layout = computeMonitorLayout(844, 390, 24);
    const capture = layout.capturePreview!;
    expect(capture.x).toBeGreaterThanOrEqual(layout.plot.x + layout.plot.w);
    const { card } = computeCapturePreviewLayout({ layout: { ...layout, plot: { ...capture, centerY: capture.y + capture.h / 2 } } } as PpgRenderState);
    expect(card.h).toBeGreaterThanOrEqual(120);
    expect(card.x + card.w).toBeLessThanOrEqual(layout.width);
  });
});
