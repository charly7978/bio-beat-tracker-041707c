/**
 * GUÍA DE COLOCACIÓN DE LA VENTANA DE PREVISUALIZACIÓN.
 *
 * La ventana es la ÚNICA vista que el usuario tiene de la cámara (el resto del
 * monitor es un canvas opaco): si no sirve para colocar el dedo, no sirve. Este
 * módulo traduce la evidencia MEDIDA del pipeline a un dibujo registrado sobre
 * la imagen — una huella "diana" fija en el centro de la lente y una huella
 * "fantasma" en la posición real del tejido — más una corrección direccional.
 *
 * EVIDENCIA (nada aquí se inventa):
 *  - `evidence.centroid`  → dónde está el dedo de verdad (medido por frame).
 *  - `evidence.seal`      → cuánta lente cubre (tamaño del fantasma).
 *  - `evidence.pulsatility` → fuerza del pulso (/brillo del fantasma).
 *  - `evidence.alignment` → 1 = centrado perfecto.
 *  - `evidence.readiness` → veredicto agregado; sólo `READY` enciende el "OK".
 *
 * Por qué una huella y no un texto: la investigación de auto-captura biométrica
 * (NIST/Choong 2012; Guan et al. 2011) midió que un overlay de la imagen real
 * mejora el posicionamiento de la mano y que las instrucciones correctivas
 * derivadas de parámetros objetivos ("muévete arriba/abajo", "presiona más") son
 * las que suben la calidad de la muestra. El canal visual del dedo (dibujo
 * fantasma) se compara por registro — tarea en la que el sistema visual humano es
 * excelente — y el texto queda como alternativa accesible, no como guía única.
 *
 * Este módulo NO decide: `deriveWellGuide` sólo proyecta el veredicto canónico a
 * una vista. La decisión vive en `fingerPlacementEvidence` (colocación/presión)
 * y en `AcquisitionStabilizer` (adquisición).
 *
 * Sin dependencias de React: se puede testear con un `CanvasRenderingContext2D`
 * mínimo o con un doble de trazas.
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
 * `prefers-reduced-motion: reduce` cacheado (se consulta una vez y se escucha el
 * cambio). Con movimiento reducido la huella no barre: se queda encendida, que
 * comunica lo mismo sin animación.
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
  /** Todo correcto: lente sellada, centrada, pulso pleno, quietud y captura limpia. */
  | 'READY';

export interface WellGuideInput {
  /** Evidencia canónica del frame (undefined si el pipeline no entregó nada). */
  evidence?: FingerPlacementEvidence;
  /** Estadio de adquisición del estabilizador (otra fuente canónica). */
  acquisitionStage?: string;
  /** ¿Hay imagen de cámara disponible? Sin ella no hay nada que alinear. */
  hasVideo: boolean;
  /** Reloj del render (ms) para la animación del barrido. */
  nowMs: number;
  /** Latido real [0..1] (barrido del monitor) para el pulso de confirmación. */
  beatPulse: number;
  /** `prefers-reduced-motion`: congela el barrido y deja la huella estática. */
  reducedMotion: boolean;
}

