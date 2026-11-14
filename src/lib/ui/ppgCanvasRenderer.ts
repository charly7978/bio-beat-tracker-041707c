import { traceMeasuredPath } from './measuredTrace';
import { CircularBuffer } from '../../utils/CircularBuffer';
import { isPhysiologicalRR } from '../../utils/physio';
import { buildRhythmPanel } from './ppgMonitorClinical';
import { drawWaveRibbon3D } from './ppg3dProjection';

export const FONT_MONO = '"SF Mono", Consolas, "Roboto Mono", monospace';

export const COLORS = {
  BG_TOP: '#06090f',
  BG_BOTTOM: '#020409',
  PANEL_BG: 'rgba(10, 18, 30, 0.92)',
  PANEL_BORDER: 'rgba(104, 221, 192, 0.32)',
  PANEL_BORDER_DIM: 'rgba(148, 163, 184, 0.18)',
  GRID_MINOR: 'rgba(137, 165, 180, 0.075)',
  GRID_MAJOR: 'rgba(137, 165, 180, 0.15)',
  GRID_SEC: 'rgba(137, 165, 180, 0.20)',
  SCANLINE: 'rgba(255, 255, 255, 0.012)',
  BASELINE: 'rgba(255, 255, 255, 0.25)',
  SIGNAL: '#68ddc0',
  SIGNAL_GLOW: 'rgba(104, 221, 192, 0.22)',
  SIGNAL_ARR: '#ef4444',
  SIGNAL_ARR_GLOW: 'rgba(239, 68, 68, 0.45)',
  PEAK_NORMAL: '#83cce4',
  PEAK_ARR: '#ef4444',
  VALLEY: '#64748b',
  TEXT_PRIMARY: '#80e3ca',
  TEXT_SECONDARY: '#94a3b8',
  TEXT_DIM: 'rgba(255, 255, 255, 0.6)',
  TEXT_WARN: '#f59e0b',
  TEXT_DANGER: '#ef4444',
  TEXT_INFO: '#67e8f9',
  TEXT_VIOLET: '#a78bfa',
  SPO2: '#06b6d4',
  BP: '#818cf8',
};

/**
 * TABLA DE CONSTANTES CONFIGURABLES PARA LAS ONDAS CARDÃACAS (PPG MONITOR)
 * 
 * Modifica estos valores para calibrar detalladamente la visualizaciÃ³n de la onda
 * y ajustar el comportamiento de los trazos, brillo, auto-escala y marcadores fiduciales.
 */
