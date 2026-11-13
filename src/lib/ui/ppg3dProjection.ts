/**
 * PPG 3D PROJECTION â€” Capa de profundidad real para el monitor cardÃ­aco.
 *
 * Render en CANVAS 2D PURO con proyecciÃ³n en perspectiva (modelo pinhole / ley 1/z).
 * Implementa dos elementos validados de visualizaciÃ³n 3D:
 *   1) GRILLA-PISO en perspectiva (tÃ©cnica "outrun/synthwave floor"): las filas de
 *      profundidad se comprimen hacia un horizonte y las columnas de tiempo convergen
 *      a un punto de fuga â†’ profundidad real.
 *   2) ONDA como CINTA 3D EXTRUIDA (ribbon): cresta frontal honesta + cara lateral
 *      hacia el piso + cara superior con grosor en profundidad + sombra proyectada.
 *
 * CLAVE: la onda NO se recalcula. Reusa EXACTAMENTE las mismas coordenadas honestas
 * (`coords`) que produce el render 2D (mismo gate de strength, mismo mapeo de amplitud,
 * misma marcaciÃ³n de arritmia, mismo barrido temporal). El 3D es sÃ³lo presentaciÃ³n:
 * la actividad cardÃ­aca del dedo se representa idÃ©ntica al modo 2D.
 *
 * Sin dependencias de Three.js / React-Three-Fiber (no compilan en mÃ³vil, son pesadas).
 * SÃ³lo importa el TIPO del renderer (erased en runtime) â†’ sin ciclos de import.
 */
import { traceMeasuredPath } from './measuredTrace';
import { WINDOW_MS, type PpgRenderState } from './ppgCanvasRenderer';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import {
  WELL_CROP_FRAC,
  WELL_VEIL,
  deriveWellGuide,
  drawWellFingerprintGuide,
  prefersReducedMotion,
  wellTintAlpha,
} from './fingerPlacementOverlay';

/** Fuente monoespaciada (misma familia que el renderer 2D). */
const FONT = '"SF Mono", Consolas, "Roboto Mono", monospace';

/** Coordenada honesta de la onda, idÃ©ntica a la que arma `drawSignal` en 2D. */
export interface WaveCoord {
  x: number;
  y: number;
  isArr: boolean;
  val: number;
}

/** GeometrÃ­a 2D de la zona de onda, para recuperar amplitud normalizada y tiempo. */
export interface WaveGeom {
  waveBaseY: number;
  waveH: number;
  midValue: number;
}

/** Punto proyectado en pantalla + escala de perspectiva en esa profundidad. */
export interface ProjPoint {
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
  /** Altura en pantalla (px) del piso visible: nearY - horizonY. */
  floorSpanY: number;
  /**
   * Proyecta un punto del escenario:
   *  - u  [0..1] eje lateral/tiempo (0 = izquierda/antiguo, 1 = derecha/reciente)
   *  - d  [0..1] profundidad (0 = cerca/frente, 1 = lejos/horizonte)
   *  - h  [0..1] altura sobre el piso (0 = piso, 1 = altura mÃ¡xima)
   */
  project: (u: number, d: number, h: number) => ProjPoint;
  scaleAt: (d: number) => number;
  /**
   * Proyecta un punto del PISO en coordenadas-mundo:
   *  - xWorld: desplazamiento lateral en px-a-distancia-cercana (0 = centro)
   *  - zWorld: profundidad real [zNear..zFar]
   * Las unidades de xWorld y de la profundidad comparten escala â†’ celdas cuadradas.
   */
  floorPoint: (xWorld: number, zWorld: number) => ProjPoint;
}

// === CalibraciÃ³n de la cÃ¡mara virtual ===========================================
const Z_NEAR = 1;
const Z_FAR = 5.2; // compresiÃ³n de profundidad (mayor = horizonte mÃ¡s comprimido)
// Grilla mÃ¡s GRANDE: horizonte subido (mÃ¡s piso visible) y margen inferior menor.
const HORIZON_FRAC = 0.08; // horizonte mÃ¡s alto â†’ piso (grilla) mÃ¡s grande
const NEAR_MARGIN_PX = 30; // sitio para el tacograma + etiquetas de tiempo del eje
const MAX_LIFT_FRAC = 0.62; // altura mÃ¡x. de la onda como fracciÃ³n del piso visible
// Banda de profundidad que ocupa la cinta de onda (grosor 3D real del trazo).
const WAVE_D_FRONT = 0.05;
const WAVE_D_BACK = 0.17;

// Paleta local (evita import de valores desde el renderer â†’ sin ciclo en runtime).
const C = {
  signal: '104, 221, 192', // verde ECG
  signalBright: '151, 237, 217',
  arr: '239, 68, 68',
  cyan: '131, 204, 228',
  horizon: '103, 232, 249',
  gridMinor: '137, 165, 180', // lÃ­neas de grilla BLANCAS
};

