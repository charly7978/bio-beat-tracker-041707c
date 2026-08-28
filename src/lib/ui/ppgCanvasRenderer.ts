import { CircularBuffer } from '../../utils/CircularBuffer';
import { isPhysiologicalRR } from '../../utils/physio';
import {
  buildRhythmPanel,
  formatContactState,
  ibiSegmentLabel,
  levelColor,
} from './ppgMonitorClinical';
import { drawWaveRibbon3D } from './ppg3dProjection';

export const FONT_MONO = '"SF Mono", Consolas, "Roboto Mono", "JetBrains Mono", monospace';

export const COLORS = {
  BG_TOP: '#050811',
  BG_BOTTOM: '#010307',
  PANEL_BG: 'rgba(8, 16, 30, 0.92)',
  PANEL_CARD_BG: 'rgba(12, 22, 40, 0.75)',
  PANEL_BORDER: 'rgba(34, 197, 94, 0.40)',
  PANEL_BORDER_CYAN: 'rgba(6, 182, 212, 0.45)',
  PANEL_BORDER_DIM: 'rgba(148, 163, 184, 0.18)',
  GRID_MINOR: 'rgba(255, 255, 255, 0.14)',
  GRID_MAJOR: 'rgba(255, 255, 255, 0.32)',
  GRID_CROSS: 'rgba(103, 232, 249, 0.45)',
  GRID_SEC: 'rgba(103, 232, 249, 0.50)',
  SCANLINE: 'rgba(255, 255, 255, 0.015)',
  BASELINE: 'rgba(34, 197, 94, 0.35)',
  SIGNAL: '#22c55e',
  SIGNAL_BRIGHT: '#4ade80',
  SIGNAL_CORE: '#ffffff',
  SIGNAL_GLOW: 'rgba(34, 197, 94, 0.65)',
  SIGNAL_ARR: '#ef4444',
  SIGNAL_ARR_BRIGHT: '#f87171',
  SIGNAL_ARR_GLOW: 'rgba(239, 68, 68, 0.65)',
  PEAK_NORMAL: '#00f2ff',
  PEAK_ARR: '#ef4444',
  VALLEY: '#64748b',
  TEXT_PRIMARY: '#22c55e',
  TEXT_SECONDARY: '#94a3b8',
  TEXT_DIM: 'rgba(255, 255, 255, 0.65)',
  TEXT_WARN: '#f59e0b',
  TEXT_DANGER: '#ef4444',
  TEXT_INFO: '#67e8f9',
  TEXT_VIOLET: '#a78bfa',
  SPO2: '#06b6d4',
  BP: '#818cf8',
};

/**
 * TABLA DE CONSTANTES CONFIGURABLES PARA LAS ONDAS CARDÍACAS (PPG MONITOR)
 */
export const CARDIAC_WAVE_CONFIG = {
  WINDOW_MS: 2200,
  BUFFER_SIZE: 2500,
  VISUAL_DELAY_MS: 0,
  AMP_ATTACK: 0.50,
  AMP_RELEASE: 0.30,
  BASE_STROKE_WIDTH: 2.2,
  GLOW_STROKE_WIDTH: 3.2,
  CORE_STROKE_WIDTH: 1.2,
  LEADING_STROKE_WIDTH: 2.0,
  SHADOW_BLUR_BASE: 12,
  SHADOW_BLUR_LEADING: 20,
  SYS_PEAK_RADIUS: 3.8,
  DIA_VALLEY_RADIUS: 2.6,
  DIC_NOTCH_RADIUS: 2.4,
  ARR_WARNING_RADIUS: 11.0,
  ARR_WARNING_WIDTH: 1.8,
  HEAD_PULSE_BASE_RADIUS: 6.5,
  HEAD_PULSE_INNER_RADIUS: 3.0,
  WAVE_PAD_TOP: 22,
  WAVE_PAD_BOTTOM: 44,
  SWEEP_PULSE_DECAY: 0.91,
  PEAK_DEBOUNCE_MS: 250,
  DEFAULT_RR_INTERVAL_MS: 800,
  MIN_ARR_DURATION_MS: 400,
  MAX_ARR_DURATION_MS: 1500,
  ARR_RETRO_ALIGN_FACTOR: 0.35,
  ARR_ANTERO_ALIGN_FACTOR: 1.65,
  WAVE_SHARPNESS_EXPONENT: 1.75,
};

export const TARGET_FPS = 60;
export const WINDOW_MS = CARDIAC_WAVE_CONFIG.WINDOW_MS;
export const BUFFER_SIZE = CARDIAC_WAVE_CONFIG.BUFFER_SIZE;
export const TREND_WINDOW_MS = 60_000;
export const TREND_MAX_POINTS = 240;
export const BEAT_HISTORY_MAX = 30;
export const VISUAL_DELAY_MS = CARDIAC_WAVE_CONFIG.VISUAL_DELAY_MS;
export const AMP_ATTACK = CARDIAC_WAVE_CONFIG.AMP_ATTACK;
export const AMP_RELEASE = CARDIAC_WAVE_CONFIG.AMP_RELEASE;
export const RR_TACHO_H = 36;

export interface PpgLayout {
  width: number;
  height: number;
  header: { x: number; y: number; w: number; h: number };
  metrics: { x: number; y: number; w: number; h: number };
  plot: { x: number; y: number; w: number; h: number; centerY: number };
  trend: { x: number; y: number; w: number; h: number };
  footer: { x: number; y: number; w: number; h: number };
}

export interface HrvDisplay {
  sdnn: number;
  rmssd: number;
  pnn50: number;
  cv: number;
}

export interface BpmStats {
  min: number;
  max: number;
  sum: number;
  n: number;
}

export interface TrendPoint {
  t: number;
  bpm: number;
  isArr: boolean;
}

export interface BeatEntry {
  isArrhythmia: boolean;
  time: number;
  rr: number;
}

export interface AmplitudeStats {
  min: number;
  max: number;
  range: number;
}

export interface PpgRenderProps {
  value: number;
  quality: number;
  isFingerDetected: boolean;
  isMonitoring: boolean;
  isPeak: boolean;
  preserveResults: boolean;
  bpm: number | null;
  spo2: number;
  rrIntervals: number[];
  elapsedTime: number;
  perfusionIndex: number;
  pressure?: { systolic: number; diastolic: number; confidence?: string; featureQuality?: number };
  bpStatus?: string;
  arrhythmiaStatus?: string;
  arrhythmiaCount: number;
  contactState?: string;
  acquisitionStatus?: string;
  diagnostics?: {
    status?: string;
    message?: string;
    placementHint?: string;
    fingerPressure?: 'LIGHT' | 'IDEAL' | 'HEAVY';
    hasPulsatility?: boolean;
    acquisitionStage?: 'SEARCHING' | 'STABILIZING' | 'READY';
    acquisitionProgress?: number;
    sqm?: { fpsEffective?: number; timestampJitterMs?: number; underexposureRatio?: number };
    peakDetection?: {
      confidence?: number;
      agreement?: { elgendi?: number };
      fusedPeakTimes?: number[];
      elgendiPeakTimes?: number[];
      fusedPeakCount?: number;
      rejectedPeaks?: Array<{ index: number; reason: string; detector: string }>;
    };
  };
}

export interface PpgRenderState {
  layout: PpgLayout;
  props: PpgRenderProps;
  now: number;
  displayBpm: number;
  displaySpo2: number;
  displaySys: number;
  displayDia: number;
  hrv: HrvDisplay;
  bpmStats: BpmStats;
  bpmTrend: TrendPoint[];
  beatHistory: BeatEntry[];
  amplitudeStats: AmplitudeStats;
  waveGain: number;
  sweepPulse: number;
  ibiDisplay: number;
  buffer: CircularBuffer | null;
  lastArrhythmiaCount: number;
  pendingTrendArr: boolean;
  lastPeakProcessedTime: number;
  arrActiveUntil: number;
  traceRevealed: boolean;
  signalStrength: number;
  threeD?: { enabled: boolean; intensity?: number };
}

/**
 * Dibuja el fondo de la pantalla con viñeta de profundidad CRT / OLED y micro-scanlines.
 */
export function drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  // 1. Fondo base con viñeta radial (profundidad clínica de monitor de paciente)
  const cx = W / 2;
  const cy = H / 2;
  const rad = Math.max(W, H) * 0.8;
  const bgGrad = ctx.createRadialGradient(cx, cy * 0.7, 40, cx, cy, rad);
  bgGrad.addColorStop(0, '#0a1426');
  bgGrad.addColorStop(0.5, '#040813');
  bgGrad.addColorStop(1, '#010307');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // 2. Micro-Scanlines sutiles con modulación de luminancia
  ctx.fillStyle = COLORS.SCANLINE;
  for (let y = 0; y < H; y += 3) {
    ctx.fillRect(0, y, W, 1);
  }

  // 3. Resplandor superior sutil
  const topGlow = ctx.createLinearGradient(0, 0, 0, 120);
  topGlow.addColorStop(0, 'rgba(6, 182, 212, 0.04)');
  topGlow.addColorStop(1, 'rgba(6, 182, 212, 0)');
  ctx.fillStyle = topGlow;
  ctx.fillRect(0, 0, W, 120);
}

