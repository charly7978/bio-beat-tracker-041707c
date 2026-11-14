import { CAPTURE_TIMING_DEFAULTS } from '@/config/signalProcessing';
import type { PpgRenderState } from './ppgCanvasRenderer';
import { MONITOR_VIEW } from './monitorViewport';
import { derivePulseMorphology } from './pulseMorphology';
import type { PulseMorphologySegment } from './pulseMorphology';

function formatExtent(value: number): string {
  if (value === 0) return '0';
  if (value >= 1000 || value < 0.01) return value.toExponential(1);
  return value.toFixed(value < 1 ? 2 : 1);
}

/** Dos vistas diferenciales de la misma PPG filtrada, con escala y reloj propios de la observación. */
export function drawPulseMorphology(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const { plot } = state.layout;
  if (plot.w <= 0 || plot.h < 40) return;

  const endMs = state.inspection?.endMs ?? state.now;
  const windowMs = state.windowMs ?? MONITOR_VIEW.defaultWindowMs;
  const startMs = endMs - windowMs;
  const buffer = state.inspection?.buffer ?? state.buffer;
  const hasLiveContact = state.props.isMonitoring && state.props.isFingerDetected && state.props.contactState !== 'NO_CONTACT';
  const canShowData = !!state.inspection || hasLiveContact;
  const observations = canShowData
    ? buffer?.getRecentPointsSince(startMs - CAPTURE_TIMING_DEFAULTS.maxFrameGapMs * 2).filter(point => point.time <= endMs) ?? []
    : [];
  const segments = derivePulseMorphology(observations)
    .map(segment => segment.filter(point => point.time >= startMs && point.time <= endMs))
    .filter(segment => segment.length > 0);

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  ctx.fillStyle = 'rgba(6, 15, 25, 0.94)';
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

  const compact = plot.w < 520;
  const channels = [
    { key: 'velocity' as const, title: compact ? 'VPG · dPPG/dt' : 'VPG · PRIMERA DERIVADA · dPPG/dt', color: '#79dce9', unit: 'u.r./s' },
    { key: 'acceleration' as const, title: compact ? 'APG · d²PPG/dt²' : 'APG · SEGUNDA DERIVADA · d²PPG/dt²', color: '#b4a6f4', unit: 'u.r./s²' },
  ];
  const channelHeight = plot.h / channels.length;

  channels.forEach((channel, index) => {
    const top = plot.y + index * channelHeight;
    const labelHeight = compact ? 17 : 21;
    const baseline = top + labelHeight + (channelHeight - labelHeight - 5) / 2;
    const amplitudePx = Math.max(2, (channelHeight - labelHeight - 9) / 2);
    let extent = 0;
    for (const segment of segments) {
      for (const point of segment) extent = Math.max(extent, Math.abs(point[channel.key]));
    }

    ctx.fillStyle = channel.color;
    ctx.textAlign = 'left';
    ctx.font = '500 11px system-ui, sans-serif';
    ctx.fillText(channel.title, plot.x + 8, top + 13);
    const titleWidth = ctx.measureText(channel.title).width;
    const scaleText = segments.length ? `±${formatExtent(extent)} ${channel.unit}` : `— ${channel.unit}`;
    const scaleFont = `${compact ? 10 : 11}px ui-monospace, monospace`;
    ctx.font = scaleFont;
    const scaleWidth = ctx.measureText(scaleText).width;
    const scaleBelow = titleWidth + scaleWidth + 28 > plot.w;

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(124, 153, 173, 0.19)';
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(plot.x, baseline);
    ctx.lineTo(plot.x + plot.w, baseline);
    ctx.stroke();
    ctx.setLineDash([]);

    if (segments.length) {
      drawChannel(ctx, segments, channel.key, channel.color, extent, amplitudePx, baseline, plot.x, plot.w, startMs, windowMs);
    } else if (index === 0) {
      ctx.fillStyle = '#8fa6b7';
      ctx.font = `${compact ? 10 : 11}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(canShowData ? 'Esperando muestras continuas' : 'Esperando señal del dedo', plot.x + plot.w / 2, baseline + 3);
    }

    // En anchuras muy pequeñas la escala baja a la esquina; conserva 10 px
    // legibles y su fondo evita que una muestra pase por encima del número.
    const scaleY = scaleBelow ? top + channelHeight - 3 : top + 13;
    if (scaleBelow) {
      ctx.fillStyle = 'rgba(6, 15, 25, 0.96)';
      ctx.fillRect(plot.x + plot.w - scaleWidth - 11, scaleY - 10, scaleWidth + 5, 13);
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = '#8fa6b7';
    ctx.font = scaleFont;
    ctx.fillText(scaleText, plot.x + plot.w - 8, scaleY);

    ctx.strokeStyle = 'rgba(124, 153, 173, 0.15)';
    ctx.beginPath();
    ctx.moveTo(plot.x, top);
    ctx.lineTo(plot.x + plot.w, top);
    ctx.stroke();
  });

  ctx.restore();
}

function drawChannel(
  ctx: CanvasRenderingContext2D,
  segments: PulseMorphologySegment[],
  key: 'velocity' | 'acceleration',
  color: string,
  extent: number,
  amplitudePx: number,
  baseline: number,
  x: number,
  width: number,
  startMs: number,
  windowMs: number,
): void {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  for (const segment of segments) {
    ctx.beginPath();
    segment.forEach((point, index) => {
      const px = x + (point.time - startMs) / windowMs * width;
      const py = baseline - (extent > 0 ? point[key] / extent : 0) * amplitudePx;
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
      if (segment.length === 1) ctx.fillRect(px - 0.75, py - 0.75, 1.5, 1.5);
    });
    ctx.stroke();
  }
}