export function makeProjector(state: PpgRenderState): Projector {
  const { plot } = state.layout;
  const intensity = clamp(state.threeD?.intensity ?? 1, 0.6, 1.4);

  const horizonY = plot.y + plot.h * HORIZON_FRAC;
  const nearY = plot.y + plot.h - NEAR_MARGIN_PX;
  const vpX = plot.x + plot.w * 0.5;
  const floorSpanY = Math.max(40, nearY - horizonY);
  const maxLift = floorSpanY * MAX_LIFT_FRAC * intensity;

  const zAt = (d: number) => Z_NEAR + clamp(d, 0, 1) * (Z_FAR - Z_NEAR);
  const scaleAt = (d: number) => Z_NEAR / zAt(d); // 1 cerca â†’ pequeÃ±o lejos

  const project = (u: number, d: number, h: number): ProjPoint => {
    const s = scaleAt(d);
    const x = vpX + (u - 0.5) * plot.w * s;
    const groundY = horizonY + floorSpanY * s; // s=1 â†’ nearY ; sâ†’0 â†’ horizonY
    const y = groundY - h * maxLift * s;
    return { x, y, scale: s };
  };

  const floorPoint = (xWorld: number, zWorld: number): ProjPoint => {
    const s = Z_NEAR / zWorld;
    return { x: vpX + xWorld * s, y: horizonY + floorSpanY * s, scale: s };
  };

  return {
    horizonY,
    nearY,
    vpX,
    plotX: plot.x,
    plotW: plot.w,
    zNear: Z_NEAR,
    zFar: Z_FAR,
    floorSpanY,
    project,
    scaleAt,
    floorPoint,
  };
}

/**
 * Fondo negro del escenario 3D. Va ANTES del pozo de previsualización: la
 * ventana se apoya sobre este fondo y las líneas de la grilla se pintan después,
 * de modo que el pozo queda visualmente DEBAJO del piso.
 */
export function drawGrid3DBackdrop(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const { plot } = state.layout;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  ctx.fillStyle = '#09121a';
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h);
  ctx.restore();
}

/**
 * Dibuja la GRILLA-PISO en perspectiva (reemplaza `drawECGGrid` cuando 3D estÃ¡ activo).
 * Mantiene la semÃ¡ntica ECG (lÃ­neas mayores/menores) pero con profundidad real.
 * Se pinta DESPUÉS de `drawPreviewWell3D` para que el pozo quede debajo de la
 * grilla y las líneas del piso lo crucen por encima.
 */
export function drawGrid3DLines(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const proj = makeProjector(state);
  const { plot } = state.layout;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  // LÃ­nea de horizonte (tenue, marca el punto de fuga).
  ctx.strokeStyle = `rgba(${C.gridMinor}, 0.35)`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plot.x, proj.horizonY);
  ctx.lineTo(plot.x + plot.w, proj.horizonY);
  ctx.stroke();

  // === GRILLA CUADRADA en perspectiva (baldosas) â€” celdas GRANDES =============
  // Celda en unidades-mundo (= px en el borde cercano), MISMA medida en ancho (X)
  // y en profundidad (Z) â†’ celdas cuadradas que se escorzan hacia el horizonte.
  // Menos columnas = celdas mÃ¡s grandes. LÃ­neas mayores cada 5 (estilo papel ECG).
  const TARGET_COLS = 11;
  const cellPx = proj.plotW / TARGET_COLS;
  const halfCols = Math.ceil(TARGET_COLS / 2);
  const halfX = halfCols * cellPx;
  const dZ = cellPx / proj.floorSpanY; // paso de profundidad = ancho de celda â†’ cuadrada

  // Filas (Z constante): cuadradas cerca, agrupÃ¡ndose al horizonte. Se cortan cuando
  // dos filas quedan a < 2 px (evita el moirÃ© en la lejanÃ­a).
  let rowIdx = 0;
  let prevRowY = Number.POSITIVE_INFINITY;
  for (let z = proj.zNear; z <= proj.zFar + 1e-6; z += dZ, rowIdx++) {
    const a = proj.floorPoint(-halfX, z);
    if (prevRowY - a.y < 2) break;
    const b = proj.floorPoint(halfX, z);
    const isMajor = rowIdx % 5 === 0;
    const fade = 0.3 + 0.7 * a.scale;
    const alpha = (isMajor ? 0.32 : 0.12) * fade;
    ctx.strokeStyle = `rgba(${C.gridMinor}, ${alpha.toFixed(3)})`;
    ctx.lineWidth = isMajor ? 1.2 : 0.7;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    prevRowY = a.y;
  }

  // Columnas (X constante): separadas cellPx en mundo â†’ convergen al punto de fuga.
  for (let k = -halfCols; k <= halfCols; k++) {
    const xw = k * cellPx;
    const near = proj.floorPoint(xw, proj.zNear);
    const far = proj.floorPoint(xw, proj.zFar);
    const isMajor = k % 5 === 0;
    const g = ctx.createLinearGradient(near.x, near.y, far.x, far.y);
    g.addColorStop(0, `rgba(${C.gridMinor}, ${isMajor ? 0.32 : 0.12})`);
    g.addColorStop(1, `rgba(${C.gridMinor}, 0.05)`);
    ctx.strokeStyle = g;
    ctx.lineWidth = isMajor ? 1.1 : 0.65;
    ctx.beginPath();
    ctx.moveTo(near.x, near.y);
    ctx.lineTo(far.x, far.y);
    ctx.stroke();
  }

  // Borde frontal (baseline cero, resaltado).
  const fl = proj.floorPoint(-halfX, proj.zNear);
  const fr = proj.floorPoint(halfX, proj.zNear);
  ctx.strokeStyle = `rgba(${C.signal}, 0.55)`;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(fl.x, fl.y);
  ctx.lineTo(fr.x, fr.y);
  ctx.stroke();

  // Referencias numÃ©ricas de los ejes (amplitud + tiempo).
  drawGridReferences3D(ctx, proj, plot, state.amplitudeStats, state.windowMs ?? WINDOW_MS);

  ctx.restore();
}

