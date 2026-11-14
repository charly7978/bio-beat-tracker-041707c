import type { PpgLayout } from './ppgCanvasRenderer';

export function hasInlineMonitorControls(width: number, height: number): boolean {
  return width > height && height < 650;
}

/** Disposición del instrumento en píxeles CSS; la densidad del canvas es independiente. */
export function computeMonitorLayout(width: number, height: number, safeBottom = 0, focus = false): PpgLayout {
  const wide = width >= 1024 && height >= 600;
  const short = height < 650;
  const landscape = hasInlineMonitorControls(width, height);
  const margin = wide ? 24 : 12;
  const header = { x: 0, y: 0, w: width, h: wide ? 64 : 52 };
  const buttonsH = 64 + safeBottom;
  const footerH = short ? 0 : 38;
  const trendH = wide && !focus && height >= 800 ? 64 : 0;
  const metrics = wide
    ? { x: width - 236, y: 80, w: 212, h: height - buttonsH - footerH - 94 }
    : { x: 0, y: header.h, w: width, h: landscape && width >= 640 ? 0 : focus ? 58 : short ? 64 : 78 };
  const plotY = wide ? 114 : header.h + metrics.h + 48;
  const captureW = landscape && width >= 640 ? 206 : 0;
  const plotW = wide ? width - 284 : width - margin * 2 - captureW;
  const plotBottom = height - buttonsH - footerH - trendH - (landscape ? 12 : 62);
  const plotH = Math.max(60, plotBottom - plotY);
  const plot = { x: margin, y: plotY, w: plotW, h: plotH, centerY: plotY + plotH / 2 };
  return {
    width, height, header, metrics, plot,
    capturePreview: captureW ? { x: margin + plotW, y: plotY, w: captureW, h: plotH } : undefined,
    trend: { x: margin, y: plotBottom + 60, w: plotW, h: trendH },
    footer: { x: 0, y: height - buttonsH - footerH, w: width, h: footerH },
  };
}

/** Ambos canales comparten el mismo tiempo y ancho; se reserva espacio entre ellos. */
export function splitMorphologyPlot(plot: PpgLayout['plot'], enabled: boolean) {
  const band = enabled && plot.h >= 175 ? Math.min(136, Math.max(84, plot.h * .26)) : 0;
  const mainH = plot.h - (band > 0 ? band + 22 : 0);
  return {
    main: { ...plot, h: mainH, centerY: plot.y + mainH / 2 },
    morphology: { ...plot, y: plot.y + mainH + (band ? 22 : 0), h: band, centerY: plot.y + mainH + (band ? 22 : 0) + band / 2 },
  };
}