/**
 * Dibuja el encabezado de instrumentación médica / telemetría en tiempo real.
 */
export function drawHeader(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const { header } = state.layout;
  const { isFingerDetected: detected, elapsedTime: elapsed, diagnostics } = state.props;

  // Fondo Glassmorphic translúcido
  ctx.fillStyle = 'rgba(6, 14, 28, 0.92)';
  ctx.fillRect(header.x, header.y, header.w, header.h);
  
  // Línea de acento superior e inferior con brillo sutil
  const borderGrad = ctx.createLinearGradient(0, 0, header.w, 0);
  borderGrad.addColorStop(0, 'rgba(34, 197, 94, 0.2)');
  borderGrad.addColorStop(0.5, 'rgba(6, 182, 212, 0.6)');
  borderGrad.addColorStop(1, 'rgba(34, 197, 94, 0.2)');
  ctx.strokeStyle = borderGrad;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, header.y + header.h);
  ctx.lineTo(header.w, header.y + header.h);
  ctx.stroke();

  // 1. Lado Izquierdo: Baliza de Estado del Sensor Óptico con Glow
  ctx.font = `bold 10px ${FONT_MONO}`;
  ctx.textAlign = 'left';
  
  // Punto indicador luminoso
  const dotX = 20;
  const dotY = header.y + 20;
  ctx.save();
  ctx.beginPath();
  ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
  ctx.fillStyle = detected ? '#22c55e' : 'rgba(148, 163, 184, 0.4)';
  if (detected) {
    ctx.shadowColor = '#22c55e';
    ctx.shadowBlur = 8;
  }
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = detected ? '#4ade80' : COLORS.TEXT_DIM;
  ctx.fillText(detected ? 'SENSOR ÓPTICO ACTIVO' : 'COLOCAR DEDO EN SENSOR', dotX + 12, header.y + 24);

  // 2. Centro: Diagnóstico de Adquisición o Cronómetro de Sesión con cápsula HUD
  const d = new Date(state.now);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const t = Math.max(0, Math.floor(elapsed || 0));
  const em = String(Math.floor(t / 60)).padStart(2, '0');
  const es = String(t % 60).padStart(2, '0');

  const diag = diagnostics;
  const hideLowFlicker = diag?.status === 'LOW_SIGNAL_QUALITY' && diag.hasPulsatility === true;
  const placementHint = typeof diag?.placementHint === 'string' ? diag.placementHint : '';
  const stage = diag?.acquisitionStage;
  const hardBlocker =
    diag?.status === 'MOTION_ARTIFACT' ||
    diag?.status === 'SATURATED' ||
    diag?.status === 'UNDEREXPOSED' ||
    diag?.status === 'LOW_FPS' ||
    diag?.status === 'TORCH_UNAVAILABLE';

  const centerBadgeW = 200;
  const centerBadgeH = 22;
  const centerBadgeX = header.w / 2 - centerBadgeW / 2;
  const centerBadgeY = header.y + 9;

  ctx.fillStyle = 'rgba(15, 28, 50, 0.7)';
  ctx.beginPath();
  ctx.roundRect(centerBadgeX, centerBadgeY, centerBadgeW, centerBadgeH, 11);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.stroke();

  if (detected && stage === 'STABILIZING' && !hardBlocker) {
    const pct = Math.round((diag?.acquisitionProgress ?? 0) * 100);
    ctx.fillStyle = COLORS.TEXT_INFO;
    ctx.textAlign = 'center';
    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.fillText(`ESTABILIZANDO · ${pct}%`, header.w / 2, header.y + 24);
  } else if (placementHint && detected && stage === 'READY') {
    ctx.fillStyle = COLORS.TEXT_INFO;
    ctx.font = `10px ${FONT_MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText(placementHint, header.w / 2, header.y + 24);
  } else if (diag?.status && diag.status !== 'VALID' && diag.status !== 'WARMUP' && !hideLowFlicker) {
    ctx.fillStyle = COLORS.TEXT_DANGER;
    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText(`⚠ ${diag.status}`, header.w / 2, header.y + 24);
  } else {
    ctx.font = `10px ${FONT_MONO}`;
    ctx.fillStyle = state.props.isMonitoring ? '#4ade80' : COLORS.TEXT_SECONDARY;
    ctx.textAlign = 'center';
    const centerText = state.props.isMonitoring ? `⏱ SESIÓN ${em}:${es}` : `${hh}:${mm}:${ss} UTC`;
    ctx.fillText(centerText, header.w / 2, header.y + 24);
  }

  // 3. Lado Derecho: Telemetría de FPS / Jitter de captura con cápsula tech
  const fpsEff = diag?.sqm?.fpsEffective ?? 30;
  const jitterMs = diag?.sqm?.timestampJitterMs ?? 0;
  ctx.font = `9px ${FONT_MONO}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
  ctx.fillText(`${fpsEff.toFixed(1)} FPS · Δ${jitterMs.toFixed(1)}ms`, header.w - 18, header.y + 24);
}

/**
 * Dibuja la barra de métricas principales con tarjetas de datos segmentadas y brillo holográfico.
 */