/** Etiquetas numÃ©ricas de los ejes: amplitud (a.u.) a la izquierda y tiempo (-Ns) al frente. */
function drawGridReferences3D(
  ctx: CanvasRenderingContext2D,
  proj: Projector,
  plot: { x: number; y: number; w: number; h: number },
  stats: { min: number; max: number; range: number },
  windowMs: number,
): void {
  const range = stats.range > 1 ? stats.range : 1;

  // Escala de amplitud (unidades PPG) en el lado izquierdo, alturas h = 1..0.
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

  // Marcas de tiempo en el borde cercano (-0s â€¦ -Ns); lo reciente a la derecha.
  const seconds = Math.floor(windowMs / 1000);
  ctx.font = `bold 10px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  for (let sBack = 0; sBack <= seconds; sBack++) {
    const u = 1 - (sBack * 1000) / windowMs;
    const xWorld = (u - 0.5) * proj.plotW;
    const p = proj.floorPoint(xWorld, proj.zNear);
    ctx.textAlign = sBack === 0 ? 'right' : sBack === seconds ? 'left' : 'center';
    ctx.fillText(sBack === 0 ? '0 s' : `−${sBack} s`, p.x, proj.nearY + 13);
  }
}

/**
 * Dibuja la ONDA como cinta 3D extruida sobre el piso en perspectiva.
 * Consume las MISMAS `coords` honestas del render 2D â€” la forma, la amplitud y el
 * tiempo son idÃ©nticos; sÃ³lo cambia la proyecciÃ³n.
 */
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

  // Amplitud normalizada honesta [0..1] desde la coord 2D (idÃ©ntica a la del 2D).
  const hOf = (c: WaveCoord) => clamp((geom.waveBaseY - c.y) / geom.waveH, 0, 1);
  const uOf = (c: WaveCoord) => clamp((c.x - plot.x) / plot.w, 0, 1);

  const Pf: ProjPoint[] = []; // cresta frontal (la onda honesta)
  const Pb: ProjPoint[] = []; // cresta trasera (grosor de la cinta)
  const Pfloor: ProjPoint[] = []; // huella en el piso (sombra)
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

  // 1) Sombra/huella en el piso segmentada por arritmia (normal=verde, arr=rojo).
  if (revealed) {
    let s = 0;
    while (s < n - 1) {
      const isArr = coords[s].isArr;
      let e = s;
      while (e < n - 1 && coords[e].isArr === isArr) e++;
      const col = isArr ? C.arr : C.signal;
      ctx.beginPath();
      ctx.moveTo(Pfloor[s].x, Pfloor[s].y);
      for (let i = s; i < e; i++) ctx.lineTo(Pfloor[i].x, Pfloor[i].y);
      ctx.strokeStyle = `rgba(${col}, ${isArr ? 0.35 : 0.12})`;
      ctx.lineWidth = isArr ? 8 : 6;
      ctx.shadowColor = `rgba(${col}, ${isArr ? 0.30 : 0.05})`;
      ctx.shadowBlur = isArr ? 12 : 0;
      ctx.stroke();
      ctx.shadowBlur = 0;
      s = e;
    }
  }

  // 1b) Rayos rojos de arritmia desde el piso hacia la fuga (punto de fuga vpX, horizonY).
  if (revealed) {
    for (let i = 0; i < n; i++) {
      if (!coords[i].isArr) continue;
      const p = Pfloor[i];
      const dx = proj.vpX - p.x;
      const dy = proj.horizonY - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) continue;
      const nx = dx / dist, ny = dy / dist;
      const fade = Math.min(1, (p.y - proj.horizonY) / (proj.nearY - proj.horizonY));
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + nx * dist, p.y + ny * dist);
      ctx.strokeStyle = `rgba(${C.arr}, ${(0.08 + 0.12 * fade).toFixed(3)})`;
      ctx.lineWidth = 1.5 + 1.5 * fade;
      ctx.stroke();
    }
  }

  // 2) Cara superior de la cinta (entre cresta frontal y trasera) â†’ grosor 3D.
  if (revealed) {
    ctx.beginPath();
    ctx.moveTo(Pf[0].x, Pf[0].y);
    traceMeasuredPath(ctx, Pf);
    ctx.lineTo(Pb[n - 1].x, Pb[n - 1].y);
    traceMeasuredPath(ctx, Pb, 0, n - 1, true);
    ctx.closePath();
    ctx.fillStyle = `rgba(${C.signalBright}, 0.16)`;
    ctx.fill();
  }

  // 3) Cara frontal (pared vertical de la cresta al piso) con degradado.
  const wallGrad = ctx.createLinearGradient(0, proj.horizonY, 0, proj.nearY);
  wallGrad.addColorStop(0, `rgba(${C.signal}, ${revealed ? 0.18 : 0.08})`);
  wallGrad.addColorStop(1, `rgba(${C.signal}, 0.02)`);
  ctx.beginPath();
  ctx.moveTo(Pfloor[0].x, Pfloor[0].y);
  ctx.lineTo(Pf[0].x, Pf[0].y);
  traceMeasuredPath(ctx, Pf);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(Pfloor[i].x, Pfloor[i].y);
  ctx.closePath();
  ctx.fillStyle = wallGrad;
  ctx.fill();

  // 3b) Sobre-pintado rojo translÃºcido en segmentos de arritmia.
  let s = 0;
  while (s < n) {
    if (!coords[s].isArr) { s++; continue; }
    let e = s;
    while (e < n && coords[e].isArr) e++;
    ctx.beginPath();
    ctx.moveTo(Pfloor[s].x, Pfloor[s].y);
    ctx.lineTo(Pf[s].x, Pf[s].y);
    traceMeasuredPath(ctx, Pf, s, e - 1);
    for (let i = e - 1; i >= s; i--) ctx.lineTo(Pfloor[i].x, Pfloor[i].y);
    ctx.closePath();
    ctx.fillStyle = `rgba(${C.arr}, 0.50)`;
    ctx.fill();
    s = e;
  }

  // 4) Cresta trasera (tenue, da volumen).
  if (revealed) {
    ctx.beginPath();
    ctx.moveTo(Pb[0].x, Pb[0].y);
    traceMeasuredPath(ctx, Pb);
    ctx.strokeStyle = `rgba(${C.signal}, 0.28)`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 5) Cresta frontal: la onda honesta. Segmentada por arritmia, con glow.
  const drawCrestSeg = (from: number, to: number, arr: boolean) => {
    ctx.beginPath();
    ctx.moveTo(Pf[from].x, Pf[from].y);
    traceMeasuredPath(ctx, Pf, from, to);
    if (revealed) {
      ctx.strokeStyle = arr ? `rgba(${C.arr}, 0.9)` : `rgb(${C.signalBright})`;
      ctx.shadowColor = arr ? `rgba(${C.arr}, 0.55)` : `rgba(${C.signal}, 0.55)`;
      ctx.shadowBlur = 4;
      ctx.lineWidth = 2.2;
    } else {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1.6;
    }
    ctx.stroke();
  };
  s = 0;
  while (s < n - 1) {
    const arr = coords[s].isArr;
    let e = s;
    while (e < n - 1 && coords[e].isArr === arr) e++;
    drawCrestSeg(s, e, arr);
    s = e;
  }
  ctx.shadowBlur = 0;

  // 6) Marcadores fiduciales con VALORES en tiempo real: picos mÃ¡ximos (SYS),
  //    valles mÃ­nimos (DIA), muesca dÃ­crota (DIC) y etiquetas de arritmia (ARR).
  if (revealed && state.showAnnotations !== false) {
    const quality = state.props.quality ?? 0;
    ctx.textAlign = 'center';
    for (let i = 2; i < n - 2; i++) {
      const v = coords[i].val;
      const isArr = coords[i].isArr;
      const prev = coords[i - 1].val;
      const next = coords[i + 1].val;
      const prev2 = coords[i - 2].val;
      const next2 = coords[i + 2].val;
      const p = Pf[i];

      // Pico sistÃ³lico (mÃ¡ximo local) â†’ punto + valor + etiqueta SYS/ARR.
      if (v > prev && v > next && v > prev2 && v > next2 && v > geom.midValue) {
        const r = 2.6 + p.scale * 1.6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = isArr ? `rgb(${C.arr})` : '#ffffff';
        ctx.shadowColor = isArr ? `rgb(${C.arr})` : `rgb(${C.cyan})`;
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.font = `bold 9px ${FONT}`;
        ctx.fillStyle = isArr ? `rgb(${C.arr})` : `rgb(${C.cyan})`;
        ctx.fillText(v.toFixed(1), p.x, p.y - 11);
        ctx.font = `7px ${FONT}`;
        ctx.fillStyle = isArr ? '#fecaca' : 'rgba(255, 255, 255, 0.75)';
        ctx.fillText(isArr ? 'ARR' : 'SYS', p.x, p.y - 21);
        if (isArr) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${C.arr}, 0.65)`;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }
      }

      // Valle diastÃ³lico (mÃ­nimo local) â†’ anillo + valor + etiqueta DIA.
      if (v < prev && v < next && v < prev2 && v < next2 && v < geom.midValue) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.font = `bold 9px ${FONT}`;
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(v.toFixed(1), p.x, p.y + 15);
        ctx.font = `7px ${FONT}`;
        ctx.fillText('DIA', p.x, p.y + 24);
      }

      // Muesca dÃ­crota (DIC) â†’ punto + etiqueta si la calidad es alta.
      const d1Curr = v - prev;
      const d1Next = next - v;
      if (d1Curr < 0 && d1Next > d1Curr && d1Next < 0 && v > geom.midValue) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(103, 232, 249, 0.6)';
        ctx.fill();
        if (quality > 70) {
          ctx.font = `7px ${FONT}`;
          ctx.fillStyle = 'rgba(103, 232, 249, 0.85)';
          ctx.fillText('DIC', p.x, p.y - 7);
        }
      }
    }
  }

  // 7) Halo pulsÃ¡til en la punta conductora (cresta mÃ¡s reciente).
  const head = Pf[n - 1];
  const headArr = coords[n - 1].isArr;
  const pulse = state.reducedMotion ? 0.04 : Math.max(state.sweepPulse, 0.04);
  ctx.beginPath();
  ctx.arc(head.x, head.y, (6 + pulse * 8) * (0.7 + 0.3 * head.scale), 0, Math.PI * 2);
  ctx.fillStyle = revealed
    ? headArr ? `rgba(${C.arr}, 0.3)` : `rgba(${C.cyan}, 0.3)`
    : 'rgba(148, 163, 184, 0.18)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(head.x, head.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  ctx.restore();
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// === VENTANA DE PREVISUALIZACIÓN ACOSTADA SOBRE LA GRILLA 3D =================
// La previsualización del dedo es una SUPERFICIE PLANA apoyada en el piso: se
// proyecta como trapecio (keystone) sobre la misma grilla y el video se
// muestrea fila a fila con correspondencia proyectiva exacta
// (z = Z_NEAR · floorSpanY / (y - horizonY)). El borde LEJANO queda anclado a
// la grilla y el CERCANO avanza hacia el observador al mejorar la colocación:
// la ventana se abre acostada, nunca de pie. La cinta de la onda se dibuja
// después y fluye por delante, como en el resto del escenario 3D.
//
// Nada de esto altera la medición: sólo cambia la proyección de presentación.