export interface WellGuideView {
  readiness: WellReadiness;
  /** Instrucción corta; se apoya en el veredicto, no lo sustituye. */
  label: string;
  /** 1 = centrado perfecto. */
  alignment: number;
  /** Centro MEDIDO del tejido, en coordenadas del recorte del vídeo [0..1]. */
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
  /** Escala del fantasma: codifica el sellado medido. */
  ghostScale: number;
  /** Opacidad del fantasma: codifica la pulsatilidad medida. */
  ghostAlpha: number;
  /** Fase del barrido de crestas [0..1). */
  scan: number;
  /** Latido [0..1] para el anillo de confirmación. */
  lock: number;
  /** Respiración lenta [0.85..1] (estática con movimiento reducido). */
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

const LABEL: Record<WellReadiness, string> = {
  INACTIVE: 'SENSOR EN ESPERA',
  NO_CONTACT: 'APOYA EL DEDO EN LA LENTE',
  ALIGNING: 'AJUSTA LA POSICIÓN',
  PRESSURE: 'AJUSTA LA PRESIÓN',
  READY: 'SEÑAL ESTABLE · MANTÉN',
};

/**
 * Proyecta el veredicto a la vista de la ventana. Función PURA: misma entrada,
 * misma salida (el reloj sólo afecta a la fase de animación).
 */
export function deriveWellGuide(input: WellGuideInput): WellGuideView {
  const { evidence } = input;
  const reduced = input.reducedMotion;
  const scan = reduced
    ? 0.5
    : (input.nowMs % OV.SCAN_PERIOD_MS) / OV.SCAN_PERIOD_MS;
  const breath = reduced ? 1 : 0.85 + 0.15 * Math.sin(input.nowMs / 700);
  const lock = clamp01(input.beatPulse);
  const target = { u: 0.5, v: 0.5 };

  if (!evidence) {
    return {
      readiness: 'INACTIVE',
      label: LABEL.INACTIVE,
      alignment: 0,
      ghost: target,
      target,
      correction: { u: 0, v: 0 },
      offset: 0,
      severity: 0,
      ghostVisible: false,
      ghostScale: 1,
      ghostAlpha: 0,
      scan,
      lock,
      breath,
    };
  }

  const alignment = clamp01(evidence.alignment);
  // El centroide es del frame completo; la ventana muestra el recorte central.
  const rawU = frameToCrop(evidence.centroid.x);
  const rawV = frameToCrop(evidence.centroid.y);
  const ghost = { u: clamp01(rawU), v: clamp01(rawV) };
  const correction = { u: 0.5 - rawU, v: 0.5 - rawV };
  const offset = Math.hypot(correction.u, correction.v);
  const severity = clamp01(offset / OV.MAX_OFFSET);

  const sealNorm = clamp01(
    (evidence.seal - COVER_MIN) / Math.max(1e-6, COVER_GOOD - COVER_MIN),
  );

  let readiness: WellReadiness;
  if (evidence.placement === 'NO_FINGER') readiness = 'NO_CONTACT';
  else if (evidence.readiness === 'READY' && input.acquisitionStage === 'READY') {
    readiness = 'READY';
  } else if (evidence.readiness === 'PRESSURE') readiness = 'PRESSURE';
  else readiness = 'ALIGNING';

  // La huella fantasma sólo se dibuja cuando hay tejido y el registro no está
  // conseguido: con READY la diana se queda sola y encendida (más claro = mejor).
  const ghostVisible =
    input.hasVideo && readiness !== 'NO_CONTACT' && readiness !== 'READY';

  return {
    readiness,
    label: LABEL[readiness],
    alignment,
    ghost,
    target,
    correction,
    offset,
    severity,
    ghostVisible,
    ghostScale: 0.55 + 0.45 * sealNorm,
    ghostAlpha: 0.20 + 0.34 * clamp01(evidence.pulsatility),
    scan,
    lock,
    breath,
  };
}

// === Proyección exacta del recorte sobre el plano de la ventana ================

/**
 * Proyecta un punto del recorte del vídeo (u,v ∈ [0,1]) al plano de la ventana.
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
    const depth = zn + (1 - v) * span;
    const s = zNear / depth;
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
 *
 * @param scale multiplicador del tamaño (el fantasma codifica el sellado).
 */
export function fingerprintRidges(
  cu: number,
  cv: number,
  scale: number,
  count: number = OV.RIDGES,
  samplesPerRidge = 44,
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
    // Las crestas exteriores se abren (delta) en vez de cerrarse del todo.
    const gap = k >= n - 3 ? 0.55 + 0.35 * (k - (n - 3)) : 0;
    const start = -Math.PI / 2 + gap / 2 + 0.22 * t;
    const sweep = Math.PI * 2 - gap;
    const pts: RidgePoint[] = [];
    for (let i = 0; i <= samplesPerRidge; i++) {
      const a = start + (i / samplesPerRidge) * sweep;
      // El bucle se estrangula ligeramente arriba y abajo (forma de huella real).
      const waist = 1 + 0.10 * Math.cos(2 * a);
      pts.push({
        u: cu + Math.cos(a) * ru * waist,
        v: cv + Math.sin(a) * rv,
      });
    }
    ridges.push(pts);
  }
  return ridges;
}