export function drawMetricsBar(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const { metrics } = state.layout;
  const { pressure, perfusionIndex: pi, arrhythmiaStatus: arr, arrhythmiaCount: arrCnt } = state.props;

  // Fondo del bloque de métricas
  ctx.fillStyle = 'rgba(6, 13, 25, 0.88)';
  ctx.fillRect(metrics.x, metrics.y, metrics.w, metrics.h);
  
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, metrics.y + metrics.h);
  ctx.lineTo(metrics.w, metrics.y + metrics.h);
  ctx.stroke();

  const padX = 8;
  const gap = 6;
  const totalCardsW = metrics.w - padX * 2;
  const colW = (totalCardsW - gap * 2) / 3;
  const cardH = metrics.h - 12;
  const cardY = metrics.y + 6;

  const dispBpm = state.displayBpm;
  const dispSpo2 = state.displaySpo2;
  const dispSys = state.displaySys;
  const dispDia = state.displayDia;

  // ==========================================
  // TARJETA 1: FRECUENCIA CARDÍACA (BPM)
  // ==========================================
  const card1X = padX;
  const hrColor = dispBpm <= 0 ? COLORS.TEXT_DIM
    : dispBpm < 50 ? COLORS.TEXT_DANGER
    : dispBpm < 60 ? COLORS.TEXT_WARN
    : dispBpm <= 100 ? '#22c55e'
    : dispBpm <= 120 ? COLORS.TEXT_WARN
    : COLORS.TEXT_DANGER;

  // Fondo de tarjeta con micro-borde
  ctx.fillStyle = 'rgba(10, 20, 36, 0.75)';
  ctx.beginPath();
  ctx.roundRect(card1X, cardY, colW, cardH, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(34, 197, 94, 0.25)';
  ctx.stroke();

  // Barra de acento superior luminosa
  const hrAccentGrad = ctx.createLinearGradient(card1X, 0, card1X + colW, 0);
  hrAccentGrad.addColorStop(0, hrColor);
  hrAccentGrad.addColorStop(1, 'rgba(34, 197, 94, 0.1)');
  ctx.fillStyle = hrAccentGrad;
  ctx.fillRect(card1X + 4, cardY + 2, colW - 8, 2);

  // Etiqueta de la tarjeta
  ctx.font = `bold 9px ${FONT_MONO}`;
  ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
  ctx.textAlign = 'left';
  ctx.fillText('FRECUENCIA CARDÍACA', card1X + 10, cardY + 18);

  // Valor numérico con brillo pulsátil sincrónico
  const heartPulse = state.props.isMonitoring && dispBpm > 30 
    ? (Math.sin((state.now / (60000 / Math.max(60, dispBpm))) * 2 * Math.PI) + 1) / 2 
    : 0;

  ctx.save();
  ctx.font = `bold ${colW < 130 ? '42px' : '52px'} ${FONT_MONO}`;
  ctx.fillStyle = hrColor;
  if (dispBpm > 0) {
    ctx.shadowColor = hrColor;
    ctx.shadowBlur = 10 + heartPulse * 12;
  }
  ctx.fillText(dispBpm > 0 ? dispBpm.toString() : '--', card1X + 10, cardY + (colW < 130 ? 56 : 64));
  ctx.restore();

  // Unidad y Estado
  ctx.font = `bold 11px ${FONT_MONO}`;
  ctx.fillStyle = 'rgba(148, 163, 184, 0.8)';
  ctx.fillText('BPM', card1X + 10, cardY + cardH - 8);

  let hrLabel = '';
  if (dispBpm > 0) {
    if (dispBpm < 50) hrLabel = 'BRADICARDIA';
    else if (dispBpm < 60) hrLabel = 'BRADICARDIA';
    else if (dispBpm <= 100) hrLabel = 'SINUSAL';
    else if (dispBpm <= 120) hrLabel = 'TAQUICARDIA';
    else hrLabel = 'TAQUI. SEVERA';
  }
  if (hrLabel) {
    ctx.font = `bold 9px ${FONT_MONO}`;
    ctx.fillStyle = hrColor;
    ctx.textAlign = 'right';
    ctx.fillText(hrLabel, card1X + colW - 8, cardY + cardH - 8);
  }

  const s = state.bpmStats;
  if (s.n > 0) {
    ctx.font = `8px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.textAlign = 'right';
    ctx.fillText(`${s.min}-${s.max}`, card1X + colW - 8, cardY + 18);
  }

  // ==========================================
  // TARJETA 2: SATURACIÓN DE OXÍGENO (SpO2)
  // ==========================================
  const card2X = card1X + colW + gap;
  const spo2Color = dispSpo2 <= 0 ? COLORS.TEXT_DIM
    : dispSpo2 >= 95 ? '#06b6d4'
    : dispSpo2 >= 90 ? COLORS.TEXT_WARN
    : COLORS.TEXT_DANGER;

  ctx.fillStyle = 'rgba(10, 20, 36, 0.75)';
  ctx.beginPath();
  ctx.roundRect(card2X, cardY, colW, cardH, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(6, 182, 212, 0.25)';
  ctx.stroke();

  // Barra de acento superior
  const spo2AccentGrad = ctx.createLinearGradient(card2X, 0, card2X + colW, 0);
  spo2AccentGrad.addColorStop(0, spo2Color);
  spo2AccentGrad.addColorStop(1, 'rgba(6, 182, 212, 0.1)');
  ctx.fillStyle = spo2AccentGrad;
  ctx.fillRect(card2X + 4, cardY + 2, colW - 8, 2);

  ctx.font = `bold 9px ${FONT_MONO}`;
  ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
  ctx.textAlign = 'left';
  ctx.fillText('SATURACIÓN O₂', card2X + 10, cardY + 18);

  ctx.save();
  ctx.font = `bold ${colW < 130 ? '42px' : '52px'} ${FONT_MONO}`;
  ctx.fillStyle = spo2Color;
  if (dispSpo2 > 0) {
    ctx.shadowColor = '#06b6d4';
    ctx.shadowBlur = 10;
  }
  ctx.fillText(dispSpo2 > 0 ? dispSpo2.toString() : '--', card2X + 10, cardY + (colW < 130 ? 56 : 64));
  ctx.restore();

  ctx.font = `bold 11px ${FONT_MONO}`;
  ctx.fillStyle = 'rgba(148, 163, 184, 0.8)';
  const pctX = card2X + 10 + (dispSpo2 > 0 ? (colW < 130 ? 54 : 64) : 40);
  ctx.fillText('%', pctX, cardY + (colW < 130 ? 56 : 64));

  let spLabel = '';
  if (dispSpo2 > 0) {
    if (dispSpo2 >= 95) spLabel = 'NORMOXIA';
    else if (dispSpo2 >= 90) spLabel = 'HIPOX. LEVE';
    else if (dispSpo2 >= 85) spLabel = 'HIPOX. MOD.';
    else spLabel = 'HIPOX. SEVERA';
  }
  ctx.font = `bold 9px ${FONT_MONO}`;
  ctx.fillStyle = spo2Color;
  ctx.textAlign = 'right';
  if (spLabel) ctx.fillText(spLabel, card2X + colW - 8, cardY + cardH - 8);

  if (pi > 0) {
    ctx.font = `8px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.textAlign = 'left';
    ctx.fillText(`PI ${(pi * 100).toFixed(2)}%`, card2X + 10, cardY + cardH - 8);
  }

  // ==========================================
  // TARJETA 3: PRESIÓN ARTERIAL (BP)
  // ==========================================
  const card3X = card2X + colW + gap;
  const sys = dispSys > 0 ? dispSys : pressure?.systolic || 0;
  const dia = dispDia > 0 ? dispDia : pressure?.diastolic || 0;
  const map = sys > 0 && dia > 0 ? Math.round(dia + (sys - dia) / 3) : 0;
  const pp = sys > 0 && dia > 0 ? sys - dia : 0;

  const bpColor = sys <= 0 ? COLORS.TEXT_DIM
    : sys >= 140 || dia >= 90 ? COLORS.TEXT_DANGER
    : sys >= 130 || dia >= 80 ? COLORS.TEXT_WARN
    : sys < 90 || dia < 60 ? COLORS.TEXT_WARN
    : '#818cf8';

  ctx.fillStyle = 'rgba(10, 20, 36, 0.75)';
  ctx.beginPath();
  ctx.roundRect(card3X, cardY, colW, cardH, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(129, 140, 248, 0.25)';
  ctx.stroke();

  // Barra de acento superior
  const bpAccentGrad = ctx.createLinearGradient(card3X, 0, card3X + colW, 0);
  bpAccentGrad.addColorStop(0, bpColor);
  bpAccentGrad.addColorStop(1, 'rgba(129, 140, 248, 0.1)');
  ctx.fillStyle = bpAccentGrad;
  ctx.fillRect(card3X + 4, cardY + 2, colW - 8, 2);

  ctx.font = `bold 9px ${FONT_MONO}`;
  ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
  ctx.textAlign = 'left';
  ctx.fillText('PRESIÓN ART.', card3X + 10, cardY + 18);

  const bpPending =
    state.props.isMonitoring &&
    sys <= 0 &&
    (state.props.bpStatus === 'INSUFFICIENT_WINDOW' ||
      state.props.bpStatus === 'NO_VALID_SIGNAL' ||
      state.props.bpStatus === 'WARMUP');

  ctx.save();
  ctx.font = `bold ${colW < 130 ? '22px' : '26px'} ${FONT_MONO}`;
  ctx.fillStyle = bpColor;
  if (sys > 0) {
    ctx.shadowColor = '#818cf8';
    ctx.shadowBlur = 8;
  }
  ctx.fillText(
    sys > 0 ? `${sys}/${dia}` : bpPending ? '···' : '--/--',
    card3X + 10,
    cardY + (colW < 130 ? 46 : 52),
  );
  ctx.restore();

  ctx.font = `bold 10px ${FONT_MONO}`;
  ctx.fillStyle = 'rgba(148, 163, 184, 0.8)';
  ctx.fillText('mmHg', card3X + 10, cardY + cardH - 8);

  if (sys > 0) {
    ctx.font = `8px ${FONT_MONO}`;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
    ctx.textAlign = 'right';
    ctx.fillText(`MAP ${map} · PP ${pp}`, card3X + colW - 8, cardY + 18);

    let bpLabel = '';
    if (sys >= 140 || dia >= 90) bpLabel = 'HIPERTENSIÓN';
    else if (sys >= 130 || dia >= 80) bpLabel = 'ELEVADA';
    else if (sys < 90 || dia < 60) bpLabel = 'HIPOTENSIÓN';
    else bpLabel = 'NORMAL';
    ctx.font = `bold 9px ${FONT_MONO}`;
    ctx.fillStyle = bpColor;
    ctx.fillText(bpLabel, card3X + colW - 8, cardY + cardH - 8);
  }

  // Banner superior de arritmia si se presenta alerta
  const rhythm = buildRhythmPanel(
    arr,
    arrCnt ?? 0,
    state.props.rrIntervals ?? [],
    state.hrv,
  );
  if (rhythm.level === 'danger' || rhythm.level === 'warn') {
    ctx.fillStyle =
      rhythm.level === 'danger' ? 'rgba(185, 28, 28, 0.85)' : 'rgba(180, 83, 9, 0.80)';
    ctx.fillRect(metrics.x + 8, metrics.y + 2, metrics.w - 16, 18);
    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.fillStyle = rhythm.level === 'danger' ? '#fecaca' : '#fde68a';
    ctx.textAlign = 'center';
    ctx.fillText(`⚠ ${rhythm.title}`, metrics.w / 2, metrics.y + 14);
  }
}

/**
 * Dibuja la cuadrícula ECG cyber-clínica de alta precisión con retículas vectoriales L-bracket y escaneo láser.
 */
export function drawECGGrid(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const { plot } = state.layout;

  // 1. Fondo del Osciloscopio con degradado radial de profundidad
  const grad = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
  grad.addColorStop(0, 'rgba(6, 14, 28, 0.35)');
  grad.addColorStop(0.5, 'rgba(10, 22, 40, 0.20)');
  grad.addColorStop(1, 'rgba(6, 14, 28, 0.35)');
  ctx.fillStyle = grad;
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

  const pxPerMm = Math.max(5, Math.min(10, plot.h / 25));
  const minor = pxPerMm;
  const major = pxPerMm * 5;

  // 2. Grilla Menor (1mm)
  ctx.strokeStyle = COLORS.GRID_MINOR;
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let x = plot.x; x <= plot.x + plot.w; x += minor) {
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
  }
  for (let y = plot.y; y <= plot.y + plot.h; y += minor) {
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
  }
  ctx.stroke();

  // 3. Grilla Mayor (5mm)
  ctx.strokeStyle = COLORS.GRID_MAJOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = plot.x; x <= plot.x + plot.w; x += major) {
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
  }
  for (let y = plot.y; y <= plot.y + plot.h; y += major) {
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
  }
  ctx.stroke();

  // 4. Marcadores de Cruces en Intersecciones Mayores (+)
  ctx.strokeStyle = COLORS.GRID_CROSS;
  ctx.lineWidth = 0.8;
  const crossSize = 2.5;
  ctx.beginPath();
  for (let x = plot.x + major; x < plot.x + plot.w; x += major * 2) {
    for (let y = plot.y + major; y < plot.y + plot.h; y += major * 2) {
      ctx.moveTo(x - crossSize, y);
      ctx.lineTo(x + crossSize, y);
      ctx.moveTo(x, y - crossSize);
      ctx.lineTo(x, y + crossSize);
    }
  }
  ctx.stroke();

  // 5. Divisiones de Segundo (25mm)
  const oneSec = 25 * pxPerMm;
  ctx.strokeStyle = COLORS.GRID_SEC;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let x = plot.x + plot.w; x >= plot.x; x -= oneSec) {
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
  }
  ctx.stroke();

  // 6. Haz de Escaneo Láser Vertical Sutil (Movimiento suave continuo)
  const scanX = plot.x + ((state.now / 35) % plot.w);
  const scanGrad = ctx.createLinearGradient(scanX - 25, 0, scanX + 25, 0);
  scanGrad.addColorStop(0, 'rgba(6, 182, 212, 0)');
  scanGrad.addColorStop(0.5, 'rgba(6, 182, 212, 0.08)');
  scanGrad.addColorStop(1, 'rgba(6, 182, 212, 0)');
  ctx.fillStyle = scanGrad;
  ctx.fillRect(scanX - 25, plot.y, 50, plot.h);

  // 7. Línea Base Cero con Resplandor y Punteado Láser
  ctx.save();
  ctx.strokeStyle = COLORS.BASELINE;
  ctx.shadowColor = '#22c55e';
  ctx.shadowBlur = 6;
  ctx.lineWidth = 1;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(plot.x, plot.centerY);
  ctx.lineTo(plot.x + plot.w, plot.centerY);
  ctx.stroke();
  ctx.restore();

  // 8. Borde del Contenedor con Esquinas L-Bracket Holográficas
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);

  // Dibujar las 4 esquinas L-Bracket en Cyan/Verde
  const bLen = 14;
  ctx.strokeStyle = '#00f2ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  // Top-Left
  ctx.moveTo(plot.x, plot.y + bLen); ctx.lineTo(plot.x, plot.y); ctx.lineTo(plot.x + bLen, plot.y);
  // Top-Right
  ctx.moveTo(plot.x + plot.w - bLen, plot.y); ctx.lineTo(plot.x + plot.w, plot.y); ctx.lineTo(plot.x + plot.w, plot.y + bLen);
  // Bottom-Left
  ctx.moveTo(plot.x, plot.y + plot.h - bLen); ctx.lineTo(plot.x, plot.y + plot.h); ctx.lineTo(plot.x + bLen, plot.y + plot.h);
  // Bottom-Right
  ctx.moveTo(plot.x + plot.w - bLen, plot.y + plot.h); ctx.lineTo(plot.x + plot.w, plot.y + plot.h); ctx.lineTo(plot.x + plot.w, plot.y + plot.h - bLen);
  ctx.stroke();

  // 9. Referencias de Tiempo en el Eje Inferior
  const seconds = Math.floor(WINDOW_MS / 1000);
  ctx.font = `bold 10px ${FONT_MONO}`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  for (let s = 0; s <= seconds; s++) {
    const x = plot.x + plot.w - (s / seconds) * plot.w;
    ctx.fillText(`-${s}s`, x, plot.y + plot.h + 14);
  }

  // 10. Referencias de Amplitud en el Eje Izquierdo
  const stats = state.amplitudeStats;
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 10px ${FONT_MONO}`;
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = plot.y + (i / 4) * plot.h;
    const val = stats.max - (i / 4) * stats.range;
    ctx.fillText(val.toFixed(0), plot.x - 6, y + 4);
  }

  // 11. Título Superior del Gráfico de Grado Instrumentación
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(103, 232, 249, 0.85)';
  ctx.font = `bold 9px ${FONT_MONO}`;
  ctx.fillText('25 mm/s · 0.5–12 Hz · HIGH-FIDELITY PPG · BIO-RADAR', plot.x + 8, plot.y - 8);

  drawPressureGauge(ctx, state);
}

/**
 * Dibuja el medidor de presión dactilar con visualización de nivel en tiempo real.
 */
export function drawPressureGauge(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const p = state.props;
  if (!p.isFingerDetected) return;

  const { plot } = state.layout;
  const diag = p.diagnostics;
  const pressure = diag?.fingerPressure || 'LIGHT';

  const gaugeW = 120;
  const gaugeH = 8;
  const gaugeX = plot.x + plot.w - gaugeW - 16;
  const gaugeY = plot.y + 24;

  ctx.save();
  ctx.font = `bold 9px ${FONT_MONO}`;
  ctx.textAlign = 'left';
  
  let labelText = 'PRESIÓN: IDEAL';
  let labelColor = COLORS.SIGNAL;
  let targetPct = 0.5;

  if (pressure === 'LIGHT') {
    labelText = 'PRESIÓN: SUAVE';
    labelColor = COLORS.TEXT_WARN;
    targetPct = 0.2;
  } else if (pressure === 'HEAVY') {
    labelText = 'PRESIÓN: EXCESIVA';
    labelColor = COLORS.TEXT_DANGER;
    targetPct = 0.8;
  }

  ctx.fillStyle = labelColor;
  ctx.fillText(labelText, gaugeX, gaugeY - 8);

  const grad = ctx.createLinearGradient(gaugeX, 0, gaugeX + gaugeW, 0);
  grad.addColorStop(0, '#f59e0b');
  grad.addColorStop(0.35, '#f59e0b');
  grad.addColorStop(0.45, '#22c55e');
  grad.addColorStop(0.55, '#22c55e');
  grad.addColorStop(0.65, '#ef4444');
  grad.addColorStop(1, '#ef4444');

  ctx.fillStyle = 'rgba(10, 20, 36, 0.85)';
  ctx.beginPath();
  ctx.roundRect(gaugeX - 4, gaugeY - 4, gaugeW + 8, gaugeH + 8, 4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.stroke();
  
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(gaugeX, gaugeY, gaugeW, gaugeH, 3);
  ctx.fill();

  // Cursor indicador diamante luminoso
  const cursorX = gaugeX + gaugeW * targetPct;
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = labelColor;
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.moveTo(cursorX, gaugeY - 2);
  ctx.lineTo(cursorX - 5, gaugeY - 8);
  ctx.lineTo(cursorX + 5, gaugeY - 8);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

/**
 * Dibuja la señal cardíaca con haz de fósforo multicapa (bloom + láser core),
 * anillos concéntricos de sonar en cada latido, cursores luminosos y marcadores fiduciales.
 */
export function drawSignal(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const buffer = state.buffer;
  if (!buffer) return;
  const { plot } = state.layout;
  const p = state.props;

  if (p.preserveResults && !p.isFingerDetected) return;
  if (p.isPeak) state.sweepPulse = 1;

  if (p.isPeak) {
    const peakAge = state.now - state.lastPeakProcessedTime;
    if (peakAge > CARDIAC_WAVE_CONFIG.PEAK_DEBOUNCE_MS) {
      state.lastPeakProcessedTime = state.now;
      const currentCount = p.arrhythmiaCount || 0;
      const rrArr = p.rrIntervals;
      const lastRR = rrArr && rrArr.length > 0 ? rrArr[rrArr.length - 1] : 0;
      const isNewArr = currentCount > state.lastArrhythmiaCount;

      if (isNewArr) {
        state.lastArrhythmiaCount = currentCount;
        state.pendingTrendArr = true;
        const retroRR = lastRR > 0 ? lastRR : CARDIAC_WAVE_CONFIG.DEFAULT_RR_INTERVAL_MS;
        const retroDuration = Math.min(Math.max(retroRR, CARDIAC_WAVE_CONFIG.MIN_ARR_DURATION_MS), CARDIAC_WAVE_CONFIG.MAX_ARR_DURATION_MS);
        buffer.markArrhythmiaBack(retroDuration * CARDIAC_WAVE_CONFIG.ARR_RETRO_ALIGN_FACTOR);
        state.arrActiveUntil = state.now + retroDuration * CARDIAC_WAVE_CONFIG.ARR_ANTERO_ALIGN_FACTOR;
      }
      const storedRR = isPhysiologicalRR(lastRR) ? Math.round(lastRR) : 0;
      state.beatHistory.push({ isArrhythmia: isNewArr, time: state.now - VISUAL_DELAY_MS, rr: storedRR });
      if (state.beatHistory.length > BEAT_HISTORY_MAX) {
        state.beatHistory = state.beatHistory.slice(-BEAT_HISTORY_MAX);
      }
    }
  }

  const points = buffer.getPoints();
  if (points.length > 30) {
    const recentStart = Math.max(0, points.length - 150);
    let mn = Infinity, mx = -Infinity;
    for (let i = recentStart; i < points.length; i++) {
      const v = points[i].value;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const range = Math.max(24, mx - mn);
    const stats = state.amplitudeStats;
    const targetMin = mn - range * 0.1;
    const targetMax = mx + range * 0.1;
    const expanding = targetMax - targetMin > stats.range;
    const blend = expanding ? AMP_ATTACK : AMP_RELEASE;
    stats.min = stats.min * (1 - blend) + targetMin * blend;
    stats.max = stats.max * (1 - blend) + targetMax * blend;
    stats.range = stats.max - stats.min;
  }

  const stats = state.amplitudeStats;
  if (points.length < 2) return;
  const safeRange = stats.range > 1 ? stats.range : 1;
  const wavePadTop = CARDIAC_WAVE_CONFIG.WAVE_PAD_TOP;
  const wavePadBot = CARDIAC_WAVE_CONFIG.WAVE_PAD_BOTTOM;
  const waveH = Math.max(40, plot.h - wavePadTop - wavePadBot);
  const waveBaseY = plot.y + wavePadTop + waveH;

  const strength = state.traceRevealed
    ? (state.signalStrength < 0 ? 0 : state.signalStrength > 1 ? 1 : state.signalStrength)
    : 0.5;
  const midValue = (stats.max + stats.min) / 2;
  const coords: { x: number; y: number; isArr: boolean; val: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const age = state.now - pt.time - VISUAL_DELAY_MS;
    if (age > WINDOW_MS) continue;
    const x = plot.x + plot.w - (age * plot.w / WINDOW_MS);
    if (x < plot.x || x > plot.x + plot.w) continue;
    const honestValue = midValue + (pt.value - midValue) * strength;
    
    const pct = Math.max(0, Math.min(1, (honestValue - stats.min) / safeRange));
    const transformedPct = Math.pow(pct, CARDIAC_WAVE_CONFIG.WAVE_SHARPNESS_EXPONENT);
    const y = plot.y + wavePadTop + (1 - transformedPct) * waveH;
    
    coords.push({ x, y, isArr: pt.isArrhythmia, val: pt.value });
  }

  if (coords.length < 2) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  state.sweepPulse *= CARDIAC_WAVE_CONFIG.SWEEP_PULSE_DECAY;

  if (state.threeD?.enabled) {
    drawWaveRibbon3D(ctx, state, coords, { waveBaseY, waveH, midValue });
  } else {
    // ── MODO 2D: RENDERIZADO DE HAZ DE FÓSFORO Y BLOOM MULTICAPA ──

    // 1. Fondo de Alerta Roja para Segmentos con Arritmia
    let seg = 0;
    while (seg < coords.length) {
      if (!coords[seg].isArr) { seg++; continue; }
      let end = seg;
      while (end < coords.length && coords[end].isArr) end++;
      const x0 = coords[seg].x;
      const x1 = coords[end - 1].x;
      const arrGrad = ctx.createLinearGradient(0, plot.y + wavePadTop, 0, waveBaseY);
      arrGrad.addColorStop(0, 'rgba(239, 68, 68, 0.28)');
      arrGrad.addColorStop(1, 'rgba(127, 29, 29, 0.04)');
      ctx.fillStyle = arrGrad;
      ctx.fillRect(x0, plot.y + wavePadTop, Math.max(3, x1 - x0 + 1), waveH);
      seg = end;
    }

    // 2. Relleno Degradado Bioluminiscente bajo la onda
    const fillSegment = (startIdx: number, endIdx: number, arrhythmia: boolean) => {
      if (!state.traceRevealed) return;
      if (endIdx <= startIdx) return;
      ctx.beginPath();
      ctx.moveTo(coords[startIdx].x, waveBaseY);
      for (let k = startIdx; k < endIdx; k++) ctx.lineTo(coords[k].x, coords[k].y);
      ctx.lineTo(coords[endIdx - 1].x, waveBaseY);
      ctx.closePath();
      const fillGrad = ctx.createLinearGradient(0, plot.y + wavePadTop, 0, waveBaseY);
      if (arrhythmia) {
        fillGrad.addColorStop(0, 'rgba(248, 113, 113, 0.22)');
        fillGrad.addColorStop(1, 'rgba(127, 29, 29, 0.01)');
      } else {
        fillGrad.addColorStop(0, 'rgba(34, 197, 94, 0.18)');
        fillGrad.addColorStop(0.5, 'rgba(6, 182, 212, 0.08)');
        fillGrad.addColorStop(1, 'rgba(34, 197, 94, 0.01)');
      }
      ctx.fillStyle = fillGrad;
      ctx.fill();
    };

    let fi = 0;
    while (fi < coords.length - 1) {
      const arrSeg = coords[fi].isArr;
      let fj = fi;
      while (fj < coords.length - 1 && coords[fj].isArr === arrSeg) fj++;
      fillSegment(fi, fj + 1, arrSeg);
      fi = fj;
    }

    // 3. Trazado Multicapa del Haz de Fósforo
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const drawDirectSegment = (startIdx: number, endIdx: number) => {
      ctx.beginPath();
      ctx.moveTo(coords[startIdx].x, coords[startIdx].y);
      for (let k = startIdx + 1; k < endIdx; k++) ctx.lineTo(coords[k].x, coords[k].y);
    };

    const totalLen = coords.length;
    const recentCut = Math.max(0, totalLen - Math.floor(totalLen * 0.40));
    const leadingCut = Math.max(0, totalLen - Math.floor(totalLen * 0.15));

    // Capa 1: Trazo Base de Fósforo
    seg = 0;
    while (seg < totalLen - 1) {
      const isArr = coords[seg].isArr;
      let segEnd = seg;
      while (segEnd < totalLen - 1 && coords[segEnd].isArr === isArr) segEnd++;
      drawDirectSegment(seg, segEnd + 1 > totalLen ? segEnd : segEnd + 1);
      ctx.strokeStyle = state.traceRevealed
        ? (isArr ? 'rgba(239, 68, 68, 0.50)' : 'rgba(34, 197, 94, 0.55)')
        : 'rgba(148, 163, 184, 0.30)';
      ctx.lineWidth = CARDIAC_WAVE_CONFIG.BASE_STROKE_WIDTH;
      ctx.stroke();
      seg = segEnd;
    }

    if (state.traceRevealed) {
      // Capa 2: Halo de Emisión Difusa (Bloom Atmosférico)
      ctx.shadowColor = COLORS.SIGNAL_GLOW;
      ctx.shadowBlur = CARDIAC_WAVE_CONFIG.SHADOW_BLUR_BASE;
      seg = Math.max(recentCut, 0);
      while (seg < totalLen - 1) {
        const isArr = coords[seg].isArr;
        let segEnd = seg;
        while (segEnd < totalLen - 1 && coords[segEnd].isArr === isArr) segEnd++;
        drawDirectSegment(seg, segEnd + 1 > totalLen ? segEnd : segEnd + 1);
        ctx.strokeStyle = isArr ? 'rgba(239, 68, 68, 0.75)' : 'rgba(74, 222, 128, 0.80)';
        ctx.lineWidth = CARDIAC_WAVE_CONFIG.GLOW_STROKE_WIDTH;
        ctx.stroke();
        seg = segEnd;
      }

      // Capa 3: Núcleo Láser Ultra-Brillante en la Cabeza Conductora (Electric Beam Core)
      ctx.shadowBlur = CARDIAC_WAVE_CONFIG.SHADOW_BLUR_LEADING;
      seg = Math.max(leadingCut, 0);
      while (seg < totalLen - 1) {
        const isArr = coords[seg].isArr;
        let segEnd = seg;
        while (segEnd < totalLen - 1 && coords[segEnd].isArr === isArr) segEnd++;
        
        // Trazo exterior brillante
        drawDirectSegment(seg, segEnd + 1 > totalLen ? segEnd : segEnd + 1);
        ctx.strokeStyle = isArr ? '#f87171' : '#86efac';
        ctx.lineWidth = CARDIAC_WAVE_CONFIG.LEADING_STROKE_WIDTH;
        ctx.shadowColor = isArr ? COLORS.SIGNAL_ARR_GLOW : COLORS.SIGNAL_GLOW;
        ctx.stroke();

        // Núcleo blanco de alta energía
        drawDirectSegment(seg, segEnd + 1 > totalLen ? segEnd : segEnd + 1);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = CARDIAC_WAVE_CONFIG.CORE_STROKE_WIDTH;
        ctx.shadowBlur = 4;
        ctx.shadowColor = '#ffffff';
        ctx.stroke();

        seg = segEnd;
      }
      ctx.shadowBlur = 0;
    } else {
      seg = Math.max(leadingCut, 0);
      if (seg < totalLen - 1) {
        drawDirectSegment(seg, totalLen);
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.65)';
        ctx.lineWidth = CARDIAC_WAVE_CONFIG.BASE_STROKE_WIDTH;
        ctx.stroke();
      }
    }

    // 4. Anillos de Sonar Concéntricos en Latido y Cursor Conductor
    const head = coords[coords.length - 1];
    if (head) {
      const pulse = Math.max(state.sweepPulse, 0.04);
      
      // Anillos concéntricos expansivos de sonar (efecto radar biométrico)
      if (state.traceRevealed && pulse > 0.12) {
        for (let rIdx = 1; rIdx <= 2; rIdx++) {
          const ringRad = 8 + pulse * (18 * rIdx);
          const ringAlpha = Math.max(0, (1 - pulse) * (0.5 / rIdx));
          ctx.beginPath();
          ctx.arc(head.x, head.y, ringRad, 0, Math.PI * 2);
          ctx.strokeStyle = head.isArr ? `rgba(239, 68, 68, ${ringAlpha})` : `rgba(0, 242, 255, ${ringAlpha})`;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }

      // Halo conductor principal
      ctx.beginPath();
      ctx.arc(head.x, head.y, CARDIAC_WAVE_CONFIG.HEAD_PULSE_BASE_RADIUS + pulse * 10, 0, Math.PI * 2);
      ctx.fillStyle = state.traceRevealed
        ? (head.isArr ? 'rgba(248, 113, 113, 0.35)' : 'rgba(0, 242, 255, 0.35)')
        : 'rgba(148, 163, 184, 0.20)';
      ctx.fill();

      // Núcleo blanco del cursor
      ctx.beginPath();
      ctx.arc(head.x, head.y, CARDIAC_WAVE_CONFIG.HEAD_PULSE_INNER_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = head.isArr ? '#ef4444' : '#00f2ff';
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // 5. Marcadores Fiduciales Holográficos de Grado Instrumentación
    if (state.traceRevealed) {
      ctx.font = `bold 8px ${FONT_MONO}`;
      for (let i = 2; i < coords.length - 2; i++) {
        const v = coords[i].val;
        const isArr = coords[i].isArr;
        const prev2 = coords[i - 2].val;
        const prev = coords[i - 1].val;
        const next = coords[i + 1].val;
        const next2 = coords[i + 2].val;

        // Pico Sistólico (SYS) con insignia de diamante y línea de caída láser
        if (v > prev && v > next && v > prev2 && v > next2 && v > midValue) {
          // Línea láser vertical hacia la baseline
          ctx.strokeStyle = isArr ? 'rgba(239, 68, 68, 0.35)' : 'rgba(0, 242, 255, 0.30)';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 4]);
          ctx.beginPath();
          ctx.moveTo(coords[i].x, coords[i].y + 6);
          ctx.lineTo(coords[i].x, plot.centerY);
          ctx.stroke();
          ctx.setLineDash([]);

          // Marcador Diamante Holográfico
          const dSize = CARDIAC_WAVE_CONFIG.SYS_PEAK_RADIUS;
          ctx.beginPath();
          ctx.moveTo(coords[i].x, coords[i].y - dSize);
          ctx.lineTo(coords[i].x + dSize, coords[i].y);
          ctx.lineTo(coords[i].x, coords[i].y + dSize);
          ctx.lineTo(coords[i].x - dSize, coords[i].y);
          ctx.closePath();
          ctx.fillStyle = isArr ? COLORS.PEAK_ARR : '#ffffff';
          ctx.shadowBlur = 10;
          ctx.shadowColor = isArr ? COLORS.PEAK_ARR : '#00f2ff';
          ctx.fill();
          ctx.shadowBlur = 0;

          // Etiqueta numérica de magnitud
          ctx.fillStyle = isArr ? COLORS.PEAK_ARR : '#00f2ff';
          ctx.textAlign = 'center';
          ctx.fillText(v.toFixed(1), coords[i].x, coords[i].y - 12);

          // Píldora HUD (SYS o ARR)
          ctx.font = `bold 7px ${FONT_MONO}`;
          ctx.fillStyle = isArr ? '#fecaca' : 'rgba(255, 255, 255, 0.85)';
          ctx.fillText(isArr ? 'ARR' : 'SYS', coords[i].x, coords[i].y - 22);
          ctx.font = `bold 8px ${FONT_MONO}`;

          if (isArr) {
            ctx.beginPath();
            ctx.arc(coords[i].x, coords[i].y, CARDIAC_WAVE_CONFIG.ARR_WARNING_RADIUS, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(239, 68, 68, 0.75)';
            ctx.lineWidth = CARDIAC_WAVE_CONFIG.ARR_WARNING_WIDTH;
            ctx.stroke();
          }
        }

        // Valle Diastólico (DIA)
        if (v < prev && v < next && v < prev2 && v < next2 && v < midValue) {
          ctx.beginPath();
          ctx.arc(coords[i].x, coords[i].y, CARDIAC_WAVE_CONFIG.DIA_VALLEY_RADIUS, 0, Math.PI * 2);
          ctx.strokeStyle = '#94a3b8';
          ctx.lineWidth = 1.2;
          ctx.stroke();

          ctx.fillStyle = '#94a3b8';
          ctx.textAlign = 'center';
          ctx.fillText(v.toFixed(1), coords[i].x, coords[i].y + 16);
          ctx.font = `7px ${FONT_MONO}`;
          ctx.fillText('DIA', coords[i].x, coords[i].y + 24);
          ctx.font = `bold 8px ${FONT_MONO}`;
        }

        // Muesca Dícrota (DIC)
        const d1_curr = v - prev;
        const d1_next = next - v;
        if (d1_curr < 0 && d1_next > d1_curr && d1_next < 0 && v > midValue) {
          ctx.beginPath();
          ctx.arc(coords[i].x, coords[i].y, CARDIAC_WAVE_CONFIG.DIC_NOTCH_RADIUS, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(103, 232, 249, 0.75)';
          ctx.fill();

          if (state.props.quality > 70) {
            ctx.font = `7px ${FONT_MONO}`;
            ctx.fillStyle = 'rgba(103, 232, 249, 0.9)';
            ctx.fillText('DIC', coords[i].x, coords[i].y - 8);
            ctx.font = `bold 8px ${FONT_MONO}`;
          }
        }
      }

      // Intervalos IBI entre picos con conectores láser
      const rrForLabels = state.props.rrIntervals ?? [];
      const validRr = rrForLabels.filter((r) => isPhysiologicalRR(r));
      const meanIbi = validRr.length > 0 ? validRr.reduce((a, v) => a + v, 0) / validRr.length : state.ibiDisplay;

      ctx.font = `bold 10px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      const visiblePeaks: { x: number; y: number; time: number }[] = [];
      for (const beat of state.beatHistory) {
        const age = state.now - beat.time - VISUAL_DELAY_MS;
        if (age > WINDOW_MS || age < 0) continue;
        const x = plot.x + plot.w - (age * plot.w / WINDOW_MS);
        if (x < plot.x || x > plot.x + plot.w) continue;
        visiblePeaks.push({ x, y: 0, time: beat.time });
      }

      for (let i = 0; i < visiblePeaks.length - 1; i++) {
        const p1 = visiblePeaks[i];
        const p2 = visiblePeaks[i + 1];
        const ibiMs = Math.abs(p2.time - p1.time);
        if (!isPhysiologicalRR(ibiMs)) continue;
        const label = ibiSegmentLabel(ibiMs, meanIbi);
        const midX = (p1.x + p2.x) / 2;
        const topY = plot.y + 40;
        ctx.strokeStyle = label.level === 'danger' ? 'rgba(248, 113, 113, 0.75)' : label.level === 'warn' ? 'rgba(245, 158, 11, 0.70)' : 'rgba(103, 232, 249, 0.60)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p1.x, topY + 6);
        ctx.lineTo(p1.x, topY);
        ctx.lineTo(p2.x, topY);
        ctx.lineTo(p2.x, topY + 6);
        ctx.stroke();
        ctx.fillStyle = levelColor(label.level);
        ctx.fillText(label.text, midX, topY - 4);
      }
    }
  } // ── fin MODO 2D ──

  // 6. Tacograma RR (IBI) con iluminación de fondo
  const tachoY = plot.y + plot.h - RR_TACHO_H + 4;
  ctx.fillStyle = 'rgba(6, 14, 28, 0.90)';
  ctx.fillRect(plot.x + 2, tachoY - 4, plot.w - 4, RR_TACHO_H);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.strokeRect(plot.x + 2, tachoY - 4, plot.w - 4, RR_TACHO_H);

  ctx.font = `bold 8px ${FONT_MONO}`;
  ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
  ctx.textAlign = 'left';
  ctx.fillText('TACHOGRAMA RR (IBI)', plot.x + 8, tachoY + 8);

  // 7. Panel de Ritmo Clínico Holográfico
  const rhythm = buildRhythmPanel(p.arrhythmiaStatus, p.arrhythmiaCount ?? 0, p.rrIntervals ?? [], state.hrv);
  const panelH = 56;
  const panelY = plot.y + 8;
  ctx.fillStyle = 'rgba(6, 14, 28, 0.90)';
  ctx.strokeStyle = rhythm.level === 'danger' ? 'rgba(239, 68, 68, 0.65)' : rhythm.level === 'warn' ? 'rgba(245, 158, 11, 0.55)' : 'rgba(34, 197, 94, 0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(plot.x + 8, panelY, Math.min(plot.w - 16, 340), panelH, 6);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.font = `bold 11px ${FONT_MONO}`;
  ctx.fillStyle = levelColor(rhythm.level);
  ctx.fillText(rhythm.title, plot.x + 16, panelY + 16);
  ctx.font = `9px ${FONT_MONO}`;
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText(rhythm.detail, plot.x + 16, panelY + 30);
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(rhythm.guidance, plot.x + 16, panelY + 44);

  // Baliza de Grabación (REC)
  if (p.isMonitoring) {
    ctx.fillStyle = 'rgba(239, 68, 68, 0.9)';
    ctx.shadowColor = '#ef4444';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(plot.x + plot.w - 42, plot.y + 18, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.fillStyle = '#fca5a5';
    ctx.textAlign = 'right';
    ctx.fillText('REC', plot.x + plot.w - 12, plot.y + 22);
  }

  ctx.font = `bold 9px ${FONT_MONO}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = '#4ade80';
  ctx.fillText(`SQI ${Math.round(p.quality)}%`, plot.x + plot.w - 12, plot.y + 38);
  ctx.fillStyle = '#67e8f9';
  ctx.fillText(`PI ${(p.perfusionIndex ?? 0).toFixed(3)}`, plot.x + plot.w - 12, plot.y + 52);
  const contact = formatContactState(p.contactState);
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(contact, plot.x + plot.w - 12, plot.y + 66);

  ctx.restore();
}

/**
 * Dibuja la barra de progreso holográfica durante la fase de adquisición / estabilización.
 */
export function drawAcquisitionOverlay(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const p = state.props;
  const diag = p.diagnostics;
  if (!p.isFingerDetected || p.preserveResults) return;
  if (state.traceRevealed) return;

  const { plot } = state.layout;
  const progress = Math.max(0, Math.min(1, diag?.acquisitionProgress ?? 0));
  const barX = plot.x + 12;
  const barW = plot.w - 24;
  const barH = 5;
  const barY = plot.y + 6;

  ctx.save();
  ctx.fillStyle = 'rgba(148, 163, 184, 0.20)';
  ctx.beginPath();
  ctx.roundRect(barX, barY, barW, barH, 2.5);
  ctx.fill();

  const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  grad.addColorStop(0, '#22c55e');
  grad.addColorStop(0.5, '#06b6d4');
  grad.addColorStop(1, '#00f2ff');
  ctx.fillStyle = grad;
  ctx.shadowColor = '#00f2ff';
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.roundRect(barX, barY, Math.max(barH, barW * progress), barH, 2.5);
  ctx.fill();
  ctx.restore();
}

/**
 * Dibuja la tira de tendencia histórica de 60s con área sombreada, zona de normalidad y punto spark.
 */
export function drawTrendStrip(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const { trend } = state.layout;
  if (trend.w < 80 || trend.h < 36) return;

  const compact = trend.h < 92;

  // Fondo Glassmorphic
  ctx.fillStyle = 'rgba(6, 14, 28, 0.90)';
  ctx.beginPath();
  ctx.roundRect(trend.x, trend.y, trend.w, trend.h, 6);
  ctx.fill();
  ctx.strokeStyle = 'rgba(34, 197, 94, 0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const data = state.bpmTrend;
  const hrv = state.hrv;
  const arrCnt = state.props.arrhythmiaCount ?? 0;

  ctx.font = `bold ${compact ? 9 : 10}px ${FONT_MONO}`;
  ctx.fillStyle = '#4ade80';
  ctx.textAlign = 'left';
  ctx.fillText(
    compact ? 'TENDENCIA BPM · 60s' : 'TENDENCIA FRECUENCIA CARDÍACA · 60 s',
    trend.x + 10,
    trend.y + (compact ? 12 : 14),
  );

  ctx.font = `8px ${FONT_MONO}`;
  ctx.fillStyle = COLORS.TEXT_DIM;
  const hrvBits: string[] = [];
  if (hrv.sdnn > 0) hrvBits.push(`SDNN ${hrv.sdnn}`);
  if (hrv.rmssd > 0) hrvBits.push(`RMSSD ${hrv.rmssd}`);
  if (arrCnt > 0) hrvBits.push(`${arrCnt} arr`);
  if (hrvBits.length > 0 && !compact) {
    ctx.fillText(hrvBits.join(' · '), trend.x + 10, trend.y + 26);
  } else if (hrvBits.length > 0) {
    ctx.textAlign = 'right';
    ctx.fillText(hrvBits.join(' · '), trend.x + trend.w - 10, trend.y + 12);
    ctx.textAlign = 'left';
  }

  if (data.length < 2) {
    ctx.font = `9px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.textAlign = 'center';
    ctx.fillText('Acumulando datos biométricos…', trend.x + trend.w / 2, trend.y + trend.h / 2 + 4);
    return;
  }

  const padTop = compact ? 24 : 32;
  const padBot = compact ? 10 : 16;
  const padL = compact ? 32 : 36;
  const padR = 8;
  const innerX = trend.x + padL;
  const innerY = trend.y + padTop;
  const innerW = trend.w - padL - padR;
  const innerH = trend.h - padTop - padBot;

  let mn = Infinity;
  let mx = -Infinity;
  let sum = 0;
  for (const point of data) {
    if (point.bpm < mn) mn = point.bpm;
    if (point.bpm > mx) mx = point.bpm;
    sum += point.bpm;
  }
  const avg = sum / data.length;
  const span = Math.max(24, mx - mn + 12);
  const yMin = Math.max(30, Math.floor((mn - 8) / 5) * 5);
  const yMax = yMin + span;

  const yToPx = (v: number) => innerY + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  // Banda de Normalidad Fisiológica (60 - 100 BPM)
  const drawBand = (lo: number, hi: number, color: string) => {
    const y1 = Math.max(innerY, yToPx(hi));
    const y2 = Math.min(innerY + innerH, yToPx(lo));
    if (y2 > y1) {
      ctx.fillStyle = color;
      ctx.fillRect(innerX, y1, innerW, y2 - y1);
    }
  };
  drawBand(60, 100, 'rgba(34, 197, 94, 0.10)');
  drawBand(yMin, 60, 'rgba(245, 158, 11, 0.06)');
  drawBand(100, yMax, 'rgba(239, 68, 68, 0.06)');

  const refLines = [
    { v: 60, label: '60', color: 'rgba(245, 158, 11, 0.65)' },
    { v: 100, label: '100', color: 'rgba(239, 68, 68, 0.55)' },
  ];
  for (const ref of refLines) {
    if (ref.v < yMin || ref.v > yMax) continue;
    const y = yToPx(ref.v);
    ctx.strokeStyle = ref.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(innerX, y);
    ctx.lineTo(innerX + innerW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `8px ${FONT_MONO}`;
    ctx.fillStyle = ref.color;
    ctx.textAlign = 'left';
    ctx.fillText(ref.label, innerX + 4, y - 3);
  }

  const tickStep = span > 50 ? 10 : 5;
  ctx.font = `9px ${FONT_MONO}`;
  ctx.fillStyle = COLORS.TEXT_DIM;
  ctx.textAlign = 'right';
  for (let v = yMin; v <= yMax; v += tickStep) {
    const y = yToPx(v);
    ctx.fillText(`${v}`, innerX - 5, y + 3);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(innerX, y);
    ctx.lineTo(innerX + innerW, y);
    ctx.stroke();
  }

  const now = Date.now();
  const tStart = now - TREND_WINDOW_MS;
  const xToPx = (t: number) => innerX + ((t - tStart) / TREND_WINDOW_MS) * innerW;

  for (let s = 0; s <= 60; s += 15) {
    const t = now - s * 1000;
    const x = xToPx(t);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.1)';
    ctx.beginPath();
    ctx.moveTo(x, innerY);
    ctx.lineTo(x, innerY + innerH);
    ctx.stroke();
    ctx.font = `8px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.textAlign = 'center';
    ctx.fillText(s === 0 ? 'ahora' : `−${s}s`, x, innerY + innerH + (compact ? 9 : 12));
  }

  const coords: { x: number; y: number; isArr: boolean }[] = data.map((point) => ({
    x: xToPx(point.t),
    y: yToPx(point.bpm),
    isArr: point.isArr,
  }));

  // Área sombreada con degradado
  ctx.beginPath();
  ctx.moveTo(coords[0].x, innerY + innerH);
  for (const c of coords) ctx.lineTo(c.x, c.y);
  ctx.lineTo(coords[coords.length - 1].x, innerY + innerH);
  ctx.closePath();
  const areaGrad = ctx.createLinearGradient(0, innerY, 0, innerY + innerH);
  areaGrad.addColorStop(0, 'rgba(34, 197, 94, 0.28)');
  areaGrad.addColorStop(1, 'rgba(34, 197, 94, 0.02)');
  ctx.fillStyle = areaGrad;
  ctx.fill();

  // Curva de tendencia suavizada
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  let seg = 0;
  while (seg < coords.length - 1) {
    const isArr = coords[seg].isArr;
    let end = seg;
    while (end < coords.length - 1 && coords[end + 1].isArr === isArr) end++;
    ctx.beginPath();
    ctx.moveTo(coords[seg].x, coords[seg].y);
    for (let k = seg; k < end; k++) {
      const xc = (coords[k].x + coords[k + 1].x) / 2;
      const yc = (coords[k].y + coords[k + 1].y) / 2;
      ctx.quadraticCurveTo(coords[k].x, coords[k].y, xc, yc);
    }
    ctx.lineTo(coords[end].x, coords[end].y);
    ctx.strokeStyle = isArr ? COLORS.SIGNAL_ARR : '#22c55e';
    ctx.lineWidth = isArr ? 2.4 : 2;
    ctx.shadowColor = isArr ? COLORS.SIGNAL_ARR_GLOW : '#22c55e';
    ctx.shadowBlur = isArr ? 8 : 6;
    ctx.stroke();
    seg = end + 1;
  }
  ctx.shadowBlur = 0;

  // Punto spark más reciente con resplandor pulsátil
  const lastPoint = coords[coords.length - 1];
  if (lastPoint) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(lastPoint.x, lastPoint.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = lastPoint.isArr ? COLORS.SIGNAL_ARR : '#00f2ff';
    ctx.shadowColor = lastPoint.isArr ? COLORS.SIGNAL_ARR : '#00f2ff';
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.restore();
  }

  const avgY = yToPx(avg);
  ctx.strokeStyle = 'rgba(103, 232, 249, 0.6)';
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(innerX, avgY);
  ctx.lineTo(innerX + innerW, avgY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `8px ${FONT_MONO}`;
  ctx.fillStyle = COLORS.TEXT_INFO;
  ctx.textAlign = 'right';
  ctx.fillText(`media ${Math.round(avg)}`, innerX + innerW - 4, avgY - 4);

  ctx.font = `9px ${FONT_MONO}`;
  ctx.fillStyle = COLORS.TEXT_DIM;
  ctx.textAlign = 'left';
  ctx.fillText(
    `min ${Math.round(mn)} · max ${Math.round(mx)}`,
    innerX,
    trend.y + trend.h - 4,
  );
  if (!compact) {
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(251, 113, 133, 0.85)';
    ctx.fillText('● arrítmico', innerX + innerW, trend.y + trend.h - 4);
  }
}

/**
 * Dibuja el pie de página con métricas avanzadas de HRV, alarmas y tira de latidos recientes.
 */
export function drawFooter(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const { footer } = state.layout;
  const { bpm, spo2, pressure, perfusionIndex: pi } = state.props;

  ctx.fillStyle = 'rgba(6, 14, 28, 0.95)';
  ctx.fillRect(footer.x, footer.y, footer.w, footer.h);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.beginPath();
  ctx.moveTo(0, footer.y);
  ctx.lineTo(footer.w, footer.y);
  ctx.stroke();

  const hrv = state.hrv;
  ctx.font = `bold 10px ${FONT_MONO}`;
  ctx.fillStyle = 'rgba(103, 232, 249, 0.9)';
  ctx.textAlign = 'left';
  ctx.fillText('HRV', footer.x + 12, footer.y + 14);

  const cells = [
    { label: 'IBI', value: state.ibiDisplay > 0 ? `${state.ibiDisplay}ms` : '--', color: COLORS.TEXT_INFO },
    { label: 'SDNN', value: hrv.sdnn > 0 ? `${hrv.sdnn}ms` : '--', color: '#cbd5e1' },
    { label: 'RMSSD', value: hrv.rmssd > 0 ? `${hrv.rmssd}ms` : '--', color: '#cbd5e1' },
    { label: 'pNN50', value: hrv.pnn50 > 0 ? `${hrv.pnn50}%` : '--', color: '#cbd5e1' },
    { label: 'CV', value: hrv.cv > 0 ? hrv.cv.toFixed(2) : '--', color: '#cbd5e1' },
  ];

  const hrvSectionWidth = footer.w * 0.55;
  const cellW = hrvSectionWidth / cells.length;
  cells.forEach((c, i) => {
    const cx = footer.x + 12 + i * cellW;
    ctx.font = `8px ${FONT_MONO}`;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.8)';
    ctx.textAlign = 'left';
    ctx.fillText(c.label, cx, footer.y + 24);
    ctx.font = `bold 11px ${FONT_MONO}`;
    ctx.fillStyle = c.color;
    ctx.fillText(c.value, cx, footer.y + 38);
  });

  const map = pressure?.systolic && pressure?.diastolic
    ? Math.round(pressure.diastolic + (pressure.systolic - pressure.diastolic) / 3)
    : 0;
  const alarms: string[] = [];
  if (bpm != null && bpm > 0 && (bpm < 50 || bpm > 120)) alarms.push('HR');
  if (spo2 > 0 && spo2 < 92) alarms.push('SpO₂');
  if (map > 0 && (map < 65 || map > 110)) alarms.push('MAP');
  if (pi > 0 && pi < 0.005) alarms.push('PI');

  ctx.textAlign = 'right';
  if (alarms.length > 0) {
    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DANGER;
    ctx.fillText(`⚠ ALARMA: ${alarms.join(' · ')}`, footer.x + footer.w - 12, footer.y + 16);
  } else if (bpm != null && bpm > 0) {
    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.fillStyle = '#4ade80';
    ctx.fillText('● SIN ALARMAS', footer.x + footer.w - 12, footer.y + 16);
  }

  const beats = state.beatHistory;
  if (beats.length > 0) {
    const showN = Math.min(beats.length, 18);
    const dotSize = 3;
    const gap = 3;
    const totalW = showN * (dotSize * 2 + gap) - gap;
    const startX = footer.x + footer.w - 12 - totalW;
    const dy = footer.y + 36;
    for (let i = 0; i < showN; i++) {
      const beat = beats[beats.length - showN + i];
      const cx = startX + i * (dotSize * 2 + gap) + dotSize;
      ctx.beginPath();
      ctx.arc(cx, dy, dotSize, 0, Math.PI * 2);
      ctx.fillStyle = beat.isArrhythmia ? COLORS.SIGNAL_ARR : '#22c55e';
      ctx.fill();
    }
    ctx.font = `8px ${FONT_MONO}`;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.8)';
    ctx.textAlign = 'right';
    const arrCount = beats.filter(b => b.isArrhythmia).length;
    ctx.fillText(`Últimos ${showN} · N:${beats.length - arrCount} A:${arrCount}`, footer.x + footer.w - 12, dy + 14);
  }
}