const PREVIEW_D_FAR = 0.95;          // borde lejano (anclado, junto al horizonte)
const PREVIEW_D_NEAR_OPEN = 0.19;    // borde cercano con colocación óptima
const PREVIEW_D_NEAR_CLOSED = 0.56;  // borde cercano sin contacto (plegada)
const PREVIEW_HALF_W_OPEN = 0.72;    // semiancho vs plot.w con colocación óptima
const PREVIEW_HALF_W_CLOSED = 0.12;  // semiancho vs plot.w sin contacto
const PREVIEW_EASE_UP = 0.055;       // apertura suave (~1 s a 60 fps)
const PREVIEW_EASE_DOWN = 0.20;      // cierre rápido y honesto

/** Tamaño animado persistente [0..1] (el render corre en rAF). */
let previewOpenEma = 0;

interface WellTheme { edge: string; core: string; glow: string; tint: string; }
function wellThemeFor(contactState?: string, pressure?: string, pressureScore?: number): WellTheme {
  // El color/etiqueta de la ventana siguen el veredicto de presión cuando existe,
  // para no mostrar verde "CONTACTO ÓPTIMO" mientras hay colapso capilar. El
  // TEXTO lo genera `deriveWellGuide` (una sola fuente de etiquetas).
  const score = typeof pressureScore === 'number' && Number.isFinite(pressureScore)
    ? Math.max(0, Math.min(1, pressureScore))
    : 0.5;
  if (pressure === 'HEAVY') {
    return {
      edge: 'rgba(239,68,68,0.95)', core: 'rgba(252,165,165,0.9)',
      glow: `rgba(239,68,68,${(0.28 + 0.22 * score).toFixed(3)})`, tint: '239,68,68',
    };
  }
  if (pressure === 'LIGHT') {
    return {
      edge: 'rgba(245,158,11,0.95)', core: 'rgba(253,230,138,0.9)',
      glow: 'rgba(245,158,11,0.35)', tint: '245,158,11',
    };
  }
  if (pressure === 'IDEAL') {
    return {
      edge: 'rgba(34,197,94,0.95)', core: 'rgba(134,239,172,0.9)',
      glow: 'rgba(34,197,94,0.40)', tint: '34,197,94',
    };
  }
  switch (contactState) {
    case 'STABLE_CONTACT':
      return {
        edge: 'rgba(34,197,94,0.95)', core: 'rgba(134,239,172,0.9)',
        glow: 'rgba(34,197,94,0.40)', tint: '34,197,94',
      };
    case 'UNSTABLE_CONTACT':
      return {
        edge: 'rgba(245,158,11,0.95)', core: 'rgba(253,230,138,0.9)',
        glow: 'rgba(245,158,11,0.35)', tint: '245,158,11',
      };
    default:
      return {
        edge: 'rgba(148,163,184,0.55)', core: 'rgba(226,232,240,0.8)',
        glow: 'rgba(148,163,184,0.15)', tint: '148,163,184',
      };
  }
}

