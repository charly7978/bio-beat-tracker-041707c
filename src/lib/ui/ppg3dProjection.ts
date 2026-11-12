/**
 * PPG 3D PROJECTION — Capa de profundidad real para el monitor cardíaco.
 *
 * Render en CANVAS 2D PURO con proyección en perspectiva (modelo pinhole / ley 1/z).
 * Implementa dos elementos validados de visualización 3D:
 *   1) GRILLA-PISO en perspectiva: filas de profundidad comprimidas hacia el horizonte,
 *      columnas de tiempo convergentes al punto de fuga.
 *   2) ONDA como CINTA 3D EXTRUIDA: cresta frontal + cara lateral + grosor + sombra.
 *
 * Sin dependencias de Three.js / React-Three-Fiber.
 */
import { WINDOW_MS, type PpgRenderState } from './ppgCanvasRenderer';
import { clamp } from '../../utils/math';
import { isLocalMax, isLocalMin, isDicroticNotch, DIC_QUALITY_MIN } from './waveFiducials';

const FONT = '"SF Mono", Consolas, "Roboto Mono", monospace';

export interface WaveCoord {
  x: number;
  y: number;
  isArr: boolean;
  val: number;
}

export interface WaveGeom {
  waveBaseY: number;
  waveH: number;
  midValue: number;
}

interface ProjPoint {
  x: number;
  y: number;
  scale: number;
}

export interface Projector {
  horizonY: number;
  nearY: number;
  vpX: number;
  plotX: number;
  plotW: number;
  zNear: number;
  zFar: number;
  floorSpanY: number;
  project: (u: number, d: number, h: number) => ProjPoint;
  scaleAt: (d: number) => number;
  floorPoint: (xWorld: number, zWorld: number) => ProjPoint;
}

// === Parámetros de cámara virtual ===
const Z_NEAR = 1;
const Z_FAR = 5.2;
const HORIZON_FRAC = 0.08;
const NEAR_MARGIN_PX = 30;
const MAX_LIFT_FRAC = 0.62;
const WAVE_D_FRONT = 0.05;
const WAVE_D_BACK = 0.17;

// === Parámetros de grilla ===
const GRID_COLS = 11;
/** Ensancha el piso lateralmente (>1 = más ancho). Mantiene el tamaño de celda
 *  (cellPx = plotW/GRID_COLS) y extiende columnas/filas hacia los lados. */
const GRID_FLOOR_WIDTH_MULT = 1.6;
/** Velocidad del efecto "cinta de correr": filas por segundo desplazándose hacia
 *  el observador (hacia abajo en pantalla). 0 = estático. */
const GRID_SCROLL_CELLS_PER_SEC = 0.7;
const GRID_MAJOR_MOD = 5;
const GRID_ROW_MIN_GAP = 2;
const GRID_FADE_BASE = 0.3;
const GRID_FADE_WEIGHT = 0.7;
const GRID_ROW_ALPHA: Record<string, number> = { major: 0.55, minor: 0.25 };
const GRID_COL_NEAR_ALPHA: Record<string, number> = { major: 0.55, minor: 0.25 };
const GRID_COL_FAR_ALPHA = 0.05;
const GRID_ROW_LW: Record<string, number> = { major: 1.2, minor: 0.7 };
const GRID_COL_LW: Record<string, number> = { major: 1.1, minor: 0.65 };
const GRID_FRONT_LW = 1.6;
const GRID_HORIZON_ALPHA = 0.35;

// === Parámetros de onda y cinta ===
const FLOOR_SHADOW_ALPHA = 0.12;
const FLOOR_SHADOW_LW = 6;

const TOP_FACE_ALPHA = 0.16;

const WALL_TOP_ALPHA = 0.34;
const WALL_TOP_HIDDEN_ALPHA = 0.12;
const WALL_BOTTOM_ALPHA = 0.02;
const WALL_ARR_ALPHA = 0.50;
const WALL_ARR_HIDDEN_ALPHA = 0.20;

const BACK_CREST_ALPHA = 0.28;
const BACK_CREST_LW = 1;

const CREST_ARR_ALPHA = 0.9;
const CREST_SHADOW_ALPHA = 0.55;
const CREST_SHADOW_BLUR = 10;
const CREST_LW = 2.2;
const CREST_HIDDEN_LW = 1.6;
const CREST_HIDDEN_COLOR = 'rgba(148, 163, 184, 0.5)';

const ARR_RAY_ALPHA_BASE = 0.35;
const ARR_RAY_ALPHA_RANGE = 0.45;
const ARR_RAY_LW_BASE = 2;
const ARR_RAY_LW_RANGE = 3;
const ARR_RAY_SHADOW_BLUR = 6;
const ARR_LABEL_FRAC = 0.75;

