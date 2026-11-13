/**
 * GUÍA DE COLOCACIÓN DENTRO DE LA VENTANA DE PREVISUALIZACIÓN.
 *
 * La ventana es la ÚNICA vista que el usuario tiene de la cámara (el resto del
 * monitor es un canvas opaco): si no sirve para colocar el dedo, no sirve. Este
 * módulo traduce la evidencia MEDIDA del pipeline a un dibujo registrado sobre
 * la imagen — una huella "diana" fija en el centro de la lente, una huella
 * "fantasma" en la posición real del tejido y un haz de corrección entre ambas.
 *
 * EVIDENCIA (nada aquí se inventa):
 *  - `evidence.centroid`    → dónde está el dedo de verdad (medido por frame).
 *  - `evidence.seal`        → cuánta lente cubre (tamaño y arco de cobertura).
 *  - `evidence.pulsatility` → fuerza del pulso (presencia de la guía).
 *  - `evidence.placement`   → si el dedo está centrado (canónico).
 *  - `evidence.readiness`   → veredicto agregado; sólo `READY` enciende el OK.
 *
 * POR QUÉ ESTE DISEÑO (evidencia):
 *  - Nature Sci Rep 2018;8:14123 (oscilométrico con iPhone): la app guía la
 *    colocación mostrando a la vez el área REAL de contacto (óvalo verde) y el
 *    objetivo (óvalo negro), y el usuario hace coincidir ambos. Es registro
 *    visual, no una instrucción de texto.
 *  - UIS / Sensor OLED, PMC11829945 (2025): dar feedback de calidad EN TIEMPO
 *    REAL mientras se captura baja el fallo de medida del 14,5 % al 0 %; los
 *    usuarios corrigen posición y presión al ver el GUI.
 *  - SMARTBEATS, PubMed 38533836 (2024): añadir feedback automático de
 *    manipulación bajó las grabaciones no diagnosticables del 4,4 % al 0,04 %.
 *  - NIST/Choong 2012 y Guan et al. 2011: el overlay de la imagen real mejora el
 *    posicionamiento; las instrucciones correctivas derivadas de magnitudes
 *    objetivas son las que suben la calidad.
 *  - AR / registro (IEEE ISMAR 2023; UCL 2026): el desajuste del cue sólo es
 *    tolerable por debajo de cierto margen — de ahí la zona muerta y el haz, que
 *    hacen explícito el error en vez de dejar que el usuario lo estime.
 *
 * FASES (lo que la app sabe y comunica):
 *  1. SEARCH   — no hay tejido: la diana respira y dice dónde está la lente.
 *  2. ALIGN    — hay tejido descentrado: fantasma + haz + arco de cobertura.
 *  3. PRESSURE — centrado pero la presión no es óptima: instrucción de presión.
 *  4. LOCKED   — todo correcto: la diana se cierra y se queda encendida.
 *
 * Este módulo NO decide: `deriveWellGuide` sólo proyecta el veredicto canónico a
 * una vista. La decisión vive en `fingerPlacementEvidence` (colocación/presión)
 * y en `AcquisitionStabilizer` (adquisición).
 */
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import type { FingerPlacementEvidence } from '@/lib/finger/fingerPlacementEvidence';
import type { FloorPreviewGeometry, ProjPoint } from './ppg3dProjection';

const OV = VITAL_THRESHOLDS.PLACEMENT.OVERLAY;
const { COVER_MIN, COVER_GOOD } = VITAL_THRESHOLDS.PRESSURE;

/**
 * Fracción del lado menor del vídeo que se proyecta sobre la ventana. La usa el
 * pintado del vídeo y su inversa la guía: si se cambian por separado, la huella
 * deja de coincidir con el dedo. Fuente única.
 */
export const WELL_CROP_FRAC = 0.90;

// === Preferencias de movimiento ==============================================

let reducedMotionCache: boolean | null = null;
let reducedMotionWatched = false;