export const CARDIAC_WAVE_CONFIG = {
  // === Ventana de Tiempo e Historial ===
  /**
   * Ventana de tiempo visualizada en pantalla en milisegundos.
   * - Â¿QuÃ© significa?: El lapso de tiempo fÃ­sico de seÃ±al representado de izquierda a derecha.
   * - Si se sube (ej. 2500 - 3500): La onda se comprime horizontalmente (se ven mÃ¡s ciclos en pantalla, dando un aspecto veloz o de "lÃ¡tigo").
   * - Si se baja (ej. 1500 - 2000): La onda se estira horizontalmente (se ven menos ciclos, dibujo lento y detallado).
   */
  WINDOW_MS: 2200,

  /**
   * Capacidad del buffer circular de almacenamiento de seÃ±al.
   * - Â¿QuÃ© significa?: Cantidad de muestras histÃ³ricas mÃ¡ximas guardadas para dibujar en el Canvas.
   * - Si se sube: Retiene mÃ¡s muestras histÃ³ricas de la seÃ±al (evita cortes visuales si la tasa de muestreo sube).
   * - Si se baja: Reduce el uso de memoria RAM, pero si se baja demasiado la onda podrÃ­a truncarse.
   */
  BUFFER_SIZE: 2500,

  /**
   * Retraso visual de renderizado en milisegundos.
   * - Â¿QuÃ© significa?: Tiempo de espera artificial antes de graficar la seÃ±al entrante.
   * - Si se sube: La onda tarda mÃ¡s en aparecer en el grÃ¡fico, desfasÃ¡ndola hacia el pasado.
   * - Si se baja: La onda se dibuja de forma mÃ¡s instantÃ¡nea y reactiva en tiempo real.
   */
  VISUAL_DELAY_MS: 0,

  // === Auto-escala de Amplitud (Ajuste dinÃ¡mico Y) ===
  /**
   * Coeficiente de ataque (crecimiento) del escalado automÃ¡tico de amplitud.
   * - Â¿QuÃ© significa?: QuÃ© tan rÃ¡pido se expande la escala vertical cuando la seÃ±al de entrada aumenta de tamaÃ±o.
   * - Si se sube: La onda se adapta instantÃ¡neamente a picos de gran amplitud (evita que se corte por arriba/abajo).
   * - Si se baja: La onda cambia su tamaÃ±o vertical mÃ¡s despacio, suavizando transiciones bruscas.
   */
  AMP_ATTACK: 0.50,

  /**
   * Coeficiente de relajaciÃ³n (decrecimiento) del escalado automÃ¡tico de amplitud.
   * - Â¿QuÃ© significa?: QuÃ© tan rÃ¡pido se contrae la escala vertical cuando la amplitud de la seÃ±al decae.
   * - Si se sube: La onda recupera tamaÃ±o visual de forma veloz cuando la seÃ±al de entrada se debilita.
   * - Si se baja: Mantiene la escala amplia por mÃ¡s tiempo, evitando vibraciones molestas si la amplitud fluctÃºa.
   */
  AMP_RELEASE: 0.30,

  // === EstÃ©tica y Grosor de LÃ­nea (Canvas Rendering) ===
  /**
   * Grosor de la lÃ­nea principal de la onda.
   * - Â¿QuÃ© significa?: El ancho en pÃ­xeles del trazo base de la seÃ±al.
   * - Si se sube: Onda mÃ¡s gruesa, densa y visible en pantallas de alta densidad de pÃ­xeles.
   * - Si se baja: Onda mÃ¡s fina, nÃ­tida y con un look clÃ­nico o mÃ©dico de alta precisiÃ³n (efecto "elÃ©ctrico").
   */
  BASE_STROKE_WIDTH: 2.0,

  /**
   * Grosor de la lÃ­nea de brillo secundaria.
   */
  GLOW_STROKE_WIDTH: 1.6,

  /**
   * Grosor de la punta o cabeza de la onda de barrido.
   */
  LEADING_STROKE_WIDTH: 1.5,

  /**
   * Desenfoque de sombra del cuerpo de la seÃ±al (Glow).
   */
  SHADOW_BLUR_BASE: 3,

  /**
   * Desenfoque de sombra de la punta o cabeza conductora de la seÃ±al.
   */
  SHADOW_BLUR_LEADING: 5,

  // === Marcadores FisiolÃ³gicos (Fiduciales) ===
  /**
   * Radio del punto indicador del Pico SistÃ³lico (SYS).
   * - Â¿QuÃ© significa?: TamaÃ±o del cÃ­rculo cian en el punto mÃ¡ximo de cada latido.
   * - Si se sube: CÃ­rculos marcadores sistÃ³licos mÃ¡s grandes y fÃ¡ciles de identificar.
   * - Si se baja: CÃ­rculos mÃ¡s pequeÃ±os y discretos en los picos.
   */
  SYS_PEAK_RADIUS: 3.5,

  /**
   * Radio del indicador del Valle DiastÃ³lico (DIA).
   * - Â¿QuÃ© significa?: DiÃ¡metro del anillo gris de marcaciÃ³n en el punto mÃ­nimo del latido.
   * - Si se sube: Marcador diastÃ³lico mÃ¡s grande y visible.
   * - Si se baja: Marcador diastÃ³lico mÃ¡s diminuto.
   */
  DIA_VALLEY_RADIUS: 2.4,

  /**
   * Radio del indicador de la Muesca DÃ­crota (DIC).
   * - Â¿QuÃ© significa?: TamaÃ±o del punto cian claro que resalta el rebote elÃ¡stico aÃ³rtico.
   * - Si se sube: Marcador de muesca dÃ­crota mÃ¡s grande y notorio.
   * - Si se baja: Marcador mÃ¡s imperceptible y minimalista.
   */
  DIC_NOTCH_RADIUS: 2.4,

  /**
   * Radio del anillo de alarma rojo para latidos con arritmia (ARR).
   * - Â¿QuÃ© significa?: El diÃ¡metro del cÃ­rculo exterior rojo que envuelve los picos anÃ³malos.
   * - Si se sube: El anillo se expande mÃ¡s lejos de la coordenada del pico.
   * - Si se baja: El anillo abraza estrechamente y de cerca el pico con arritmia.
   */
  ARR_WARNING_RADIUS: 10.0,

  /**
   * Grosor de la lÃ­nea del anillo de advertencia de arritmia.
   * - Â¿QuÃ© significa?: Ancho del trazo circular de alerta roja.
   * - Si se sube: Anillo mÃ¡s grueso, visible y alarmante.
   * - Si se baja: Anillo rojo mÃ¡s fino y discreto.
   */
  ARR_WARNING_WIDTH: 1.5,

  // === Cursor Conductor (Punta de Barrido) ===
  /**
   * Radio base del halo pulsÃ¡til que sigue a la punta del barrido.
   * - Â¿QuÃ© significa?: El tamaÃ±o base del cÃ­rculo que late al ritmo del pulso al frente del barrido.
   * - Si se sube: Aura de barrido de mayor tamaÃ±o y dinamismo.
   * - Si se baja: Aura pequeÃ±a y compacta en el extremo del trazado.
   */
  HEAD_PULSE_BASE_RADIUS: 6.0,

  /**
   * Radio del nÃºcleo central blanco en la punta conductora del barrido.
   */
  HEAD_PULSE_INNER_RADIUS: 3.0,

  // === MÃ¡rgenes y LÃ­mites de Dibujo ===
  /**
   * Margen superior de la onda en el grÃ¡fico.
   * - Â¿QuÃ© significa?: Espacio vacÃ­o superior en pÃ­xeles para que la onda no solape los textos superiores del monitor.
   * - Si se sube: Desplaza la onda hacia abajo, comprimiendo el Ã¡rea Ãºtil de dibujo.
   * - Si se baja: Permite que la onda se desplace mÃ¡s arriba en pantalla.
   */
  WAVE_PAD_TOP: 14,

  /**
   * Margen inferior de la onda en el grÃ¡fico.
   * - Â¿QuÃ© significa?: Espacio vacÃ­o inferior en pÃ­xeles antes del tacograma para evitar solapamientos.
   * - Si se sube: Comprime la onda hacia arriba, alejÃ¡ndola del tacograma.
   * - Si se baja: Permite que los valles de la onda bajen mÃ¡s cerca de la secciÃ³n del tacograma.
   */
  WAVE_PAD_BOTTOM: 41,

  // === Tiempos de ReacciÃ³n y Velocidades DinÃ¡micas ===
  /**
   * Velocidad de amortiguaciÃ³n (desvanecimiento) de la punta conductora tras cada latido.
   * - Â¿QuÃ© significa?: Factor multiplicador por cuadro que reduce el tamaÃ±o del halo del cursor (sweepPulse).
   * - Si se sube: El halo brillante de la punta se apaga mÃ¡s lentamente, dejando un rastro luminoso mÃ¡s largo.
   * - Si se baja: El halo se apaga de forma abrupta y veloz.
   */
  SWEEP_PULSE_DECAY: 0.90,

  /**
   * Tiempo de rebote (debounce) mÃ­nimo entre picos registrados en milisegundos.
   * - Â¿QuÃ© significa?: El tiempo de espera mÃ­nimo necesario para procesar visualmente el siguiente latido y evitar falsas detecciones duplicadas.
   * - Si se sube: Evita falsos picos por ruido, pero puede ignorar latidos reales si la frecuencia cardÃ­aca es extremadamente alta (taquicardia).
   * - Si se baja: Aumenta la sensibilidad ante frecuencias altas, pero puede duplicar marcas visuales en un solo latido.
   */
  PEAK_DEBOUNCE_MS: 250,

  /**
   * Intervalo RR (IBI) por defecto utilizado cuando no hay mediciones previas.
   * - Â¿QuÃ© significa?: El valor base de intervalo entre latidos en milisegundos para inicializar cÃ¡lculos de ritmo.
   * - Si se sube: La duraciÃ³n de la ventana de anÃ¡lisis inicial es mayor.
   * - Si se baja: La duraciÃ³n de la ventana inicial es menor.
   */
  DEFAULT_RR_INTERVAL_MS: 800,

  /**
   * LÃ­mite de duraciÃ³n fisiolÃ³gica mÃ­nimo para el cÃ¡lculo de alineaciÃ³n de arritmias en milisegundos.
   * - Â¿QuÃ© significa?: El intervalo RR mÃ­nimo aceptado en el mapeo visual de la alerta.
   * - Si se sube: Agranda el intervalo mÃ­nimo a marcar.
   * - Si se baja: Permite marcar anomalÃ­as extremadamente rÃ¡pidas.
   */
  MIN_ARR_DURATION_MS: 400,

  /**
   * LÃ­mite de duraciÃ³n fisiolÃ³gica mÃ¡ximo para el cÃ¡lculo de alineaciÃ³n de arritmias en milisegundos.
   * - Â¿QuÃ© significa?: El intervalo RR mÃ¡ximo aceptado en el mapeo visual de la alerta.
   * - Si se sube: Permite que las marcas de arritmia persistan en el tiempo de manera prolongada.
   * - Si se baja: Acorta el tiempo mÃ¡ximo en pantalla que dura el trazo rojo.
   */
  MAX_ARR_DURATION_MS: 1500,

  /**
   * Factor de alineaciÃ³n retrÃ³grada para el marcado de arritmias.
   * - Â¿QuÃ© significa?: La proporciÃ³n del intervalo RR que se pinta de rojo hacia atrÃ¡s en el tiempo a partir del pico detectado.
   * - Si se sube: La alerta roja abarca una porciÃ³n mayor del trazado de la onda antes del pico.
   * - Si se baja: La alerta se concentra solo sobre el pico o ligeramente despuÃ©s.
   */
  ARR_RETRO_ALIGN_FACTOR: 0.35,

  /**
   * Factor de alineaciÃ³n anterÃ³grada para el marcado de arritmias.
   * - Â¿QuÃ© significa?: La proporciÃ³n del intervalo RR que la alerta roja se mantiene activa hacia adelante en el tiempo a partir del pico.
   * - Si se sube: El color rojo de la alerta persiste durante mÃ¡s tiempo en el barrido que se desplaza.
   * - Si se baja: El color rojo desaparece rÃ¡pidamente despuÃ©s de que pasa el pico.
   */
  ARR_ANTERO_ALIGN_FACTOR: 1.65,

  /**
   * Exponente de agudeza visual para controlar la velocidad de subida y bajada de la onda.
   * - Â¿QuÃ© significa?: DistorsiÃ³n no-lineal matemÃ¡tica aplicada exclusivamente al trazado del Canvas.
   * - Si se sube (ej. 1.3 - 1.7): Hace que la subida al pico sistÃ³lico y la caÃ­da posterior sean visualmente mucho mÃ¡s rÃ¡pidas y agudas (efecto "lÃ¡tigo" o "relÃ¡mpago").
   * - Si se baja (ej. 1.0): La onda se grafica de forma 100% lineal y fiel a la fisiologÃ­a pura sin distorsiÃ³n.
   * - Â¡ATENCIÃ“N!: Esta constante es 100% visual y estÃ©tica. No afecta la lÃ³gica interna de captaciÃ³n de latidos ni las matemÃ¡ticas mÃ©dicas del procesador, por lo que es totalmente seguro calibrarla sin alterar la detecciÃ³n de pulso.
   */
  WAVE_SHARPNESS_EXPONENT: 1,
};

