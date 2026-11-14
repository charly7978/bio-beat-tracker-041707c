import { CAPTURE_TIMING_DEFAULTS } from '@/config/signalProcessing';
import type { EcgEstimate } from '@/types/signal';
import type { CircularBuffer, PPGDataPoint } from '@/utils/CircularBuffer';
import type { PpgRenderState } from './ppgCanvasRenderer';
import { MONITOR_VIEW } from './monitorViewport';

const TRACE_COLOR = '#e8c080';
const REASONS: Record<string, string> = {
  QUALITY: 'Mejora la señal para estimar el ECG',
  CAPTURE_GAP: 'Recuperando continuidad de captura',
  CLOCK: 'Esperando tiempos de captura continuos',
  EPOCH_CHANGED: 'Reuniendo un nuevo segmento de señal',
  CONTEXT: 'Reuniendo señal para el modelo',
  FILTER_WARMUP: 'Estabilizando la señal del modelo',
  MODEL_INPUT: 'Señal insuficiente para el modelo',
  MODEL_ERROR: 'No se pudo ejecutar el modelo',
};

function formatScale(value: number): string {
  if (value === 0) return '0';
  if (value >= 1000 || value < 0.01) return value.toExponential(1);
  return value.toFixed(value < 1 ? 2 : 1);
}

function observedSegments(points: readonly PPGDataPoint[], startMs: number, endMs: number): PPGDataPoint[][] {
  const segments: PPGDataPoint[][] = [];
  let active: PPGDataPoint[] | undefined;
  let previousTime: number | undefined;
  for (const point of points) {
    if (!Number.isFinite(point.time) || !Number.isFinite(point.value) || point.time < startMs || point.time > endMs) {
      active = undefined;
      previousTime = undefined;
      continue;
    }
    const interval = previousTime === undefined ? 0 : point.time - previousTime;
    if (!active || interval <= 0 || interval > CAPTURE_TIMING_DEFAULTS.maxFrameGapMs) {
      active = [];
      segments.push(active);
    }
    active.push(point);
    previousTime = point.time;
  }
  return segments;
}

/**
 * Dibuja exclusivamente salidas del modelo entrenado. El caller entrega el
 * buffer de inferencias en el reloj de pared de la vista; durante inspección
 * debe pasar su copia congelada, nunca el buffer PPG de state.inspection.
 * No compensa el retardo moviendo timestamps, no extiende la última predicción
 * y no convierte amplitudes normalizadas en voltaje eléctrico.
 */
export function drawEstimatedEcg(
  ctx: CanvasRenderingContext2D,
  state: PpgRenderState,
  buffer: CircularBuffer | null,
  estimate: EcgEstimate | undefined,
): void {
  const { plot } = state.layout;
  if (plot.w <= 0 || plot.h < 60) return;

  const endMs = state.inspection?.endMs ?? state.now;
  const windowMs = state.windowMs ?? MONITOR_VIEW.defaultWindowMs;
  const startMs = endMs - windowMs;
  const liveContact = state.props.isMonitoring && state.props.isFingerDetected && state.props.contactState !== 'NO_CONTACT';
  const canShowData = !!state.inspection || (liveContact && estimate?.status === 'AVAILABLE');
  const segments = canShowData && buffer
    ? observedSegments(buffer.getRecentPointsSince(startMs), startMs, endMs)
    : [];
  let extent = 0;
  for (const segment of segments) {
    for (const point of segment) extent = Math.max(extent, Math.abs(point.value));
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  ctx.fillStyle = 'rgba(14, 18, 25, 0.96)';
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

  ctx.textAlign = 'left';
  ctx.fillStyle = TRACE_COLOR;
  ctx.font = '600 11px system-ui, sans-serif';
  // Reserva los últimos 28 px de la cabecera para el botón del informe que
  // superpone el caller. La salida conserva el nombre de modelo experimental.
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, Math.max(0, plot.w - 36), 34);
  ctx.clip();
  ctx.fillText(plot.w < 520 ? 'PPG→ECG · CONCORDANCIA BAJA' : 'MODELO PPG→ECG · CONCORDANCIA BAJA', plot.x + 8, plot.y + 14);

  const latencyMs = estimate?.latencyMs;
  const delay = typeof latencyMs === 'number' && Number.isFinite(latencyMs) && latencyMs > 0
    ? `retardo ${(latencyMs / 1000).toFixed(2)} s`
    : 'retardo: esperando modelo';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = '#a8b6c4';
  ctx.fillText(`Experimental · ${delay} · u.r.`, plot.x + 8, plot.y + 29);
  ctx.restore();

  const graphTop = plot.y + 37;
  const graphHeight = Math.max(8, plot.h - 44);
  const baseline = graphTop + graphHeight / 2;
  const amplitudePx = Math.max(2, graphHeight / 2 - 3);

  if (segments.length) {
    ctx.strokeStyle = 'rgba(197, 181, 151, 0.16)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(plot.x, baseline);
    ctx.lineTo(plot.x + plot.w, baseline);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = TRACE_COLOR;
    ctx.fillStyle = TRACE_COLOR;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    for (const segment of segments) {
      ctx.beginPath();
      segment.forEach((point, index) => {
        const x = plot.x + (point.time - startMs) / windowMs * plot.w;
        const y = baseline - (extent > 0 ? point.value / extent : 0) * amplitudePx;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        if (segment.length === 1) ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
      });
      ctx.stroke();
    }

    const scale = `±${formatScale(extent)} u.r.`;
    ctx.font = '11px ui-monospace, monospace';
    const scaleWidth = ctx.measureText(scale).width;
    ctx.fillStyle = 'rgba(14, 18, 25, 0.96)';
    ctx.fillRect(plot.x + plot.w - scaleWidth - 11, plot.y + plot.h - 15, scaleWidth + 7, 15);
    ctx.fillStyle = '#c4b79f';
    ctx.textAlign = 'right';
    ctx.fillText(scale, plot.x + plot.w - 8, plot.y + plot.h - 3);
  } else {
    let message: string;
    if (state.inspection) message = 'Sin salida del modelo en este segmento';
    else if (!state.props.isMonitoring) message = 'Modelo en espera · inicia una medición';
    else if (!liveContact) message = 'Apoya la yema para activar el modelo';
    else if (!estimate || estimate.status === 'WARMUP') message = 'Reuniendo señal para el modelo';
    else if (estimate.status === 'INSUFFICIENT') message = REASONS[estimate.reason ?? ''] ?? 'Señal insuficiente para el modelo';
    else message = 'Esperando salida del modelo en esta ventana';

    ctx.fillStyle = '#a8b6c4';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const warming = !state.inspection && liveContact && (!estimate || estimate.status === 'WARMUP');
    ctx.fillText(message, plot.x + plot.w / 2, baseline + (warming ? -3 : 4));
    if (warming) ctx.fillText('Requiere ~7 s de señal estable', plot.x + plot.w / 2, baseline + 13);
  }
  ctx.restore();
}