/**
 * `prefers-reduced-motion: reduce` cacheado. Con movimiento reducido la huella no
 * barre ni respira: se queda encendida, que comunica lo mismo sin animación.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  if (reducedMotionCache === null) {
    reducedMotionCache = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reducedMotionWatched) {
      reducedMotionWatched = true;
      try {
        window
          .matchMedia('(prefers-reduced-motion: reduce)')
          .addEventListener('change', (e) => {
            reducedMotionCache = e.matches;
          });
      } catch {
        // Safari antiguo: se mantiene el valor de la primera consulta.
      }
    }
  }
  return reducedMotionCache;
}

// === Traducción de la evidencia a vista =========================================

export type WellReadiness =
  /** No hay evidencia: el pipeline está parado o el monitor no corre. */
  | 'INACTIVE'
  /** Cámara activa pero sin tejido suficiente sobre la lente. */
  | 'NO_CONTACT'
  /** Hay dedo, pero el registro no está conseguido. */
  | 'ALIGNING'
  /** Colocación correcta pero la presión no es la óptima. */
  | 'PRESSURE'
  /** Todo correcto. */
  | 'READY';

/** Fase de la guía: lo que la app sabe y lo que le dice al usuario. */
export type WellPhase = 'INACTIVE' | 'SEARCH' | 'ALIGN' | 'PRESSURE' | 'LOCKED';

export interface WellGuideInput {
  /** Evidencia canónica del frame (undefined si el pipeline no entregó nada). */
  evidence?: FingerPlacementEvidence;
  /** Estadio de adquisición del estabilizador (otra fuente canónica). */
  acquisitionStage?: string;
  /** ¿Hay imagen de cámara disponible? Sin ella no hay nada que alinear. */
  hasVideo: boolean;
  /** Reloj del render (ms) para la animación. */
  nowMs: number;
  /** Latido real [0..1] (barrido del monitor) para el pulso de confirmación. */
  beatPulse: number;
  /** `prefers-reduced-motion`. */
  reducedMotion: boolean;
}

export interface WellGuideView {
  phase: WellPhase;
  readiness: WellReadiness;
  /** Instrucción corta (línea principal del zócalo). */
  instruction: string;
  /** Detalle medido (línea secundaria): el "por qué". */
  detail: string;
  /** 1 = centrado perfecto. */
  alignment: number;
  /** Sellado normalizado [0..1]: 0 = nada de lente cubierta. */
  coverage: number;
  /** Centro MEDIDO del tejido, en coordenadas del recorte del vídeo. */
  ghost: { u: number; v: number };
  /** Centro de la lente en el recorte: la diana. */
  target: { u: number; v: number };
  /** Dirección de corrección en coordenadas del recorte (sin normalizar). */
  correction: { u: number; v: number };
  /** Módulo del descentrado en unidades del recorte. */
  offset: number;
  /** 0 = corregido, 1 = corrección máxima representada. */
  severity: number;
  /** ¿Se dibuja la huella fantasma (dedo presente y registro no conseguido)? */
  ghostVisible: boolean;
  ghostScale: number;
  ghostAlpha: number;
  /** Opacidad de la diana (alta: es la referencia). */
  targetAlpha: number;
  /** Presión relativa [0..1] del modelo transmural (sólo informativa aquí). */
  pressure: number;
  /** Fase del barrido de crestas [0..1). */
  scan: number;
  /** Latido [0..1] para el anillo de confirmación. */
  lock: number;
  /** Respiración lenta [0.85..1]. */
  breath: number;
}