const PEAK_RADIUS_BASE = 2.6;
const PEAK_RADIUS_SCALE = 1.6;
const PEAK_SHADOW_BLUR = 8;
const PEAK_ARR_RING_OFFSET = 4;
const PEAK_ARR_RING_ALPHA = 0.65;
const PEAK_ARR_RING_LW = 1.4;

const DIA_RADIUS = 2.4;
const DIA_LW = 1.2;
const DIA_COLOR = '#94a3b8';

const DIC_RADIUS = 2.2;

const HEAD_HALO_BASE = 6;
const HEAD_HALO_PULSE = 8;
const HEAD_HALO_SCALE_BASE = 0.7;
const HEAD_HALO_SCALE_RANGE = 0.3;
const HEAD_CORE_RADIUS = 3;

// === Paleta ===
const C = {
  signal: '34, 197, 94',
  signalBright: '74, 222, 128',
  arr: '239, 68, 68',
  cyan: '0, 242, 255',
  gridMinor: '255, 255, 255',
};

/** Itera sobre segmentos contiguos de igual ritmo en [0, end). */
function forRhythmSegments(
  end: number,
  isArr: (i: number) => boolean,
  fn: (s: number, e: number, arr: boolean) => void,
): void {
  let s = 0;
  while (s < end) {
    const arr = isArr(s);
    let e = s + 1;
    while (e < end && isArr(e) === arr) e++;
    fn(s, e, arr);
    s = e;
  }
}

// === Proyector ==============================================================

export function makeProjector(state: PpgRenderState): Projector {
  const { plot } = state.layout;
  const intensity = clamp(state.threeD?.intensity ?? 1, 0.6, 1.4);

  const horizonY = plot.y + plot.h * HORIZON_FRAC;
  const nearY = plot.y + plot.h - NEAR_MARGIN_PX;
  const vpX = plot.x + plot.w * 0.5;
  const floorSpanY = Math.max(40, nearY - horizonY);
  const maxLift = floorSpanY * MAX_LIFT_FRAC * intensity;

  const zAt = (d: number) => Z_NEAR + clamp(d, 0, 1) * (Z_FAR - Z_NEAR);
  const scaleAt = (d: number) => Z_NEAR / zAt(d);

  const project = (u: number, d: number, h: number): ProjPoint => {
    const s = scaleAt(d);
    return {
      x: vpX + (u - 0.5) * plot.w * s,
      y: horizonY + floorSpanY * s - h * maxLift * s,
      scale: s,
    };
  };

  const floorPoint = (xWorld: number, zWorld: number): ProjPoint => {
    const s = Z_NEAR / zWorld;
    return { x: vpX + xWorld * s, y: horizonY + floorSpanY * s, scale: s };
  };

  return {
    horizonY, nearY, vpX, plotX: plot.x, plotW: plot.w,
    zNear: Z_NEAR, zFar: Z_FAR, floorSpanY, project, scaleAt, floorPoint,
  };
}

// === Grilla-piso ============================================================