/**
 * Score de colocación [0..1] SOLO con señales ya presentes en el render state
 * (cero cómputo nuevo del pipeline). El tamaño de la ventana es su feedback.
 */
function wellScoreOf(state: PpgRenderState, _contactState?: string): number {
  // EVIDENCIA FÍSICA REAL: score directo del módulo fingerPlacementEvidence
  // (presión/ubicación/movimiento/pulso medidos por frame en el pipeline).
  // Sin evidencia (pipeline parado, sin monitoreo, señal stale) -> 0:
  // la ventana NUNCA queda abierta con datos viejos.
  const evidence = state.props.diagnostics?.placementEvidence;
  if (!evidence) return 0;
  // Un score no finito (pipeline reiniciándose) no debe envenenar la animación.
  if (!Number.isFinite(evidence.score)) return 0;
  return clamp(evidence.score, 0, 1);
}

/** Cuatro esquinas de la ventana proyectadas sobre el piso en perspectiva. */
export interface FloorPreviewQuad {
  nearLeft: ProjPoint;
  nearRight: ProjPoint;
  farLeft: ProjPoint;
  farRight: ProjPoint;
  /** Semiancho en unidades-mundo (px en el borde cercano de la grilla). */
  halfW: number;
  /** Profundidades mundo del borde cercano y lejano. */
  zn: number;
  zf: number;
}

/** Geometría de la ventana acostada + muestreo proyectivo del video. */
export interface FloorPreviewGeometry {
  proj: Projector;
  quad: FloorPreviewQuad;
  farY: number;
  nearY: number;
  /** v [0..1] del recorte del video para una fila de pantalla (0=arriba/lejos). */
  sourceVAt: (screenY: number) => number;
}