// Exportaciones individuales para mantener compatibilidad total con componentes importadores externos (como PPGSignalMeter.tsx)
export const TARGET_FPS = 60;
export const WINDOW_MS = CARDIAC_WAVE_CONFIG.WINDOW_MS;
export const BUFFER_SIZE = CARDIAC_WAVE_CONFIG.BUFFER_SIZE;
export const TREND_WINDOW_MS = 60_000;
export const TREND_MAX_POINTS = 240;
export const BEAT_HISTORY_MAX = 30;
export const VISUAL_DELAY_MS = CARDIAC_WAVE_CONFIG.VISUAL_DELAY_MS;
export const AMP_ATTACK = CARDIAC_WAVE_CONFIG.AMP_ATTACK;
export const AMP_RELEASE = CARDIAC_WAVE_CONFIG.AMP_RELEASE;
export const RR_TACHO_H = 34;

export interface PpgLayout {
  /** En horizontal, la captura tiene su propio espacio junto a los canales. */
  capturePreview?: { x: number; y: number; w: number; h: number };
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
  respirationRate?: number;
  respirationStatus?: string;
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
    /** Modelo único de presión (presión transmural): gauge, guía y hápticos. */
    placementEvidence?: import('../finger/fingerPlacementEvidence').FingerPlacementEvidence;
    hasPulsatility?: boolean;
    acquisitionStage?: 'SEARCHING' | 'STABILIZING' | 'READY';
    acquisitionProgress?: number;
    /** Región observada en las coordenadas reales del cuadro de procesamiento. */
    roi?: { x: number; y: number; width: number; height: number };
    frameSize?: { width: number; height: number };
    sqm?: { fpsEffective?: number; timestampJitterMs?: number; underexposureRatio?: number; saturationRatio?: number; motionScore?: number; frameDropRatio?: number };
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
  windowMs?: number;
  reducedMotion?: boolean;
  showAnnotations?: boolean;
  inspection?: { buffer: CircularBuffer; endMs: number; cursorFraction?: number; stats: AmplitudeStats; strength: number; traceRevealed: boolean };
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
  /** Latch: la onda solo se revela cuando la seÃ±al se ESTABILIZÃ“ (adquisiciÃ³n READY). */
  traceRevealed: boolean;
  /** Fuerza pulsÃ¡til real [0..1]: comprime la altura de la onda (objeto inerte â†’ plana). */
  signalStrength: number;
  /**
   * Capa de presentaciÃ³n 3D (perspectiva pura en canvas 2D). Si `enabled`, la grilla
   * se dibuja como piso en perspectiva y la onda como cinta extruida. La onda reusa
   * las MISMAS coords honestas â†’ misma forma/amplitud/tiempo que el modo 2D.
   */
  threeD?: { enabled: boolean; intensity?: number };
}

/** Reduce sólo el tamaño tipográfico: nunca recorta una lectura ni sus unidades. */
function fitLabel(ctx: CanvasRenderingContext2D, text: string, width: number, size: number, weight = '500'): void {
  ctx.font = `${weight} ${size}px ${FONT_MONO}`;
  const measured = ctx.measureText(text).width;
  if (measured > width && measured > 0) ctx.font = `${weight} ${size * width / measured}px ${FONT_MONO}`;
}

export function drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const background = ctx.createLinearGradient(0, 0, W, H);
  background.addColorStop(0, '#0d1c29');
  background.addColorStop(0.45, '#070f1b');
  background.addColorStop(1, '#040a12');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, H);
  // Iluminación estática de la superficie: no introduce actividad fisiológica.
  const light = ctx.createRadialGradient(W * .28, H * .35, 0, W * .28, H * .35, Math.max(W, H) * .7);
  light.addColorStop(0, 'rgba(40, 119, 131, 0.085)');
  light.addColorStop(1, 'rgba(40, 119, 131, 0)');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, W, H);
}