/** Normaliza una coordenada del frame completo a coordenada del recorte. */
export function frameToCrop(n: number): number {
  const inset = (1 - WELL_CROP_FRAC) / 2;
  return (n - inset) / WELL_CROP_FRAC;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const INSTRUCTION: Record<WellPhase, string> = {
  INACTIVE: 'SIN SEÑAL',
  SEARCH: 'APOYA LA YEMA EN LA LENTE',
  ALIGN: 'HAZ COINCIDIR LAS HUELLAS',
  PRESSURE: 'AJUSTA LA PRESIÓN',
  LOCKED: 'SEÑAL ESTABLE',
};

/**
 * Proyecta el veredicto a la vista de la ventana. Función PURA: misma entrada,
 * misma salida (el reloj sólo afecta a la fase de animación).
 */
export function deriveWellGuide(input: WellGuideInput): WellGuideView {
  const { evidence } = input;
  const reduced = input.reducedMotion;
  const scan = reduced ? 0.5 : (input.nowMs % OV.SCAN_PERIOD_MS) / OV.SCAN_PERIOD_MS;
  const breath = reduced ? 1 : 0.9 + 0.1 * Math.sin(input.nowMs / 620);
  const lock = clamp01(input.beatPulse);
  const target = { u: 0.5, v: 0.5 };

  if (!evidence) {
    return {
      phase: 'INACTIVE',
      readiness: 'INACTIVE',
      instruction: INSTRUCTION.INACTIVE,
      detail: 'INICIA LA MEDICIÓN',
      alignment: 0,
      coverage: 0,
      ghost: target,
      target,
      correction: { u: 0, v: 0 },
      offset: 0,
      severity: 0,
      ghostVisible: false,
      ghostScale: 1,
      ghostAlpha: 0,
      targetAlpha: OV.TARGET_ALPHA,
      pressure: 0.5,
      scan,
      lock,
      breath,
    };
  }

  const alignment = clamp01(evidence.alignment);
  const rawU = frameToCrop(evidence.centroid.x);
  const rawV = frameToCrop(evidence.centroid.y);
  const ghost = { u: clamp01(rawU), v: clamp01(rawV) };
  const correction = { u: 0.5 - rawU, v: 0.5 - rawV };
  const offset = Math.hypot(correction.u, correction.v);
  const severity = clamp01(offset / OV.MAX_OFFSET);
  const coverage = clamp01(
    (evidence.seal - COVER_MIN) / Math.max(1e-6, COVER_GOOD - COVER_MIN),
  );

  const canonicalReady =
    evidence.readiness === 'READY' && input.acquisitionStage === 'READY';

  // Tolerancia VISUAL del registro. El veredicto canónico declara CENTERED con un
  // descentrado de hasta ~0,17 del encuadre; la ventana exige además que el dedo
  // esté dentro de su zona muerta: si no, la huella dibujada no cuadraría con el
  // dedo del vídeo y el "OK" sería visiblemente falso (el usuario ve el dedo
  // corrido y la app diciendo "SEÑAL ESTABLE"). Esta es la única condición que
  // la ventana añade al veredicto, y sólo puede ENDURECERLO, nunca relajarlo.
  const aligned = offset <= OV.DEADBAND;

  const readiness: WellReadiness =
    evidence.placement === 'NO_FINGER'
      ? 'NO_CONTACT'
      : canonicalReady && aligned
        ? 'READY'
        : evidence.readiness === 'PRESSURE'
          ? 'PRESSURE'
          : 'ALIGNING';

  // Orden de prioridad de la guía: primero el dedo, luego la posición, luego la
  // presión. Pedir "presiona más" a un dedo que aún no está en la lente no
  // arregla nada; y un dedo centrado y aplastado se corrige con la presión.
  let phase: WellPhase;
  if (evidence.placement === 'NO_FINGER') phase = 'SEARCH';
  else if (readiness === 'READY') phase = 'LOCKED';
  else if (evidence.placement !== 'CENTERED' || offset > OV.DEADBAND) phase = 'ALIGN';
  else if (evidence.pressure === 'LIGHT' || evidence.pressure === 'HEAVY') phase = 'PRESSURE';
  else phase = 'ALIGN';

  const instruction =
    phase === 'PRESSURE'
      ? evidence.pressure === 'HEAVY'
        ? 'SUELTA UN POCO'
        : 'PRESIONA UN POCO MÁS'
      : INSTRUCTION[phase];

  const detail =
    phase === 'SEARCH'
      ? 'LA LENTE ESTÁ EN EL CENTRO'
      : phase === 'ALIGN'
        ? `LENTE CUBIERTA ${Math.round(coverage * 100)}%`
        : phase === 'PRESSURE'
          ? 'LA PRESIÓN NO ES ÓPTIMA'
          : 'MANTÉN EL DEDO ASÍ';

  return {
    phase,
    readiness,
    instruction,
    detail,
    alignment,
    coverage,
    ghost,
    target,
    correction,
    offset,
    severity,
    ghostVisible: phase === 'ALIGN',
    ghostScale: 0.58 + 0.42 * coverage,
    ghostAlpha: OV.GHOST_ALPHA * (0.55 + 0.45 * clamp01(evidence.pulsatility)),
    targetAlpha: OV.TARGET_ALPHA,
    pressure: clamp01(evidence.pressureScore),
    scan,
    lock,
    breath,
  };
}

// === Proyección exacta del recorte sobre el plano de la ventana ================

/**
 * Proyecta un punto del recorte del vídeo (u,v) al plano de la ventana.
 *
 * Es la inversa EXACTA del pintado por franjas: `drawFloorWarpedVideo` coloca la
 * fila `v` a la profundidad `z = zn + (1 − v)·(zf − zn)` y estira el recorte
 * completo a lo ancho del trapecio en esa profundidad. Aquí se aplica la misma
 * ley, así que la huella y el dedo del vídeo comparten plano.
 */
export function projectWellUV(
  geo: FloorPreviewGeometry,
  u: number,
  v: number,
): ProjPoint {
  const { zn, zf, halfW } = geo.quad;
  // Sin recorte: una huella que se sale del encuadre debe dibujarse saliéndose
  // (el clip al trapecio ya la recorta). Recortar aquí aplastaría las crestas
  // contra el borde y falsearía el registro.
  const depth = zn + (1 - v) * (zf - zn);
  // `floorPoint` es la ÚNICA ley de proyección: `traceRidge` y
  // `strokeWellEllipse` la replican inline sólo para no asignar objetos en el
  // bucle de pintado; si cambia `floorPoint`, cambian los tres.
  return geo.proj.floorPoint((u - 0.5) * 2 * halfW, depth);
}

/** Proyecta y traza sin asignar objetos: el bucle corre 60 veces por segundo. */
function traceRidge(
  ctx: CanvasRenderingContext2D,
  geo: FloorPreviewGeometry,
  cu: number,
  cv: number,
  scale: number,
  pts: RidgePoint[],
): void {
  const { zn, zf, halfW } = geo.quad;
  const span = zf - zn;
  const vpX = geo.proj.vpX;
  const horizonY = geo.proj.horizonY;
  const floorSpanY = geo.proj.floorSpanY;
  const zNear = geo.proj.zNear;
  for (let i = 0; i < pts.length; i++) {
    const u = cu + pts[i].u * scale;
    const v = cv + pts[i].v * scale;
    const s = zNear / (zn + (1 - v) * span);
    const x = vpX + (u - 0.5) * 2 * halfW * s;
    const y = horizonY + floorSpanY * s;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
}

// === Forma de la huella (determinista) =========================================

export interface RidgePoint {
  u: number;
  v: number;
}

/**
 * Crestas de una huella: lazos concéntricos cerrados, más alargados en `v` que
 * en `u` (la almohadilla del dedo lo es) y con el "delta" abierto en las
 * crestas exteriores. Determinista: sin azar, misma huella en cada frame.
 */
export function fingerprintRidges(
  cu: number,
  cv: number,
  scale: number,
  count: number = OV.RIDGES,
  samplesPerRidge = 40,
): RidgePoint[][] {
  return buildRidges(cu, cv, scale, count, samplesPerRidge);
}

function buildRidges(
  cu: number,
  cv: number,
  scale: number,
  count: number,
  samplesPerRidge: number,
): RidgePoint[][] {
  const ridges: RidgePoint[][] = [];
  const n = Math.max(3, Math.round(count));
  for (let k = 0; k < n; k++) {
    const t = (k + 1) / n;
    const ru = OV.RIDGE_U * scale * (0.20 + 0.80 * t);
    const rv = OV.RIDGE_V * scale * (0.20 + 0.80 * t);
    const gap = k >= n - 3 ? 0.55 + 0.35 * (k - (n - 3)) : 0;
    const start = -Math.PI / 2 + gap / 2 + 0.22 * t;
    const sweep = Math.PI * 2 - gap;
    const pts: RidgePoint[] = [];
    for (let i = 0; i <= samplesPerRidge; i++) {
      const a = start + (i / samplesPerRidge) * sweep;
      const waist = 1 + 0.10 * Math.cos(2 * a);
      pts.push({ u: cu + Math.cos(a) * ru * waist, v: cv + Math.sin(a) * rv });
    }
    ridges.push(pts);
  }
  return ridges;
}

/** Plantilla centrada en el origen y a escala 1: se construye una sola vez. */
let ridgeTemplate: RidgePoint[][] | null = null;
function unitRidges(): RidgePoint[][] {
  if (!ridgeTemplate) ridgeTemplate = buildRidges(0, 0, 1, OV.RIDGES, 40);
  return ridgeTemplate;
}

// === Presupuesto de transparencia ==============================================

/**
 * Alpha de cada capa que se pinta ENCIMA del vídeo. La suma de todas es lo que
 * el usuario percibe como "opacidad" de la ventana: el dedo (rojo oscuro sobre
 * negro) tiene que verse a través de ellas. Ninguna capa pasa de 0.20 y en la
 * banda del dedo el vídeo conserva ≥ 78 % de su luz.
 */
export const WELL_VEIL = {
  TINT_MIN: 0.02,
  TINT_MAX: 0.02,
  DEPTH_FAR: 0.20,
  DEPTH_MID: 0.05,
  DEPTH_NEAR: 0.0,
  GLASS_FAR: 0.03,
} as const;

function depthVeilAt(v: number): number {
  const t = clamp01(v);
  if (t <= 0.6) return WELL_VEIL.DEPTH_FAR + (WELL_VEIL.DEPTH_MID - WELL_VEIL.DEPTH_FAR) * (t / 0.6);
  return WELL_VEIL.DEPTH_MID + (WELL_VEIL.DEPTH_NEAR - WELL_VEIL.DEPTH_MID) * ((t - 0.6) / 0.4);
}

/** Alpha del tinte del veredicto (único lugar donde se calcula). */
export function wellTintAlpha(size: number): number {
  return WELL_VEIL.TINT_MIN + WELL_VEIL.TINT_MAX * clamp01(size);
}

/**
 * Alpha total (0 = cristal, 1 = opaco) que el vídeo recibe en la fila `v`.
 * Función pura y testeable: la transparencia de la ventana es un contrato, no
 * una impresión.
 */
export function wellVeilAt(v: number, size: number): number {
  const tint = wellTintAlpha(size);
  const glass = WELL_VEIL.GLASS_FAR * (1 - clamp01(v));
  return clamp(1 - (1 - tint) * (1 - depthVeilAt(v)) * (1 - glass), 0, 1);
}

// === Pintado ===================================================================

export interface WellGuidePalette {
  /** "r,g,b" del veredicto (mismo lenguaje de color que el gauge). */
  tint: string;
  /** "r,g,b" del acento de corrección / confirmación. */
  accent: string;
}

const TEXT_MAIN = '#e6edf6';
const TEXT_SUB = 'rgba(203, 213, 225, 0.78)';

function traceQuad(ctx: CanvasRenderingContext2D, geo: FloorPreviewGeometry): void {
  const { nearLeft, nearRight, farRight, farLeft } = geo.quad;
  ctx.beginPath();
  ctx.moveTo(nearLeft.x, nearLeft.y);
  ctx.lineTo(nearRight.x, nearRight.y);
  ctx.lineTo(farRight.x, farRight.y);
  ctx.lineTo(farLeft.x, farLeft.y);
  ctx.closePath();
}

/** Anillo elíptico proyectado sobre el plano del recorte (sin asignar). */
function strokeWellEllipse(
  ctx: CanvasRenderingContext2D,
  geo: FloorPreviewGeometry,
  cu: number,
  cv: number,
  ru: number,
  rv: number,
  from = 0,
  to = Math.PI * 2,
  samples = 48,
): void {
  const { zn, zf, halfW } = geo.quad;
  const span = zf - zn;
  const vpX = geo.proj.vpX;
  const horizonY = geo.proj.horizonY;
  const floorSpanY = geo.proj.floorSpanY;
  const zNear = geo.proj.zNear;
  for (let i = 0; i <= samples; i++) {
    const a = from + ((to - from) * i) / samples;
    const u = cu + Math.cos(a) * ru;
    const v = cv + Math.sin(a) * rv;
    const s = zNear / (zn + (1 - v) * span);
    const x = vpX + (u - 0.5) * 2 * halfW * s;
    const y = horizonY + floorSpanY * s;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
}

/** Brillo de cada cresta según el barrido: una onda que viaja del centro al borde. */
function ridgeGlow(scan: number, k: number, count: number): number {
  const phase = count <= 1 ? 0 : k / (count - 1);
  let d = Math.abs(scan - phase);
  if (d > 0.5) d = 1 - d;
  return Math.exp(-(d * d) / 0.030);
}

function drawRidgeSet(
  ctx: CanvasRenderingContext2D,
  geo: FloorPreviewGeometry,
  cu: number,
  cv: number,
  scale: number,
  opts: {
    baseAlpha: number;
    lineWidth: number;
    glow: number;
    tint: string;
    dashed: boolean;
    /** Contracción [0..1]: las crestas se cierran al confirmar. */
    contract: number;
  },
): void {
  const ridges = unitRidges();
  const shrink = 1 - 0.06 * clamp01(opts.contract);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let k = 0; k < ridges.length; k++) {
    const a = clamp01(opts.baseAlpha * (0.62 + 0.38 * ridgeGlow(opts.glow, k, ridges.length)));
    if (a <= 0.01) continue;
    ctx.beginPath();
    traceRidge(ctx, geo, cu, cv, scale * shrink, ridges[k]);
    ctx.setLineDash(opts.dashed ? [5, 5] : []);
    ctx.lineWidth = opts.lineWidth * (0.82 + 0.30 * (k / Math.max(1, ridges.length - 1)));
    ctx.strokeStyle = `rgba(${opts.tint}, ${a.toFixed(3)})`;
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

/** Haz de corrección: cuña translúcida del fantasma a la diana + flecha. */
function drawCorrectionBeam(
  ctx: CanvasRenderingContext2D,
  geo: FloorPreviewGeometry,
  view: WellGuideView,
  palette: WellGuidePalette,
): void {
  const from = projectWellUV(geo, view.ghost.u, view.ghost.v);
  const to = projectWellUV(geo, view.target.u, view.target.v);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 8) return;

  const ux = dx / dist;
  const uy = dy / dist;
  const nx = -uy;
  const ny = ux;
  const w0 = OV.BEAM_WIDTH * (0.55 + 0.45 * view.severity);
  const w1 = 1.5;

  const grad = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
  grad.addColorStop(0, `rgba(${palette.accent}, ${(0.30 * view.breath).toFixed(3)})`);
  grad.addColorStop(1, `rgba(${palette.accent}, 0.02)`);
  ctx.beginPath();
  ctx.moveTo(from.x + nx * w0, from.y + ny * w0);
  ctx.lineTo(to.x + nx * w1, to.y + ny * w1);
  ctx.lineTo(to.x - nx * w1, to.y - ny * w1);
  ctx.lineTo(from.x - nx * w0, from.y - ny * w0);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Punta de flecha en la diana.
  const head = 7;
  ctx.beginPath();
  ctx.moveTo(to.x + ux * head, to.y + uy * head);
  ctx.lineTo(to.x - ux * 2 + nx * head * 0.62, to.y - uy * 2 + ny * head * 0.62);
  ctx.lineTo(to.x - ux * 2 - nx * head * 0.62, to.y - uy * 2 - ny * head * 0.62);
  ctx.closePath();
  ctx.fillStyle = `rgba(${palette.accent}, ${(0.55 * view.breath).toFixed(3)})`;
  ctx.fill();

  // Trazos que corren hacia la diana: la dirección se lee sin texto.
  const travel = (view.scan * 2) % 1;
  ctx.setLineDash([3, 7]);
  ctx.lineDashOffset = -travel * 10;
  ctx.beginPath();
  ctx.moveTo(from.x + ux * 14, from.y + uy * 14);
  ctx.lineTo(to.x - ux * 6, to.y - uy * 6);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = `rgba(${palette.accent}, ${(0.5 * view.breath).toFixed(3)})`;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

/** Anillo de cobertura: cuánta lente cubre el dedo respecto al objetivo. */
function drawCoverageRing(
  ctx: CanvasRenderingContext2D,
  geo: FloorPreviewGeometry,
  view: WellGuideView,
  palette: WellGuidePalette,
): void {
  const ru = OV.RIDGE_U * OV.COVERAGE_RING;
  const rv = OV.RIDGE_V * OV.COVERAGE_RING;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  strokeWellEllipse(ctx, geo, view.target.u, view.target.v, ru, rv);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.20)';
  ctx.stroke();

  const sweep = Math.PI * 2 * clamp01(view.coverage);
  if (sweep > 0.01) {
    ctx.beginPath();
    strokeWellEllipse(ctx, geo, view.target.u, view.target.v, ru, rv, -Math.PI / 2, -Math.PI / 2 + sweep);
    ctx.strokeStyle = `rgba(${palette.tint}, 0.72)`;
    ctx.stroke();
  }
  ctx.restore();
}

/** Retícula de búsqueda: anillos que colapsan sobre la diana. */
function drawSearchReticle(
  ctx: CanvasRenderingContext2D,
  geo: FloorPreviewGeometry,
  view: WellGuideView,
  palette: WellGuidePalette,
): void {
  const cycle = (view.scan * 1.6) % 1;
  ctx.save();
  for (let i = 0; i < 2; i++) {
    const t = (cycle + i * 0.5) % 1;
    const s = 1.9 - 0.85 * t;
    ctx.beginPath();
    strokeWellEllipse(
      ctx,
      geo,
      view.target.u,
      view.target.v,
      OV.RIDGE_U * s,
      OV.RIDGE_V * s,
    );
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = `rgba(${palette.tint}, ${(0.34 * (1 - t)).toFixed(3)})`;
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * "Ponlo aquí": chevrones que caen hacia la diana mientras no hay tejido.
 *
 * Es la respuesta al problema real del primer contacto: el usuario no ve la
 * lente (está bajo su dedo) y la ventana es lo único que la localiza. La diana
 * sola es un dibujo; los chevrones dicen "hacia aquí" sin texto y sin color.
 */
function drawPlaceHint(
  ctx: CanvasRenderingContext2D,
  geo: FloorPreviewGeometry,
  view: WellGuideView,
  palette: WellGuidePalette,
): void {
  const cycle = view.scan;
  const target = projectWellUV(geo, view.target.u, view.target.v);
  const top = projectWellUV(geo, view.target.u, view.target.v - 0.30);
  ctx.save();
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  for (let i = 0; i < 2; i++) {
    const t = (cycle + i * 0.5) % 1;
    const y = top.y + (target.y - top.y) * (0.15 + 0.55 * t);
    const alpha = 0.55 * (1 - t) * view.breath;
    if (alpha <= 0.02) continue;
    ctx.beginPath();
    ctx.moveTo(target.x - 7, y - 4);
    ctx.lineTo(target.x, y + 2);
    ctx.lineTo(target.x + 7, y - 4);
    ctx.strokeStyle = `rgba(${palette.tint}, ${alpha.toFixed(3)})`;
    ctx.stroke();
  }
  ctx.restore();
}

/** Zócalo de texto DENTRO del cristal: degradado + dos líneas legibles. */
function drawScrim(
  ctx: CanvasRenderingContext2D,
  geo: FloorPreviewGeometry,
  view: WellGuideView,
  palette: WellGuidePalette,
  font: string,
): void {
  const { nearLeft, nearRight } = geo.quad;
  // Sin ancho suficiente el texto no cabe dentro del cristal y acabaría
  // dibujándose fuera: en ese estado no hay zócalo (tampoco hay ventana que
  // leer). Evita el "cartel" flotante que se veía al plegar la ventana.
  if (nearRight.x - nearLeft.x < 96) return;

  const topL = projectWellUV(geo, 0, OV.SCRIM_V);
  const topR = projectWellUV(geo, 1, OV.SCRIM_V);
  const grad = ctx.createLinearGradient(0, topL.y, 0, nearLeft.y);
  grad.addColorStop(0, 'rgba(2, 6, 12, 0)');
  grad.addColorStop(0.45, 'rgba(2, 6, 12, 0.50)');
  grad.addColorStop(1, 'rgba(2, 6, 12, 0.80)');
  ctx.beginPath();
  ctx.moveTo(topL.x, topL.y);
  ctx.lineTo(topR.x, topR.y);
  ctx.lineTo(nearRight.x, nearRight.y);
  ctx.lineTo(nearLeft.x, nearLeft.y);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  const anchor = projectWellUV(geo, 0.5, 0.9);
  const maxW = (nearRight.x - nearLeft.x) * 0.86;
  let size = OV.TEXT_MAIN;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  do {
    ctx.font = `bold ${size}px ${font}`;
    if (ctx.measureText(view.instruction).width <= maxW) break;
    size -= 0.5;
  } while (size > 7);

  // El zócalo ya aporta contraste: nada de `shadowBlur` en el texto (caro por
  // glifo en móvil y aquí se pinta en cada frame).
  ctx.fillStyle = view.phase === 'LOCKED' ? palette.tint : TEXT_MAIN;
  ctx.fillText(view.instruction, anchor.x, anchor.y);

  // Punto de estado: el color no es el único canal (posición + texto lo dicen).
  const subSize = OV.TEXT_SUB;
  ctx.font = `${subSize}px ${font}`;
  const dotY = anchor.y + 11;
  ctx.beginPath();
  ctx.arc(
    anchor.x - ctx.measureText(view.detail).width / 2 - 8,
    dotY - 3,
    2.2,
    0,
    Math.PI * 2,
  );
  ctx.fillStyle = `rgba(${palette.tint}, ${(0.55 + 0.45 * view.breath).toFixed(3)})`;
  ctx.fill();

  ctx.fillStyle = TEXT_SUB;
  ctx.fillText(view.detail, anchor.x, dotY);
}

/**
 * Dibuja la guía de colocación DENTRO de la ventana.
 *
 * Va después del vídeo y de los velos, y antes del bisel: la huella es un decal
 * sobre el cristal, no un marco.
 */
export function drawWellFingerprintGuide(
  ctx: CanvasRenderingContext2D,
  geo: FloorPreviewGeometry,
  view: WellGuideView,
  palette: WellGuidePalette,
  font: string,
): void {
  const locked = view.phase === 'LOCKED';
  const searching = view.phase === 'SEARCH';
  // Sin evidencia no hay nada que alinear: no se pinta ni la diana ni el zócalo
  // (evita cualquier texto flotante cuando el monitor está parado).
  if (view.phase === 'INACTIVE') return;

  ctx.save();
  traceQuad(ctx, geo);
  ctx.clip();

  // 1) DIANA: fija en el centro óptico de la lente. Es la referencia.
  //    Sin `shadowBlur`: el halo sobre trazos es de lo más caro del canvas 2D y
  //    este bucle compite con la captura de frames del detector de latidos.
  ctx.save();
  drawRidgeSet(ctx, geo, view.target.u, view.target.v, 1, {
    baseAlpha: view.targetAlpha * (searching ? 0.75 : 1) * view.breath,
    lineWidth: OV.RIDGE_WIDTH,
    glow: view.scan,
    tint: palette.tint,
    dashed: false,
    contract: locked ? view.lock : 0,
  });
  ctx.restore();

  if (searching) {
    drawSearchReticle(ctx, geo, view, palette);
    drawPlaceHint(ctx, geo, view, palette);
  }
  if (view.phase === 'ALIGN') drawCoverageRing(ctx, geo, view, palette);

  // 2) FANTASMA + HAZ: la posición real del dedo y hacia dónde llevarlo.
  if (view.ghostVisible) {
    ctx.save();
    drawRidgeSet(ctx, geo, view.ghost.u, view.ghost.v, view.ghostScale, {
      baseAlpha: view.ghostAlpha * view.breath,
      lineWidth: OV.RIDGE_WIDTH * 0.85,
      glow: view.scan,
      tint: palette.accent,
      dashed: true,
      contract: 0,
    });
    ctx.restore();
    if (view.offset > OV.DEADBAND) drawCorrectionBeam(ctx, geo, view, palette);
  }

  // 3) CONFIRMACIÓN: onda que colapsa con el latido cuando todo está OK.
  if (locked) {
    ctx.save();
    const s = 1.16 - 0.14 * view.lock;
    ctx.beginPath();
    strokeWellEllipse(ctx, geo, view.target.u, view.target.v, OV.RIDGE_U * s, OV.RIDGE_V * s);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = `rgba(${palette.accent}, ${(0.55 - 0.25 * view.lock).toFixed(3)})`;
    ctx.stroke();
    ctx.restore();
  }

  // 4) ZÓCALO: la instrucción viaja dentro del cristal, no en un cartel aparte.
  drawScrim(ctx, geo, view, palette, font);

  ctx.restore();
}