/**
 * Proyecta la ventana acostada para un grado de apertura `size` [0..1].
 *
 * Invariantes (verificados en tests):
 *  - El borde LEJANO no se mueve: la ventana queda anclada a la misma fila de
 *    la grilla y sólo crece hacia el observador.
 *  - Las esquinas forman un trapecio con el borde cercano más ancho que el
 *    lejano (keystone real de un plano horizontal).
 *  - `sourceVAt` es monótona: fila superior del video ? borde lejano, fila
 *    inferior ? borde cercano.
 */
export function computeFloorPreviewGeometry(
  state: PpgRenderState,
  size: number,
): FloorPreviewGeometry {
  const proj = makeProjector(state);
  const { plot } = state.layout;
  const open = clamp(size, 0, 1);
  const dNear = PREVIEW_D_NEAR_CLOSED + (PREVIEW_D_NEAR_OPEN - PREVIEW_D_NEAR_CLOSED) * open;
  const zRange = proj.zFar - proj.zNear;
  const zn = proj.zNear + dNear * zRange;
  const zf = proj.zNear + PREVIEW_D_FAR * zRange;
  const halfFrac = PREVIEW_HALF_W_CLOSED + (PREVIEW_HALF_W_OPEN - PREVIEW_HALF_W_CLOSED) * open;
  const halfW = plot.w * halfFrac;
  const quad: FloorPreviewQuad = {
    nearLeft: proj.floorPoint(-halfW, zn),
    nearRight: proj.floorPoint(halfW, zn),
    farLeft: proj.floorPoint(-halfW, zf),
    farRight: proj.floorPoint(halfW, zf),
    halfW,
    zn,
    zf,
  };
  const farY = quad.farLeft.y;
  const nearY = quad.nearLeft.y;
  const depthSpan = Math.max(1e-6, zf - zn);
  const sourceVAt = (screenY: number): number => {
    const dy = Math.max(0.5, screenY - proj.horizonY);
    const z = (proj.zNear * proj.floorSpanY) / dy;
    return 1 - clamp((z - zn) / depthSpan, 0, 1);
  };
  return { proj, quad, farY, nearY, sourceVAt };
}

/** Path del trapecio de la ventana (orden: cercano izquierdo ? lejano izquierdo). */
function quadPath(ctx: CanvasRenderingContext2D, quad: FloorPreviewQuad): void {
  ctx.beginPath();
  ctx.moveTo(quad.nearLeft.x, quad.nearLeft.y);
  ctx.lineTo(quad.nearRight.x, quad.nearRight.y);
  ctx.lineTo(quad.farRight.x, quad.farRight.y);
  ctx.lineTo(quad.farLeft.x, quad.farLeft.y);
  ctx.closePath();
}

/**
 * Mapeo proyectivo del video sobre el plano del piso.
 *
 * Para cada fila de pantalla se recupera su profundidad exacta
 * (z = Z_NEAR · floorSpanY / (y - horizonY)), de ahí la fila del recorte
 * central del video y el ancho del trapecio en esa profundidad. Las franjas se
 * dibujan de a pocas filas (máx. ~48 por frame) y el clip al trapecio recorta
 * el sobrante ? bordes laterales exactos sin escalones, coste acotado en móvil.
 */
/**
 * Presupuesto ADAPTATIVO de franjas del vídeo.
 *
 * El render compite con la captura: si el bucle de dibujo se come el frame, el
 * `<video>` entrega menos muestras al worker y el detector de latidos se queda
 * sin señal. Antes se pagó ese precio con `ctx.filter` por franja. Ahora el
 * número de franjas se ajusta solo con el coste medido del propio bucle, con un
 * máximo de 48 y un mínimo de 16 (donde el borde ya no se nota escalonado).
 */
const STRIP_BUDGET_MAX = 48;
const STRIP_BUDGET_MIN = 16;
const STRIP_TARGET_MS = 2.5;
let stripBudget = STRIP_BUDGET_MAX;
let stripCostEma = STRIP_TARGET_MS;

function drawFloorWarpedVideo(
  ctx: CanvasRenderingContext2D,
  source: HTMLVideoElement,
  geo: FloorPreviewGeometry,
): void {
  const { quad, proj, farY, nearY, sourceVAt } = geo;
  const cropSide = Math.min(source.videoWidth, source.videoHeight) * WELL_CROP_FRAC;
  if (cropSide <= 0) return;
  const sx = (source.videoWidth - cropSide) / 2;
  const sy = (source.videoHeight - cropSide) / 2;
  const screenH = Math.max(1, nearY - farY);
  // NO se usa `ctx.filter`: aplicarlo a cada franja de un canvas escalado por
  // devicePixelRatio fuerza a Chrome a salir de la ruta GPU y hunde el frame.
  const step = Math.max(1.5, screenH / stripBudget);

  ctx.save();
  quadPath(ctx, quad);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';

  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  for (let y = farY; y < nearY; y += step) {
    const y1 = Math.min(nearY, y + step);
    // La fila más ancha del par define el rectángulo; el clip al trapecio
    // recorta el sobrante superior y mantiene el borde lateral exacto.
    const scale = (y1 - proj.horizonY) / proj.floorSpanY;
    const left = proj.vpX - quad.halfW * scale;
    const width = quad.halfW * 2 * scale;
    const v0 = sourceVAt(y);
    const v1 = sourceVAt(y1);
    const srcY = sy + v0 * cropSide;
    const srcH = Math.max(0.01, (v1 - v0) * cropSide);
    ctx.drawImage(
      source,
      sx, srcY, cropSide, srcH,
      left, y, width, (y1 - y) + 0.5,
    );
  }
  ctx.restore();

  if (t0) {
    const cost = performance.now() - t0;
    stripCostEma = stripCostEma * 0.88 + cost * 0.12;
    if (stripCostEma > STRIP_TARGET_MS) {
      stripBudget = Math.max(STRIP_BUDGET_MIN, stripBudget - 2);
    } else if (stripCostEma < STRIP_TARGET_MS * 0.6) {
      stripBudget = Math.min(STRIP_BUDGET_MAX, stripBudget + 1);
    }
  }
}