/**
 * Plantilla de crestas centrada en el origen y a escala 1. Se construye una sola
 * vez: la forma no cambia entre frames, sólo el centro y la escala, así que el
 * bucle de pintado no asigna nada (importa a 60 fps en un móvil).
 */
let ridgeTemplate: RidgePoint[][] | null = null;
function unitRidges(): RidgePoint[][] {
  if (!ridgeTemplate) ridgeTemplate = buildRidges(0, 0, 1, OV.RIDGES, 44);
  return ridgeTemplate;
}

// === Presupuesto de transparencia ==============================================

/**
 * Alpha de cada capa que se pinta ENCIMA del vídeo. La suma de todas es lo que
 * el usuario percibe como "opacidad" de la ventana: antes se restaba hasta el
 * 68% de la luz en el borde lejano y el dedo quedaba en penumbra justo donde hay
 * que verlo. Ahora ninguna capa pasa de 0.30 y el peor caso deja pasar ≥ 60%.
 */
export const WELL_VEIL = {
  /** Tinte del veredicto: sólo para leer el estado, no para tapar. */
  TINT_MIN: 0.03,
  TINT_MAX: 0.04,
  /** Sombra de profundidad (0 = borde lejano, 1 = borde cercano). */
  DEPTH_FAR: 0.30,
  DEPTH_MID: 0.10,
  DEPTH_NEAR: 0.03,
  /** Reflejo del horizonte en el borde lejano. */
  GLASS_FAR: 0.05,
} as const;

function depthVeilAt(v: number): number {
  const t = clamp01(v);
  if (t <= 0.55) {
    const k = t / 0.55;
    return WELL_VEIL.DEPTH_FAR + (WELL_VEIL.DEPTH_MID - WELL_VEIL.DEPTH_FAR) * k;
  }
  const k = (t - 0.55) / 0.45;
  return WELL_VEIL.DEPTH_MID + (WELL_VEIL.DEPTH_NEAR - WELL_VEIL.DEPTH_MID) * k;
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
  const a = 1 - (1 - tint) * (1 - depthVeilAt(v)) * (1 - glass);
  return clamp(a, 0, 1);
}

// === Pintado ===================================================================