export function drawGrid3D(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const proj = makeProjector(state);
  const { plot } = state.layout;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  ctx.fillStyle = '#000000';
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

  // Horizonte (punto de fuga).
  ctx.strokeStyle = `rgba(${C.gridMinor}, ${GRID_HORIZON_ALPHA})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plot.x, proj.horizonY);
  ctx.lineTo(plot.x + plot.w, proj.horizonY);
  ctx.stroke();

  // Grilla cuadrada en perspectiva (piso ensanchado por GRID_FLOOR_WIDTH_MULT).
  const cellPx = proj.plotW / GRID_COLS;
  const halfCols = Math.ceil((GRID_COLS * GRID_FLOOR_WIDTH_MULT) / 2);
  const halfX = halfCols * cellPx;
  const dZ = cellPx / proj.floorSpanY;

  // Efecto "cinta de correr": las filas se desplazan continuamente hacia el
  // observador (hacia abajo en pantalla). `phase` recorre [0, dZ) y mueve el
  // origen de las filas en Z; el patrón mayor/menor se ancla a un índice
  // ABSOLUTO (kAbs) para que no parpadee al reciclar una fila en cada vuelta.
  const scrollCells = (state.now / 1000) * GRID_SCROLL_CELLS_PER_SEC;
  const cellsScrolled = Math.floor(scrollCells);
  const phase = (scrollCells - cellsScrolled) * dZ; // [0, dZ)

  // Filas.
  let prevRowY = Number.POSITIVE_INFINITY;
  let k = 0;
  for (let z = proj.zNear + (dZ - phase); z <= proj.zFar + 1e-6; z += dZ, k++) {
    const a = proj.floorPoint(-halfX, z);
    if (prevRowY - a.y < GRID_ROW_MIN_GAP) break;
    const b = proj.floorPoint(halfX, z);
    const kAbs = k + cellsScrolled;
    const isMajor = (((kAbs % GRID_MAJOR_MOD) + GRID_MAJOR_MOD) % GRID_MAJOR_MOD) === 0;
    const key = isMajor ? 'major' : 'minor';
    const fade = GRID_FADE_BASE + GRID_FADE_WEIGHT * a.scale;
    ctx.strokeStyle = `rgba(${C.gridMinor}, ${(GRID_ROW_ALPHA[key] * fade).toFixed(3)})`;
    ctx.lineWidth = GRID_ROW_LW[key];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    prevRowY = a.y;
  }

  // Columnas.
  for (let k = -halfCols; k <= halfCols; k++) {
    const xw = k * cellPx;
    const near = proj.floorPoint(xw, proj.zNear);
    const far = proj.floorPoint(xw, proj.zFar);
    const isMajor = k % GRID_MAJOR_MOD === 0;
    const key = isMajor ? 'major' : 'minor';
    const g = ctx.createLinearGradient(near.x, near.y, far.x, far.y);
    g.addColorStop(0, `rgba(${C.gridMinor}, ${GRID_COL_NEAR_ALPHA[key]})`);
    g.addColorStop(1, `rgba(${C.gridMinor}, ${GRID_COL_FAR_ALPHA})`);
    ctx.strokeStyle = g;
    ctx.lineWidth = GRID_COL_LW[key];
    ctx.beginPath();
    ctx.moveTo(near.x, near.y);
    ctx.lineTo(far.x, far.y);
    ctx.stroke();
  }

  // Borde frontal.
  const fl = proj.floorPoint(-halfX, proj.zNear);
  const fr = proj.floorPoint(halfX, proj.zNear);
  ctx.strokeStyle = `rgba(${C.signal}, ${GRID_ROW_ALPHA.major})`;
  ctx.lineWidth = GRID_FRONT_LW;
  ctx.beginPath();
  ctx.moveTo(fl.x, fl.y);
  ctx.lineTo(fr.x, fr.y);
  ctx.stroke();

  drawGridReferences3D(ctx, proj, plot, state.amplitudeStats);
  ctx.restore();
}

function drawGridReferences3D(
  ctx: CanvasRenderingContext2D,
  proj: Projector,
  plot: { x: number; y: number; w: number; h: number },
  stats: { min: number; max: number; range: number },
): void {
  const range = stats.range > 1 ? stats.range : 1;

  ctx.textAlign = 'left';
  for (let i = 0; i <= 4; i++) {
    const h = 1 - i / 4;
    const val = stats.max - (i / 4) * range;
    const p = proj.project(0, WAVE_D_FRONT, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.x + 2, p.y);
    ctx.lineTo(plot.x + 8, p.y);
    ctx.stroke();
    ctx.font = `bold 10px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(val.toFixed(0), plot.x + 10, p.y + 3);
  }

  const seconds = Math.floor(WINDOW_MS / 1000);
  ctx.font = `bold 10px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  for (let sBack = 0; sBack <= seconds; sBack++) {
    const u = 1 - (sBack * 1000) / WINDOW_MS;
    const xWorld = (u - 0.5) * proj.plotW;
    const p = proj.floorPoint(xWorld, proj.zNear);
    ctx.fillText(`-${sBack}s`, p.x, proj.nearY + 13);
  }
}

// === Cinta 3D de la onda ===================================================

export function drawWaveRibbon3D(
  ctx: CanvasRenderingContext2D,
  state: PpgRenderState,
  coords: WaveCoord[],
  geom: WaveGeom,
): void {
  if (coords.length < 2 || geom.waveH <= 0) return;
  const proj = makeProjector(state);
  const { plot } = state.layout;
  const revealed = state.traceRevealed;

  const hOf = (c: WaveCoord) => clamp((geom.waveBaseY - c.y) / geom.waveH, 0, 1);
  const uOf = (c: WaveCoord) => clamp((c.x - plot.x) / plot.w, 0, 1);

  const Pf: ProjPoint[] = [];
  const Pb: ProjPoint[] = [];
  const Pfloor: ProjPoint[] = [];
  for (const c of coords) {
    const u = uOf(c);
    const h = hOf(c);
    Pf.push(proj.project(u, WAVE_D_FRONT, h));
    Pb.push(proj.project(u, WAVE_D_BACK, h));
    Pfloor.push(proj.project(u, WAVE_D_FRONT, 0));
  }
  const n = Pf.length;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 1) Sombra/huella en el piso (verde, sin rojo — el rojo va solo en el rayo de pico arr).
  if (revealed) {
    ctx.beginPath();
    ctx.moveTo(Pfloor[0].x, Pfloor[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(Pfloor[i].x, Pfloor[i].y);
    ctx.strokeStyle = `rgba(${C.signal}, ${FLOOR_SHADOW_ALPHA})`;
    ctx.lineWidth = FLOOR_SHADOW_LW;
    ctx.stroke();
  }

  // 2) Cara superior de la cinta (grosor 3D).
  if (revealed) {
    ctx.beginPath();
    ctx.moveTo(Pf[0].x, Pf[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(Pf[i].x, Pf[i].y);
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(Pb[i].x, Pb[i].y);
    ctx.closePath();
    ctx.fillStyle = `rgba(${C.signalBright}, ${TOP_FACE_ALPHA})`;
    ctx.fill();
  }

  // 3) Cara frontal (pared) segmentada por ritmo en una sola pasada.
  //    Cada segmento usa su propio gradiente vertical (verde normal, rojo arr).
  forRhythmSegments(n, i => coords[i].isArr, (s, e, arr) => {
    const grad = ctx.createLinearGradient(0, proj.horizonY, 0, proj.nearY);
    if (arr) {
      const a = revealed ? WALL_ARR_ALPHA : WALL_ARR_HIDDEN_ALPHA;
      grad.addColorStop(0, `rgba(${C.arr}, ${a})`);
      grad.addColorStop(1, `rgba(${C.arr}, ${WALL_BOTTOM_ALPHA})`);
    } else {
      const a = revealed ? WALL_TOP_ALPHA : WALL_TOP_HIDDEN_ALPHA;
      grad.addColorStop(0, `rgba(${C.signal}, ${a})`);
      grad.addColorStop(1, `rgba(${C.signal}, ${WALL_BOTTOM_ALPHA})`);
    }
    ctx.beginPath();
    ctx.moveTo(Pfloor[s].x, Pfloor[s].y);
    for (let i = s; i < e; i++) ctx.lineTo(Pf[i].x, Pf[i].y);
    for (let i = e - 1; i >= s; i--) ctx.lineTo(Pfloor[i].x, Pfloor[i].y);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  });

  // 4) Cresta trasera (volumen).
  if (revealed) {
    ctx.beginPath();
    ctx.moveTo(Pb[0].x, Pb[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(Pb[i].x, Pb[i].y);
    ctx.strokeStyle = `rgba(${C.signal}, ${BACK_CREST_ALPHA})`;
    ctx.lineWidth = BACK_CREST_LW;
    ctx.stroke();
  }

  // 5) Cresta frontal segmentada por ritmo.
  forRhythmSegments(n - 1, i => coords[i].isArr, (s, e, arr) => {
    ctx.beginPath();
    ctx.moveTo(Pf[s].x, Pf[s].y);
    for (let i = s + 1; i <= e; i++) ctx.lineTo(Pf[i].x, Pf[i].y);
    if (revealed) {
      ctx.strokeStyle = arr ? `rgba(${C.arr}, ${CREST_ARR_ALPHA})` : `rgb(${C.signalBright})`;
      ctx.shadowColor = arr ? `rgba(${C.arr}, ${CREST_SHADOW_ALPHA})` : `rgba(${C.signal}, ${CREST_SHADOW_ALPHA})`;
      ctx.shadowBlur = CREST_SHADOW_BLUR;
      ctx.lineWidth = CREST_LW;
    } else {
      ctx.strokeStyle = CREST_HIDDEN_COLOR;
      ctx.shadowBlur = 0;
      ctx.lineWidth = CREST_HIDDEN_LW;
    }
    ctx.stroke();
  });
  ctx.shadowBlur = 0;

  // 6) Marcadores fiduciales (SYS / ARR / DIA / DIC) + rayo rojo arr al fondo.
  if (revealed) {
    const quality = state.props.quality ?? 0;
    const vals = coords.map(c => c.val);
    ctx.textAlign = 'center';

    for (let i = 2; i < n - 2; i++) {
      const isArr = coords[i].isArr;
      const p = Pf[i];

      // Pico sistólico (ARR / SYS).
      if (isLocalMax(i, vals, geom.midValue)) {
        const r = PEAK_RADIUS_BASE + p.scale * PEAK_RADIUS_SCALE;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = isArr ? `rgb(${C.arr})` : '#ffffff';
        ctx.shadowColor = isArr ? `rgb(${C.arr})` : `rgb(${C.cyan})`;
        ctx.shadowBlur = PEAK_SHADOW_BLUR;
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.font = `bold 9px ${FONT}`;
        ctx.fillStyle = isArr ? `rgb(${C.arr})` : `rgb(${C.cyan})`;
        ctx.fillText(vals[i].toFixed(1), p.x, p.y - 11);
        ctx.font = `7px ${FONT}`;
        ctx.fillStyle = isArr ? '#fecaca' : 'rgba(255, 255, 255, 0.75)';
        ctx.fillText(isArr ? 'ARR' : 'SYS', p.x, p.y - 21);

        if (isArr) {
          // Anillo exterior rojo.
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + PEAK_ARR_RING_OFFSET, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${C.arr}, ${PEAK_ARR_RING_ALPHA})`;
          ctx.lineWidth = PEAK_ARR_RING_LW;
          ctx.stroke();

          // Rayo rojo desde el piso del pico ARR hacia la fuga.
          const fp = Pfloor[i];
          const dx = proj.vpX - fp.x;
          const dy = proj.horizonY - fp.y;
          const d = Math.hypot(dx, dy);
          if (d > 1) {
            const nx = dx / d, ny = dy / d;
            const fade = Math.min(1, (fp.y - proj.horizonY) / (proj.nearY - proj.horizonY));
            ctx.beginPath();
            ctx.moveTo(fp.x, fp.y);
            ctx.lineTo(fp.x + nx * d, fp.y + ny * d);
            ctx.strokeStyle = `rgba(${C.arr}, ${(ARR_RAY_ALPHA_BASE + ARR_RAY_ALPHA_RANGE * fade).toFixed(3)})`;
            ctx.lineWidth = ARR_RAY_LW_BASE + ARR_RAY_LW_RANGE * fade;
            ctx.shadowColor = `rgba(${C.arr}, 0.4)`;
            ctx.shadowBlur = ARR_RAY_SHADOW_BLUR;
            ctx.stroke();
            ctx.shadowBlur = 0;

            // Etiqueta ARR en la fuga.
            ctx.font = `bold 10px ${FONT}`;
            ctx.fillStyle = `rgba(${C.arr}, ${PEAK_ARR_RING_ALPHA})`;
            ctx.textAlign = 'center';
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 4;
            ctx.fillText('ARR', fp.x + nx * d * ARR_LABEL_FRAC, fp.y + ny * d * ARR_LABEL_FRAC);
            ctx.shadowBlur = 0;
          }
        }
      }

      // Valle diastólico (DIA).
      if (isLocalMin(i, vals, geom.midValue)) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, DIA_RADIUS, 0, Math.PI * 2);
        ctx.strokeStyle = DIA_COLOR;
        ctx.lineWidth = DIA_LW;
        ctx.stroke();
        ctx.font = `bold 9px ${FONT}`;
        ctx.fillStyle = DIA_COLOR;
        ctx.fillText(vals[i].toFixed(1), p.x, p.y + 15);
        ctx.font = `7px ${FONT}`;
        ctx.fillText('DIA', p.x, p.y + 24);
      }

      // Muesca dícrota (DIC).
      if (isDicroticNotch(i, vals, geom.midValue)) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, DIC_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${C.cyan}, 0.6)`;
        ctx.fill();
        if (quality >= DIC_QUALITY_MIN) {
          ctx.font = `7px ${FONT}`;
          ctx.fillStyle = `rgba(${C.cyan}, 0.85)`;
          ctx.fillText('DIC', p.x, p.y - 7);
        }
      }
    }
  }

  // 7) Halo pulsátil en la punta conductora.
  const head = Pf[n - 1];
  const headArr = coords[n - 1].isArr;
  const pulse = Math.max(state.sweepPulse, 0.04);
  const headR = (HEAD_HALO_BASE + pulse * HEAD_HALO_PULSE) * (HEAD_HALO_SCALE_BASE + HEAD_HALO_SCALE_RANGE * head.scale);
  ctx.beginPath();
  ctx.arc(head.x, head.y, headR, 0, Math.PI * 2);
  ctx.fillStyle = revealed
    ? headArr ? `rgba(${C.arr}, 0.3)` : `rgba(${C.cyan}, 0.3)`
    : 'rgba(148, 163, 184, 0.18)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(head.x, head.y, HEAD_CORE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  ctx.restore();
}