export function drawHeader(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const { header } = state.layout;
  const wide = header.w >= 1024;
  const brandY = wide ? 29 : 23;
  ctx.save();
  ctx.fillStyle = 'rgba(7,16,26,0.8)';
  ctx.fillRect(0, 0, header.w, header.h);
  ctx.strokeStyle = 'rgba(139,191,205,0.13)';
  ctx.beginPath(); ctx.moveTo(16, header.h - .5); ctx.lineTo(header.w - 16, header.h - .5); ctx.stroke();
  ctx.fillStyle = COLORS.TEXT_PRIMARY;
  for (let i = 0; i < 4; i++) {
    const h = [8, 20, 13, 8][i];
    ctx.fillRect(18 + i * 5, brandY - h + 2, 2, h);
  }
  ctx.textAlign = 'left';
  ctx.font = `600 ${wide ? 17 : 14}px system-ui, sans-serif`;
  ctx.fillStyle = '#edf6fa';
  ctx.fillText('BIO / BEAT', 46, brandY);
  ctx.font = `10px ${FONT_MONO}`;
  ctx.fillStyle = '#95adbf';
  ctx.fillText('MONITOR ÓPTICO', 46, brandY + 16);
  if (state.layout.metrics.h > 0) {
    const t = Math.max(0, Math.floor(state.props.elapsedTime || 0));
    const time = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    const status = state.props.isMonitoring ? time : state.props.preserveResults ? 'REGISTRO' : 'LISTO';
    const x = Math.min(header.w - 112, wide ? header.w * .5 : header.w * .57);
    ctx.textAlign = 'center';
    ctx.fillStyle = state.props.isMonitoring ? COLORS.TEXT_PRIMARY : '#a3b9c9';
    ctx.font = `500 ${wide ? 14 : 11}px ${FONT_MONO}`;
    ctx.fillText(status, x, wide ? 30 : 30);
    if (wide) {
      ctx.font = `10px ${FONT_MONO}`;
      ctx.fillStyle = '#8ca4b7';
      ctx.fillText(state.props.isMonitoring ? 'SESIÓN EN CURSO' : 'CAPTURA POR CÁMARA', x, 48);
    }
  }
  ctx.restore();
}

export function drawMetricsBar(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const { metrics } = state.layout;
  const stacked = metrics.w <= 240 && metrics.h > 250;
  const rr = state.props.respirationRate ?? 0;
  const readings = [
    { label: 'PULSO', short: 'PULSO', value: state.displayBpm > 0 ? String(state.displayBpm) : '—', unit: 'BPM', color: COLORS.TEXT_PRIMARY, note: 'Frecuencia del pulso' },
    { label: 'SpO₂ · EXPERIMENTAL', short: 'SpO₂ EXP.', value: state.displaySpo2 > 0 ? String(state.displaySpo2) : '—', unit: '%', color: '#88d8ed', note: 'Sin validación clínica' },
    { label: 'PRESIÓN · EXPERIMENTAL', short: 'PA EXP.', value: state.displaySys > 0 && state.displayDia > 0 ? `${state.displaySys}/${state.displayDia}` : '—/—', unit: 'mmHg', color: '#bdbaf6', note: state.props.bpStatus === 'REQUIRES_CALIBRATION' || state.props.bpStatus === 'CALIBRATION_EXPIRED' ? 'Requiere calibración' : 'Sin validación clínica' },
    { label: 'RESPIRACIÓN', short: 'RESP.', value: rr > 0 ? String(Math.round(rr)) : '—', unit: 'rpm', color: '#d0e0ed', note: rr > 0 ? 'Estimación desde PPG' : state.props.isMonitoring ? 'Adquiriendo señal' : 'En espera' },
  ];
  ctx.save();
  ctx.textAlign = 'left';
  if (metrics.h === 0) {
    // En horizontal bajo, las lecturas comparten cabecera con marca y acciones.
    const start = 190;
    const available = Math.max(240, metrics.w - start - 108);
    const width = available / 4;
    readings.forEach((r, i) => {
      const x = start + i * width;
      ctx.fillStyle = '#b1c6d4';
      fitLabel(ctx, r.short, width - 8, 10);
      ctx.fillText(r.short, x, 17);
      ctx.fillStyle = r.value.startsWith('—') ? '#7f96aa' : r.color;
      fitLabel(ctx, `${r.value} ${r.unit}`, width - 8, i === 2 ? 15 : 17);
      ctx.fillText(`${r.value} ${r.unit}`, x, 39);
    });
    ctx.restore();
    return;
  }
  const gap = stacked ? 10 : 5;
  const xInset = stacked ? 0 : 12;
  const cardW = stacked ? metrics.w : (metrics.w - xInset * 2 - gap * 3) / 4;
  const cardH = stacked ? (metrics.h - gap * 3) / 4 : metrics.h - 8;
  readings.forEach((r, i) => {
    const x = metrics.x + xInset + (stacked ? 0 : i * (cardW + gap));
    const y = metrics.y + (stacked ? i * (cardH + gap) : 4);
    const pad = stacked ? 16 : 7;
    ctx.fillStyle = 'rgba(19,35,50,0.75)';
    ctx.beginPath(); ctx.roundRect(x, y, cardW, cardH, stacked ? 12 : 8); ctx.fill();
    ctx.strokeStyle = 'rgba(135,177,199,0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = r.color;
    ctx.fillRect(x + pad, y + (stacked ? 15 : 10), 2, stacked ? 12 : 7);
    const label = stacked ? r.label : r.short;
    ctx.fillStyle = '#b4c9d8';
    fitLabel(ctx, label, cardW - pad * 2 - 7, stacked ? 10 : 9);
    ctx.fillText(label, x + pad + 7, y + (stacked ? 25 : 16));
    const valueSize = stacked ? (i === 2 ? 34 : 48) : (i === 2 ? 21 : 28);
    const valueY = y + (stacked ? Math.min(cardH - 39, 82) : cardH < 60 ? 39 : 43);
    fitLabel(ctx, r.value, cardW - pad * 2, valueSize, '500');
    ctx.fillStyle = r.value.startsWith('—') ? '#7a92a6' : r.color;
    ctx.fillText(r.value, x + pad, valueY);
    ctx.font = `10px ${FONT_MONO}`;
    ctx.fillStyle = '#a1bacb';
    ctx.fillText(r.unit, x + pad, y + (stacked ? Math.min(cardH - 23, 102) : cardH - 6));
    if (stacked && cardH >= 110) {
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#91a9bd';
      ctx.fillText(r.note, x + pad, y + cardH - 12);
    }
  });
  ctx.restore();
}