/**
 * Dibuja la VENTANA DE PREVISUALIZACIÓN ACOSTADA sobre la grilla 3D.
 * Debe llamarse DESPUÉS de `drawGrid3DBackdrop` y ANTES de `drawGrid3DLines` y
 * de la onda (`drawSignal`): el pozo queda debajo de la grilla, las líneas del
 * piso lo cruzan por encima y las ondas cardíacas fluyen por delante.
 *
 * @param source  element de video de la cámara trasera (o null ? ventana vacía).
 */
export function drawPreviewWell3D(
  ctx: CanvasRenderingContext2D,
  state: PpgRenderState,
  source: HTMLVideoElement | null,
  contactState?: string,
): void {
  const pressureEvidence = state.props.diagnostics?.placementEvidence;
  const hasVideo = !!source && source.readyState >= 2 && source.videoWidth > 0;

  // Guía de colocación: se deriva UNA vez por frame y la usan el tamaño, el
  // color, el texto y la huella. Así la ventana no puede decir una cosa y
  // dibujar otra.
  const view = deriveWellGuide({
    evidence: pressureEvidence,
    acquisitionStage: state.props.diagnostics?.acquisitionStage,
    hasVideo,
    nowMs: state.now,
    beatPulse: state.sweepPulse,
    reducedMotion: prefersReducedMotion(),
  });

  // El veredicto de color manda sobre la presión cuando el registro ya está
  // conseguido: "SEÑAL ESTABLE" no puede ir en ámbar.
  const theme = view.phase === 'LOCKED'
    ? wellThemeFor('STABLE_CONTACT', 'IDEAL', 1)
    : wellThemeFor(contactState, pressureEvidence?.pressure, pressureEvidence?.pressureScore);

  // Apertura animada: sube suave, baja rápido (feedback honesto). Mientras hay
  // imagen la ventana no se pliega por debajo del suelo de guía: sin diana
  // visible no hay colocación posible.
  const rawTarget = wellScoreOf(state, contactState);
  const floor = hasVideo ? VITAL_THRESHOLDS.PLACEMENT.OVERLAY.GUIDE_FLOOR : 0;
  const target = Math.max(rawTarget, floor);
  const ease = target > previewOpenEma ? PREVIEW_EASE_UP : PREVIEW_EASE_DOWN;
  previewOpenEma += (target - previewOpenEma) * ease;
  const size = clamp(previewOpenEma, 0, 1);

  const geo = computeFloorPreviewGeometry(state, size);
  const { proj, quad } = geo;
  const { plot } = state.layout;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  // 1) CRISTAL: base apenas oscurece el piso. La grilla se pinta DESPUÉS del
  //    pozo, así que no hace falta taparla; una base opaca convertiría la
  //    ventana en un parche y rompería la lectura de "recostada bajo la grilla".
  const body = ctx.createLinearGradient(0, geo.farY, 0, geo.nearY);
  body.addColorStop(0, 'rgba(4, 9, 16, 0.06)');
  body.addColorStop(1, 'rgba(2, 5, 9, 0.10)');
  quadPath(ctx, quad);
  ctx.fillStyle = body;
  ctx.fill();

  // 2) VIDEO real recortado al centro y proyectado sobre el piso. Se pinta
  //    translúcido para que el piso y las líneas se lean a través del cristal.
  if (hasVideo) {
    ctx.save();
    ctx.globalAlpha = WELL_VEIL.VIDEO_ALPHA;
    drawFloorWarpedVideo(ctx, source as HTMLVideoElement, geo);
    ctx.restore();
  } else {
    // Sensor aún sin imagen: vetas de espera que respetan la perspectiva.
    ctx.save();
    quadPath(ctx, quad);
    ctx.clip();
    ctx.strokeStyle = 'rgba(148,163,184,0.14)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const y = geo.farY + (geo.nearY - geo.farY) * (i / 4);
      const s = (y - proj.horizonY) / proj.floorSpanY;
      ctx.beginPath();
      ctx.moveTo(proj.vpX - quad.halfW * s, y);
      ctx.lineTo(proj.vpX + quad.halfW * s, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 3) TINTE del veredicto: lo justo para leer el estado. El contrato de
  //    transparencia está en `wellVeilAt` (testeado); aquí sólo se aplica.
  quadPath(ctx, quad);
  ctx.fillStyle = `rgba(${theme.tint}, ${wellTintAlpha(size).toFixed(3)})`;
  ctx.fill();

  // 4) SOMBRA de distancia: la pantalla se funde hacia el horizonte.
  const depthShade = ctx.createLinearGradient(0, geo.farY, 0, geo.nearY);
  depthShade.addColorStop(0, `rgba(0,0,0,${WELL_VEIL.DEPTH_FAR})`);
  depthShade.addColorStop(0.6, `rgba(0,0,0,${WELL_VEIL.DEPTH_MID})`);
  depthShade.addColorStop(1, `rgba(0,0,0,${WELL_VEIL.DEPTH_NEAR})`);
  quadPath(ctx, quad);
  ctx.fillStyle = depthShade;
  ctx.fill();

  // 5) CRISTAL: reflejo del horizonte + brillo del canto superior.
  const glass = ctx.createLinearGradient(0, geo.farY, 0, geo.nearY);
  glass.addColorStop(0, `rgba(255,255,255,${WELL_VEIL.GLASS_FAR})`);
  glass.addColorStop(0.3, 'rgba(255,255,255,0.012)');
  glass.addColorStop(1, 'rgba(255,255,255,0)');
  quadPath(ctx, quad);
  ctx.fillStyle = glass;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(quad.farLeft.x, quad.farLeft.y + 0.6);
  ctx.lineTo(quad.farRight.x, quad.farRight.y + 0.6);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.stroke();

  // 6) Barrido del sensor (sutil: no compite con la guía).
  ctx.save();
  quadPath(ctx, quad);
  ctx.clip();
  const phase = state.reducedMotion ? 0.5 : (state.now / 2600) % 1;
  const scanY = geo.farY + (geo.nearY - geo.farY) * phase;
  const scanH = Math.max(4, (geo.nearY - geo.farY) * 0.06);
  const scan = ctx.createLinearGradient(0, scanY, 0, scanY + scanH);
  scan.addColorStop(0, `rgba(${theme.tint}, 0)`);
  scan.addColorStop(0.5, `rgba(${theme.tint}, 0.05)`);
  scan.addColorStop(1, `rgba(${theme.tint}, 0)`);
  ctx.fillStyle = scan;
  ctx.fillRect(plot.x, scanY, plot.w, scanH);
  ctx.restore();

  // 7) GUÍA DE COLOCACIÓN: diana + fantasma + haz + zócalo de texto, TODO
  //    dentro del cristal. Aquí es donde la app le dice al usuario qué hacer.
  //    Sin evidencia (monitor parado) no se dibuja: no hay nada que alinear.
  if (view.phase !== 'INACTIVE') {
    drawWellFingerprintGuide(
      ctx,
      geo,
      view,
      {
        tint: theme.tint,
        accent: view.phase === 'PRESSURE' ? '251, 146, 60' : '125, 211, 252',
      },
      FONT,
    );
  }

  // 8) CANTO frontal: grosor físico de la pantalla apoyada en el piso.
  const lip = clamp(2 + 2.5 * size, 2, 5);
  ctx.beginPath();
  ctx.moveTo(quad.nearLeft.x, quad.nearLeft.y);
  ctx.lineTo(quad.nearRight.x, quad.nearRight.y);
  ctx.lineTo(quad.nearRight.x, quad.nearRight.y + lip);
  ctx.lineTo(quad.nearLeft.x, quad.nearLeft.y + lip);
  ctx.closePath();
  ctx.fillStyle = `rgba(${theme.tint}, 0.12)`;
  ctx.fill();

  // 9) BISEL con brillo: el mismo borde que tenía el visor, ahora acostado.
  const bez = ctx.createLinearGradient(0, geo.farY, 0, geo.nearY);
  bez.addColorStop(0, theme.core);
  bez.addColorStop(1, theme.edge);
  quadPath(ctx, quad);
  ctx.strokeStyle = bez;
  ctx.lineWidth = 1.2 + 0.7 * size;
  ctx.shadowColor = theme.glow;
  ctx.shadowBlur = 2 + 3 * size
    + (view.phase === 'LOCKED' ? 3 * Math.max(state.sweepPulse, 0) : 0);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 10) BRACKETES de visor en las 4 esquinas, alineados a los lados convergentes.
  const bracket = (c: ProjPoint, a: ProjPoint, b: ProjPoint): void => {
    const lenA = Math.hypot(a.x - c.x, a.y - c.y);
    const lenB = Math.hypot(b.x - c.x, b.y - c.y);
    if (lenA < 1 || lenB < 1) return;
    const len = Math.min(16, Math.max(7, Math.min(lenA, lenB) * 0.22));
    const ax = (a.x - c.x) / lenA;
    const ay = (a.y - c.y) / lenA;
    const bx = (b.x - c.x) / lenB;
    const by = (b.y - c.y) / lenB;
    ctx.moveTo(c.x + ax * len, c.y + ay * len);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(c.x + bx * len, c.y + by * len);
  };
  ctx.beginPath();
  bracket(quad.nearLeft, quad.nearRight, quad.farLeft);
  bracket(quad.nearRight, quad.farRight, quad.nearLeft);
  bracket(quad.farLeft, quad.farRight, quad.nearLeft);
  bracket(quad.farRight, quad.farLeft, quad.nearRight);
  ctx.strokeStyle = theme.core;
  ctx.lineWidth = 2 + size * 0.8;
  ctx.lineCap = 'round';
  ctx.stroke();

  // 11) PULSO al latir: anillo proyectado sobre el plano de la pantalla.
  if (view.phase === 'LOCKED' && size > 0.35) {
    const pulse = state.reducedMotion ? 0.04 : Math.max(state.sweepPulse, 0.04);
    const cz = (quad.zn + quad.zf) / 2;
    const rPx = quad.halfW * (0.5 + 0.42 * pulse);
    const rZ = rPx / proj.floorSpanY;
    ctx.save();
    quadPath(ctx, quad);
    ctx.clip();
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const t = (i / 48) * Math.PI * 2;
      const pt = proj.floorPoint(rPx * Math.cos(t), cz + rZ * Math.sin(t));
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.strokeStyle = `rgba(${theme.tint}, ${(0.30 * (1 - pulse)).toFixed(3)})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}