export interface WellGuidePalette {
  /** "r,g,b" del veredicto (mismo lenguaje de color que el gauge). */
  tint: string;
  /** "r,g,b" del acento de corrección / confirmación. */
  accent: string;
}

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
  samples = 64,
): void {
  const { zn, zf, halfW } = geo.quad;
  const span = zf - zn;
  const vpX = geo.proj.vpX;
  const horizonY = geo.proj.horizonY;
  const floorSpanY = geo.proj.floorSpanY;
  const zNear = geo.proj.zNear;
  for (let i = 0; i <= samples; i++) {
    const a = (i / samples) * Math.PI * 2;
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
  if (d > 0.5) d = 1 - d; // el barrido es cíclico
  return Math.exp(-(d * d) / 0.032);
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
  },
): void {
  const ridges = unitRidges();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let k = 0; k < ridges.length; k++) {
    const a = clamp01(opts.baseAlpha * (0.45 + 0.55 * ridgeGlow(opts.glow, k, ridges.length)));
    if (a <= 0.01) continue;
    ctx.beginPath();
    traceRidge(ctx, geo, cu, cv, scale, ridges[k]);
    ctx.setLineDash(opts.dashed ? [4, 5] : []);
    ctx.lineWidth = opts.lineWidth * (0.85 + 0.35 * (k / Math.max(1, ridges.length - 1)));
    ctx.strokeStyle = `rgba(${opts.tint}, ${a.toFixed(3)})`;
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

/**
 * Dibuja la guía de colocación DENTRO de la ventana.
 *
 * Debe llamarse después del vídeo y de los velos, y antes del bisel: la huella
 * es un decal sobre el cristal, no un marco.
 */
export function drawWellFingerprintGuide(
  ctx: CanvasRenderingContext2D,
  geo: FloorPreviewGeometry,
  view: WellGuideView,
  palette: WellGuidePalette,
): void {
  const locked = view.readiness === 'READY';
  // La DIANA manda: es la referencia con la que se compara el dedo. El fantasma
  // es secundario a propósito (si brillara más, el ojo seguiría al dedo y no a la
  // diana, que es justo lo que hay que corregir).
  const baseAlpha = (locked ? 0.82 : 0.62) * view.breath;

  ctx.save();
  traceQuad(ctx, geo);
  ctx.clip();

  // 1) HUELLA DIANA: fija en el centro óptico de la lente. Es la referencia.
  //    Sin halo: el resplandor rellenaba los surcos y la huella se leía como una
  //    mancha. Las crestas tienen que verse separadas para poder registrarlas.
  ctx.save();
  ctx.shadowColor = `rgba(${palette.tint}, 0.30)`;
  ctx.shadowBlur = locked ? 4 + 4 * view.lock : 0;
  drawRidgeSet(ctx, geo, view.target.u, view.target.v, 1, {
    baseAlpha,
    lineWidth: 1.6,
    glow: view.scan,
    tint: palette.tint,
    dashed: false,
  });
  ctx.restore();

  // 2) HUELLA FANTASMA: posición y tamaño REALES del tejido. Arreglar el
  //    registro = hacer que las dos huellas se superpongan.
  if (view.ghostVisible) {
    ctx.save();
    drawRidgeSet(ctx, geo, view.ghost.u, view.ghost.v, view.ghostScale, {
      baseAlpha: view.ghostAlpha,
      lineWidth: 1.1,
      glow: view.scan,
      tint: palette.accent,
      dashed: true,
    });
    ctx.restore();

    // 3) CORRECCIÓN DIRECCIONAL: chevrones del fantasma hacia la diana. Si el
    //    descentrado cae en la zona muerta no se dibuja nada.
    if (view.offset > OV.DEADBAND) {
      drawCorrectionChevrons(ctx, geo, view, palette);
    }
  }

  // 4) CONFIRMACIÓN: dos anillos que colapsan con el latido cuando todo está OK.
  if (locked) {
    ctx.save();
    const shrink = 0.16 * view.lock;
    for (let i = 0; i < 2; i++) {
      const s = 1.18 - shrink + i * 0.16;
      ctx.beginPath();
      strokeWellEllipse(
        ctx,
        geo,
        view.target.u,
        view.target.v,
        OV.RIDGE_U * 1.05 * s,
        OV.RIDGE_V * 1.05 * s,
      );
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = `rgba(${palette.accent}, ${(0.42 - 0.18 * i).toFixed(3)})`;
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.restore();
}

/**
 * Chevrones en el borde del fantasma apuntando a la diana. La dirección se
 * calcula en PANTALLA (proyectando ambos centros), así el dibujo apunta de
 * verdad hacia donde el usuario ve que tiene que mover el dedo.
 */
function drawCorrectionChevrons(
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
  if (dist < 5) return;

  const ux = dx / dist;
  const uy = dy / dist;
  const angle = Math.atan2(uy, ux);
  const startX = from.x + ux * 12;
  const startY = from.y + uy * 12;
  const strength = clamp01(
    (view.severity - OV.DEADBAND / Math.max(1e-6, OV.MAX_OFFSET)) /
      (1 - OV.DEADBAND / Math.max(1e-6, OV.MAX_OFFSET)),
  );
  const count = 1 + Math.round(strength * 2);

  ctx.save();
  ctx.translate(startX, startY);
  ctx.rotate(angle);
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const alpha = 0.65 * (1 - i * 0.28) * (0.6 + 0.4 * view.breath);
    const x = i * 7;
    ctx.beginPath();
    ctx.moveTo(x - 4, -4.5);
    ctx.lineTo(x + 1.5, 0);
    ctx.lineTo(x - 4, 4.5);
    ctx.strokeStyle = `rgba(${palette.accent}, ${alpha.toFixed(3)})`;
    ctx.stroke();
  }
  ctx.restore();
}