export function drawECGGrid(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const { plot } = state.layout;

  const grad = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
  grad.addColorStop(0, 'rgba(6, 12, 22, 0.25)');
  grad.addColorStop(0.5, 'rgba(10, 18, 30, 0.18)');
  grad.addColorStop(1, 'rgba(6, 12, 22, 0.25)');
  ctx.fillStyle = grad;
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

  const pxPerMm = Math.max(5, Math.min(10, plot.h / 25));
  const minor = pxPerMm;
  const major = pxPerMm * 5;

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

  const windowMs = state.windowMs ?? WINDOW_MS;
  const oneSec = plot.w * 1000 / windowMs;
  ctx.strokeStyle = COLORS.GRID_SEC;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let x = plot.x + plot.w; x >= plot.x; x -= oneSec) {
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
  }
  ctx.stroke();

  ctx.strokeStyle = COLORS.BASELINE;
  ctx.lineWidth = 1;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(plot.x, plot.centerY);
  ctx.lineTo(plot.x + plot.w, plot.centerY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = COLORS.PANEL_BORDER;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);

  const seconds = Math.floor(windowMs / 1000);
  ctx.font = `bold 10px ${FONT_MONO}`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  for (let s = 0; s <= seconds; s++) {
    const x = plot.x + plot.w - (s * 1000 / windowMs) * plot.w;
    ctx.textAlign = s === 0 ? 'right' : s === seconds ? 'left' : 'center';
    ctx.fillText(s === 0 ? '0 s' : `−${s} s`, x, plot.y + plot.h + 14);
  }

  const stats = state.amplitudeStats;
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 10px ${FONT_MONO}`;
  ctx.textAlign = 'left';
  for (let i = 0; i <= 4; i++) {
    const y = plot.y + (i / 4) * plot.h;
    const val = stats.max - (i / 4) * stats.range;
    ctx.fillText(val.toFixed(0), plot.x + 8, y + 4);
  }

  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.TEXT_DIM;
  ctx.font = `bold 10px ${FONT_MONO}`;
  ctx.fillText(`${(windowMs / 1000).toFixed(1)} s · amplitud relativa`, plot.x + 8, plot.y - 6);

}

/**
 * GAUGE DE PRESIÓN TRANSMURAL.
 *
 * Debe dibujarse DESPUÉS de `drawSignal`: hasta ahora se pintaba antes y la
 * onda lo tapaba, así que el usuario nunca veía la guía.
 *
 * Ya no se limita a pintar una etiqueta fija por veredicto: usa `guidance`
 * (la MISMA decisión que alimenta el háptico) y muestra las dos magnitudes
 * físicas que el modelo mide — sellado de lente y blanqueo capilar — para que
 * el usuario entienda por qué se le pide ajustar.
 */
export function drawPressureGauge(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  // La guía ergonómica de presión reside de forma nítida en el componente React PressureCoach.
  // En el canvas mantenemos una barra lineal discreta en la base del gráfico.
  const p = state.props;
  const evidence = p.diagnostics?.placementEvidence;
  if (!evidence || evidence.pressure === 'NONE' || !p.isMonitoring) return;

  const { plot } = state.layout;
  const score = typeof evidence.pressureScore === 'number'
    ? Math.max(0, Math.min(1, evidence.pressureScore))
    : 0.5;

  const barW = Math.min(180, plot.w * 0.4);
  const barH = 3;
  const barX = plot.x + (plot.w - barW) / 2;
  const barY = plot.y + plot.h - 6;

  ctx.save();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.6)';
  ctx.fillRect(barX, barY, barW, barH);

  // Zona objetivo
  ctx.fillStyle = 'rgba(104, 221, 192, 0.5)';
  ctx.fillRect(barX + barW * 0.44, barY, barW * 0.12, barH);

  // Cursor aguja
  const needleX = barX + barW * score;
  ctx.fillStyle = evidence.pressure === 'HEAVY' ? '#fda4af' : evidence.pressure === 'LIGHT' ? '#fcd88a' : '#a2f1d9';
  ctx.beginPath();
  ctx.arc(needleX, barY + barH / 2, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawSignal(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const buffer = state.buffer;
  if (!buffer) return;
  const { plot } = state.layout;
  const p = state.props;

  const revealed = state.inspection?.traceRevealed ?? state.traceRevealed;
  const observedStrength = state.inspection?.strength ?? state.signalStrength;
  if (p.preserveResults && !p.isFingerDetected && !state.inspection) return;
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

  const windowMs = state.windowMs ?? WINDOW_MS;
  const endMs = state.inspection?.endMs ?? state.now;
  const points = (state.inspection?.buffer ?? buffer).getRecentPointsSince(endMs - windowMs - VISUAL_DELAY_MS).filter(p => p.time <= endMs);

  if (points.length > 30 && !state.inspection) {
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

  const stats = state.inspection?.stats ?? state.amplitudeStats;
  if (points.length < 2) return;
  const safeRange = stats.range > 1 ? stats.range : 1;
  const wavePadTop = CARDIAC_WAVE_CONFIG.WAVE_PAD_TOP;
  const wavePadBot = CARDIAC_WAVE_CONFIG.WAVE_PAD_BOTTOM;
  const waveH = Math.max(40, plot.h - wavePadTop - wavePadBot);
  const waveBaseY = plot.y + wavePadTop + waveH;

  const strength = revealed
    ? (observedStrength < 0 ? 0 : observedStrength > 1 ? 1 : observedStrength)
    : 0.5; // Default amplitude during warmup so we can see finger contact immediately
  const midValue = (stats.max + stats.min) / 2;
  const coords: { x: number; y: number; isArr: boolean; val: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const age = endMs - pt.time - VISUAL_DELAY_MS;
    if (age > windowMs) continue;
    const x = plot.x + plot.w - (age * plot.w / windowMs);
    if (x < plot.x || x > plot.x + plot.w) continue;
    const honestValue = midValue + (pt.value - midValue) * strength;
    
    // Mapeo normalizado [0..1] para aplicar la transformaciÃ³n de subida/bajada no lineal
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

  // El halo de la punta se amortigua una vez por frame; ambos modos (2D/3D) lo leen.
  state.sweepPulse *= CARDIAC_WAVE_CONFIG.SWEEP_PULSE_DECAY;

  if (state.threeD?.enabled) {
    // â”€â”€ MODO 3D: onda como cinta extruida sobre el piso en perspectiva. â”€â”€
    // Reusa las MISMAS coords honestas â†’ forma, amplitud y tiempo idÃ©nticos al 2D.
    drawWaveRibbon3D(ctx, state, coords, { waveBaseY, waveH, midValue });
  } else {
  // Background areas for arrhythmia
  let seg = 0;
  while (seg < coords.length) {
    if (!coords[seg].isArr) { seg++; continue; }
    let end = seg;
    while (end < coords.length && coords[end].isArr) end++;
    const x0 = coords[seg].x;
    const x1 = coords[end - 1].x;
    ctx.fillStyle = 'rgba(127, 29, 29, 0.26)';
    ctx.fillRect(x0, plot.y + wavePadTop, Math.max(3, x1 - x0 + 1), waveH);
    seg = end;
  }

  // Waveform Fill
  const fillSegment = (startIdx: number, endIdx: number, arrhythmia: boolean) => {
    if (!revealed) return; // Do not draw background fills when stabilizing
    if (endIdx <= startIdx) return;
    ctx.beginPath();
    ctx.moveTo(coords[startIdx].x, waveBaseY);
    ctx.lineTo(coords[startIdx].x, coords[startIdx].y);
    traceMeasuredPath(ctx, coords, startIdx, endIdx - 1);
    ctx.lineTo(coords[endIdx - 1].x, waveBaseY);
    ctx.closePath();
    const fillGrad = ctx.createLinearGradient(0, plot.y + wavePadTop, 0, waveBaseY);
    if (arrhythmia) {
      fillGrad.addColorStop(0, 'rgba(248, 113, 113, 0.12)');
      fillGrad.addColorStop(1, 'rgba(127, 29, 29, 0.02)');
    } else {
      fillGrad.addColorStop(0, 'rgba(104, 221, 192, 0.10)');
      fillGrad.addColorStop(1, 'rgba(104, 221, 192, 0.01)');
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

  // Waveform Stroke
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const drawDirectSegment = (startIdx: number, endIdx: number) => {
    ctx.beginPath();
    ctx.moveTo(coords[startIdx].x, coords[startIdx].y);
    traceMeasuredPath(ctx, coords, startIdx, endIdx - 1);
  };

  const totalLen = coords.length;
  const recentCut = Math.max(0, totalLen - Math.floor(totalLen * 0.35));
  const leadingCut = Math.max(0, totalLen - Math.floor(totalLen * 0.10));

  // Base stroke
  seg = 0;
  while (seg < totalLen - 1) {
    const isArr = coords[seg].isArr;
    let segEnd = seg;
    while (segEnd < totalLen - 1 && coords[segEnd].isArr === isArr) segEnd++;
    drawDirectSegment(seg, segEnd + 1 > totalLen ? segEnd : segEnd + 1);
    ctx.strokeStyle = revealed
      ? (isArr ? 'rgba(239, 68, 68, 0.4)' : 'rgba(104, 221, 192, 0.45)')
      : 'rgba(148, 163, 184, 0.25)'; // Low opacity zinc when stabilizing
    ctx.lineWidth = CARDIAC_WAVE_CONFIG.BASE_STROKE_WIDTH;
    ctx.stroke();
    seg = segEnd;
  }

  if (revealed) {
    // Glow and leading strokes
    ctx.shadowColor = COLORS.SIGNAL_GLOW;
    ctx.shadowBlur = CARDIAC_WAVE_CONFIG.SHADOW_BLUR_BASE;
    seg = Math.max(recentCut, 0);
    while (seg < totalLen - 1) {
      const isArr = coords[seg].isArr;
      let segEnd = seg;
      while (segEnd < totalLen - 1 && coords[segEnd].isArr === isArr) segEnd++;
      drawDirectSegment(seg, segEnd + 1 > totalLen ? segEnd : segEnd + 1);
      ctx.strokeStyle = isArr ? 'rgba(239, 68, 68, 0.65)' : 'rgba(104, 221, 192, 0.68)';
      ctx.lineWidth = CARDIAC_WAVE_CONFIG.GLOW_STROKE_WIDTH;
      ctx.stroke();
      seg = segEnd;
    }

    ctx.shadowBlur = CARDIAC_WAVE_CONFIG.SHADOW_BLUR_LEADING;
    seg = Math.max(leadingCut, 0);
    while (seg < totalLen - 1) {
      const isArr = coords[seg].isArr;
      let segEnd = seg;
      while (segEnd < totalLen - 1 && coords[segEnd].isArr === isArr) segEnd++;
      drawDirectSegment(seg, segEnd + 1 > totalLen ? segEnd : segEnd + 1);
      ctx.strokeStyle = isArr ? 'rgba(239, 68, 68, 0.85)' : '#97edd9';
      ctx.lineWidth = CARDIAC_WAVE_CONFIG.LEADING_STROKE_WIDTH;
      ctx.shadowColor = isArr ? COLORS.SIGNAL_ARR_GLOW : COLORS.SIGNAL_GLOW;
      ctx.stroke();
      seg = segEnd;
    }
    ctx.shadowBlur = 0;
  } else {
    // Simple slightly clearer leading stroke for current signal without glow when stabilizing
    seg = Math.max(leadingCut, 0);
    if (seg < totalLen - 1) {
      drawDirectSegment(seg, totalLen);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
      ctx.lineWidth = CARDIAC_WAVE_CONFIG.BASE_STROKE_WIDTH;
      ctx.stroke();
    }
  }

  // Head Pulse
  const head = coords[coords.length - 1];
  if (head) {
    const pulse = state.reducedMotion || state.inspection ? 0.04 : Math.max(state.sweepPulse, 0.04);
    ctx.beginPath();
    ctx.arc(head.x, head.y, CARDIAC_WAVE_CONFIG.HEAD_PULSE_BASE_RADIUS + pulse * 8, 0, Math.PI * 2);
    ctx.fillStyle = revealed
      ? (head.isArr ? 'rgba(248, 113, 113, 0.3)' : 'rgba(131, 204, 228, 0.3)')
      : 'rgba(148, 163, 184, 0.18)'; // Dimmer when stabilizing
    ctx.fill();
    ctx.beginPath();
    ctx.arc(head.x, head.y, CARDIAC_WAVE_CONFIG.HEAD_PULSE_INNER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  if (state.inspection?.cursorFraction !== undefined && coords.length > 0) {
    const x = plot.x + state.inspection.cursorFraction * plot.w;
    const nearest = coords.reduce((a, b) => Math.abs(a.x - x) < Math.abs(b.x - x) ? a : b);
    ctx.setLineDash([3, 5]);
    ctx.strokeStyle = '#a9c4d5';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(nearest.x, plot.y); ctx.lineTo(nearest.x, plot.y + plot.h); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(nearest.x, nearest.y, 4, 0, Math.PI * 2); ctx.fillStyle = '#edf5f9'; ctx.fill();
    ctx.font = `11px ${FONT_MONO}`; ctx.fillStyle = '#edf5f9'; ctx.textAlign = 'left';
    ctx.fillText(`${nearest.val.toFixed(1)} u.a.`, Math.min(nearest.x + 10, plot.x + plot.w - 90), plot.y + 28);
  }

  // â”€â”€â”€ FIDUCIAL MARKERS: INSTRUMENTATION GRADE (Annotated) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (revealed && state.showAnnotations !== false) {
    ctx.font = `bold 8px ${FONT_MONO}`;
    for (let i = 2; i < coords.length - 2; i++) {
      const v = coords[i].val;
      const isArr = coords[i].isArr;
      const prev2 = coords[i - 2].val;
      const prev = coords[i - 1].val;
      const next = coords[i + 1].val;
      const next2 = coords[i + 2].val;

      // Systolic Peak (Max Local)
      if (v > prev && v > next && v > prev2 && v > next2 && v > midValue) {
        ctx.beginPath();
        ctx.arc(coords[i].x, coords[i].y, CARDIAC_WAVE_CONFIG.SYS_PEAK_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = isArr ? COLORS.PEAK_ARR : '#ffffff';
        ctx.shadowBlur = 10;
        ctx.shadowColor = isArr ? COLORS.PEAK_ARR : '#83cce4';
        ctx.fill();
        ctx.shadowBlur = 0;

        // Numerical Annotation (Magnitude)
        ctx.fillStyle = isArr ? COLORS.PEAK_ARR : '#83cce4';
        ctx.textAlign = 'center';
        ctx.fillText(v.toFixed(1), coords[i].x, coords[i].y - 12);

        // Marker label (SYS or ARR)
        ctx.font = `7px ${FONT_MONO}`;
        ctx.fillStyle = isArr ? '#fecaca' : 'rgba(255, 255, 255, 0.7)';
        ctx.fillText(isArr ? 'ARR' : 'SYS', coords[i].x, coords[i].y - 22);
        ctx.font = `bold 8px ${FONT_MONO}`;

        // Red Warning Ring for Arrhythmia
        if (isArr) {
          ctx.beginPath();
          ctx.arc(coords[i].x, coords[i].y, CARDIAC_WAVE_CONFIG.ARR_WARNING_RADIUS, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.65)';
          ctx.lineWidth = CARDIAC_WAVE_CONFIG.ARR_WARNING_WIDTH;
          ctx.stroke();
        }
      }

      // Diastolic Valley (Min Local)
      if (v < prev && v < next && v < prev2 && v < next2 && v < midValue) {
        ctx.beginPath();
        ctx.arc(coords[i].x, coords[i].y, CARDIAC_WAVE_CONFIG.DIA_VALLEY_RADIUS, 0, Math.PI * 2);
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // Numerical Annotation
        ctx.fillStyle = '#94a3b8';
        ctx.textAlign = 'center';
        ctx.fillText(v.toFixed(1), coords[i].x, coords[i].y + 16);
        ctx.font = `7px ${FONT_MONO}`;
        ctx.fillText('DIA', coords[i].x, coords[i].y + 24);
        ctx.font = `bold 8px ${FONT_MONO}`;
      }

      // Dicrotic Notch Detection
      const d1_curr = v - prev;
      const d1_next = next - v;
      if (d1_curr < 0 && d1_next > d1_curr && d1_next < 0 && v > midValue) {
         ctx.beginPath();
         ctx.arc(coords[i].x, coords[i].y, CARDIAC_WAVE_CONFIG.DIC_NOTCH_RADIUS, 0, Math.PI * 2);
         ctx.fillStyle = 'rgba(103, 232, 249, 0.6)';
         ctx.fill();

         if (state.props.quality > 70) {
           ctx.font = `7px ${FONT_MONO}`;
           ctx.fillStyle = 'rgba(103, 232, 249, 0.8)';
           ctx.fillText('DIC', coords[i].x, coords[i].y - 8);
           ctx.font = `bold 8px ${FONT_MONO}`;
         }
      }
    }

  }
  }

  ctx.restore();
}

export function drawAcquisitionOverlay(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const p = state.props;
  const diag = p.diagnostics;
  if (!p.isFingerDetected || p.preserveResults) return;
  if (state.traceRevealed) return;

  const { plot } = state.layout;
  const progress = Math.max(0, Math.min(1, diag?.acquisitionProgress ?? 0));
  const barX = plot.x + 12;
  const barW = plot.w - 24;
  const barH = 4;
  const barY = plot.y + 4;

  ctx.save();
  ctx.fillStyle = 'rgba(148, 163, 184, 0.16)';
  ctx.fillRect(barX, barY, barW, barH);
  const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  grad.addColorStop(0, 'rgba(104, 221, 192, 0.9)');
  grad.addColorStop(1, 'rgba(103, 232, 249, 0.95)');
  ctx.fillStyle = grad;
  ctx.fillRect(barX, barY, barW * progress, barH);
  ctx.restore();
}

export function drawTrendStrip(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const { trend } = state.layout;
  if (trend.w < 80 || trend.h < 36) return;

  const compact = trend.h < 92;

  ctx.fillStyle = COLORS.PANEL_BG;
  ctx.fillRect(trend.x, trend.y, trend.w, trend.h);
  ctx.strokeStyle = COLORS.PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(trend.x + 0.5, trend.y + 0.5, trend.w - 1, trend.h - 1);

  const data = state.bpmTrend;
  const hrv = state.hrv;
  const arrCnt = state.props.arrhythmiaCount ?? 0;

  ctx.font = `bold ${compact ? 9 : 10}px ${FONT_MONO}`;
  ctx.fillStyle = COLORS.TEXT_PRIMARY;
  ctx.textAlign = 'left';
  ctx.fillText(
    compact ? 'TENDENCIA BPM · 60s' : 'TENDENCIA DEL PULSO · 60 s',
    trend.x + 8,
    trend.y + (compact ? 12 : 14),
  );

  ctx.font = `8px ${FONT_MONO}`;
  ctx.fillStyle = COLORS.TEXT_DIM;
  const hrvBits: string[] = [];
  if (hrv.sdnn > 0) hrvBits.push(`SDNN ${hrv.sdnn}`);
  if (hrv.rmssd > 0) hrvBits.push(`RMSSD ${hrv.rmssd}`);
  if (arrCnt > 0) hrvBits.push(`${arrCnt} marcas`);
  if (hrvBits.length > 0 && !compact) {
    ctx.fillText(hrvBits.join(' · '), trend.x + 8, trend.y + 26);
  } else if (hrvBits.length > 0) {
    ctx.textAlign = 'right';
    ctx.fillText(hrvBits.join(' · '), trend.x + trend.w - 8, trend.y + 12);
    ctx.textAlign = 'left';
  }

  if (data.length < 2) {
    ctx.font = `9px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.textAlign = 'center';
    ctx.fillText(state.props.isMonitoring ? 'Acumulando lecturas válidas…' : 'La tendencia aparecerá al medir', trend.x + trend.w / 2, trend.y + trend.h / 2 + 4);
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
  const drawBand = (lo: number, hi: number, color: string) => {
    const y1 = Math.max(innerY, yToPx(hi));
    const y2 = Math.min(innerY + innerH, yToPx(lo));
    if (y2 > y1) {
      ctx.fillStyle = color;
      ctx.fillRect(innerX, y1, innerW, y2 - y1);
    }
  };
  drawBand(60, 100, 'rgba(104, 221, 192, 0.09)');
  drawBand(yMin, 60, 'rgba(245, 158, 11, 0.06)');
  drawBand(100, yMax, 'rgba(239, 68, 68, 0.06)');

  const refLines = [
    { v: 60, label: '60', color: 'rgba(245, 158, 11, 0.55)' },
    { v: 100, label: '100', color: 'rgba(239, 68, 68, 0.45)' },
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

  const tickStep = compact ? Math.max(10, Math.ceil(span / 3 / 5) * 5) : span > 50 ? 10 : 5;
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

  ctx.beginPath();
  ctx.moveTo(coords[0].x, innerY + innerH);
  for (const c of coords) ctx.lineTo(c.x, c.y);
  ctx.lineTo(coords[coords.length - 1].x, innerY + innerH);
  ctx.closePath();
  const areaGrad = ctx.createLinearGradient(0, innerY, 0, innerY + innerH);
  areaGrad.addColorStop(0, 'rgba(104, 221, 192, 0.22)');
  areaGrad.addColorStop(1, 'rgba(104, 221, 192, 0.02)');
  ctx.fillStyle = areaGrad;
  ctx.fill();

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
    ctx.strokeStyle = isArr ? COLORS.SIGNAL_ARR : COLORS.SIGNAL;
    ctx.lineWidth = isArr ? 2.4 : 2;
    ctx.shadowColor = isArr ? COLORS.SIGNAL_ARR_GLOW : COLORS.SIGNAL_GLOW;
    ctx.shadowBlur = isArr ? 8 : 5;
    ctx.stroke();
    seg = end + 1;
  }
  ctx.shadowBlur = 0;

  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    if (!data[i].isArr && i !== coords.length - 1) continue;
    ctx.beginPath();
    ctx.arc(c.x, c.y, data[i].isArr ? 3.5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = data[i].isArr ? COLORS.SIGNAL_ARR : COLORS.SIGNAL;
    ctx.fill();
    if (data[i].isArr) {
      ctx.font = `bold 7px ${FONT_MONO}`;
      ctx.fillStyle = '#fecaca';
      ctx.textAlign = 'center';
      ctx.fillText('!', c.x, c.y - 8);
    }
  }

  const avgY = yToPx(avg);
  ctx.strokeStyle = 'rgba(103, 232, 249, 0.5)';
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
    ctx.fillText('● intervalo marcado', innerX + innerW, trend.y + trend.h - 4);
  }
}

export function drawFooter(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const { footer } = state.layout;
  if (footer.h < 28) return;
  ctx.save();
  ctx.fillStyle = 'rgba(8,18,30,0.96)';
  ctx.fillRect(footer.x, footer.y, footer.w, footer.h);
  ctx.strokeStyle = 'rgba(125,169,194,0.18)';
  ctx.beginPath(); ctx.moveTo(footer.x + 12, footer.y); ctx.lineTo(footer.x + footer.w - 12, footer.y); ctx.stroke();
  const hrv = state.hrv;
  const enough = state.props.rrIntervals.filter(isPhysiologicalRR).length >= 3;
  const cells = [
    { label: 'IBI', value: state.ibiDisplay > 0 ? `${state.ibiDisplay} ms` : '—', color: '#9edeee' },
    { label: 'SDNN', value: enough ? `${hrv.sdnn} ms` : '—', color: '#c0d0de' },
    { label: 'RMSSD', value: enough ? `${hrv.rmssd} ms` : '—', color: '#c0d0de' },
    { label: 'pNN50', value: enough ? `${hrv.pnn50}%` : '—', color: '#c0d0de' },
    { label: 'CV', value: enough ? hrv.cv.toFixed(2) : '—', color: '#c0d0de' },
  ];
  const wide = footer.w >= 800;
  const cellW = (wide ? Math.min(660, footer.w * .62) : footer.w - 24) / cells.length;
  cells.forEach((c, i) => {
    const x = footer.x + 12 + i * cellW;
    ctx.textAlign = 'left';
    ctx.font = `9px ${FONT_MONO}`;
    ctx.fillStyle = '#8fa9bd';
    ctx.fillText(c.label, x, footer.y + 12);
    fitLabel(ctx, c.value, cellW - 6, 11);
    ctx.fillStyle = c.color;
    ctx.fillText(c.value, x, footer.y + 29);
  });
  if (wide) {
    const rhythm = buildRhythmPanel(state.props.arrhythmiaStatus, state.props.arrhythmiaCount, state.props.rrIntervals, state.hrv);
    ctx.textAlign = 'right';
    ctx.font = `10px ${FONT_MONO}`;
    ctx.fillStyle = rhythm.level === 'danger' ? '#fca5a5' : '#a9bdcc';
    ctx.fillText(rhythm.title, footer.x + footer.w - 20, footer.y + 14);
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = '#839db2';
    ctx.fillText('Variabilidad del pulso · sin diagnóstico ECG', footer.x + footer.w - 20, footer.y + 30);
  }
  ctx.restore();
}
