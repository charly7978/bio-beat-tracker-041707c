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
import { deriveWellGuide } from './fingerPlacementOverlay';

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

// Geometría compartida del plano: la guía proyectiva sigue utilizando este
// contrato. El visor operativo se presenta frontal para leer captura y ROI
// sin la compresión vertical de la perspectiva del piso.

const PREVIEW_D_FAR = 0.95;          // borde lejano (anclado, junto al horizonte)
const PREVIEW_D_NEAR_OPEN = 0.19;    // borde cercano con colocación óptima
const PREVIEW_D_NEAR_CLOSED = 0.56;  // borde cercano sin contacto (plegada)
const PREVIEW_HALF_W_OPEN = 0.72;    // semiancho vs plot.w con colocación óptima
const PREVIEW_HALF_W_CLOSED = 0.12;  // semiancho vs plot.w sin contacto
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

export interface CapturePreviewRect { x: number; y: number; w: number; h: number; }
export interface CapturePreviewLayout {
  card: CapturePreviewRect;
  video: CapturePreviewRect;
  text: CapturePreviewRect;
  compact: boolean;
}

/** Una superficie frontal estable: una mala captura nunca encoge la ayuda. */
export function computeCapturePreviewLayout(state: PpgRenderState): CapturePreviewLayout {
  const { plot, width } = state.layout;
  const compact = width < 760 || plot.h < 260;
  const w = Math.min(compact ? 190 : 260, Math.max(0, plot.w - 16));
  const h = Math.min(compact ? 136 : 170, Math.max(0, plot.h - 16));
  const x = plot.x + plot.w - w - 8;
  const y = compact ? plot.y + plot.h - h - 8 : plot.y + 12;
  const videoW = compact ? 66 : 100;
  const videoH = compact ? 50 : 75;
  return {
    card: { x, y, w, h },
    video: { x: x + 10, y: y + 30, w: videoW, h: videoH },
    text: { x: x + videoW + 19, y: y + 30, w: w - videoW - 29, h: videoH },
    compact,
  };
}

/** Mapea el ROI observado sobre el vídeo completo; no se inventa una diana. */
export function mapCapturePreviewRoi(
  roi: { x: number; y: number; width: number; height: number } | undefined,
  frame: { width: number; height: number } | undefined,
  video: CapturePreviewRect,
): CapturePreviewRect | null {
  if (!roi || !frame || ![roi.x, roi.y, roi.width, roi.height, frame.width, frame.height].every(Number.isFinite)
    || frame.width <= 0 || frame.height <= 0 || roi.width <= 0 || roi.height <= 0) return null;
  const left = clamp(roi.x / frame.width, 0, 1);
  const top = clamp(roi.y / frame.height, 0, 1);
  const right = clamp((roi.x + roi.width) / frame.width, 0, 1);
  const bottom = clamp((roi.y + roi.height) / frame.height, 0, 1);
  if (right <= left || bottom <= top) return null;
  return { x: video.x + left * video.w, y: video.y + top * video.h,
    w: (right - left) * video.w, h: (bottom - top) * video.h };
}

function captureText(
  ctx: CanvasRenderingContext2D, value: string, x: number, y: number,
  width: number, lineHeight: number, maxLines: number,
): number {
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > width) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  for (let i = 0; i < Math.min(maxLines, lines.length); i++) {
    let rendered = lines[i];
    if (i === maxLines - 1 && lines.length > maxLines) {
      while (rendered.length && ctx.measureText(`${rendered}…`).width > width) rendered = rendered.slice(0, -1);
      rendered += '…';
    }
    ctx.fillText(rendered, x, y + i * lineHeight, width);
  }
  return Math.min(maxLines, lines.length) * lineHeight;
}

/**
 * Previsualizador operativo dentro del monitor, común a 2D y 3D.
 * Se pinta después de la onda: ninguna grilla cruza las instrucciones.
 * Su iluminación responde a evidencia actual; el vídeo se dibuja una sola vez.
 */
export function drawPreviewWell3D(
  ctx: CanvasRenderingContext2D,
  state: PpgRenderState,
  source: HTMLVideoElement | null,
  _contactState?: string,
): void {
  const { card, video, text, compact } = computeCapturePreviewLayout(state);
  if (card.w < 160 || card.h < 120) return;
  const p = state.props;
  const hasVideo = p.isMonitoring && !!source && source.readyState >= 2
    && source.videoWidth > 0 && source.videoHeight > 0;
  const evidence = p.isMonitoring && hasVideo ? p.diagnostics?.placementEvidence : undefined;
  const view = deriveWellGuide({ evidence, acquisitionStage: p.diagnostics?.acquisitionStage,
    hasVideo, nowMs: state.now, beatPulse: state.sweepPulse, reducedMotion: true });
  const guidance = evidence?.guidance;
  const critical = guidance?.action === 'RELEASE' || guidance?.action === 'FIX_SATURATION';
  const ready = view.phase === 'LOCKED';
  const accent = critical ? '#ff9d98' : ready ? '#83e6c9' : evidence ? '#f1d299' : '#9cb8cd';
  const title = !p.isMonitoring ? 'Prepara tu captura' : !hasVideo ? 'Esperando cámara'
    : !evidence ? 'Cubre cámara + flash' : view.instruction;
  const detail = !p.isMonitoring ? 'Inicia y cubre cámara + flash.'
    : !hasVideo ? 'Revisa el permiso de cámara.' : !evidence ? 'Apoya la yema sin apretar.' : view.detail;

  ctx.save();
  ctx.beginPath(); ctx.rect(state.layout.plot.x, state.layout.plot.y, state.layout.plot.w, state.layout.plot.h); ctx.clip();
  const body = ctx.createLinearGradient(card.x, card.y, card.x + card.w, card.y + card.h);
  body.addColorStop(0, 'rgba(20, 38, 52, .97)'); body.addColorStop(1, 'rgba(7, 17, 28, .97)');
  ctx.beginPath(); ctx.roundRect(card.x, card.y, card.w, card.h, 12);
  ctx.fillStyle = body;
  ctx.shadowColor = 'rgba(0, 0, 0, .45)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 5; ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.strokeStyle = 'rgba(144, 188, 215, .34)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(card.x + 14, card.y + .5); ctx.lineTo(card.x + card.w - 14, card.y + .5);
  ctx.strokeStyle = ready ? 'rgba(131,230,201,.7)' : 'rgba(169,205,226,.4)'; ctx.stroke();

  ctx.font = `500 11px ${FONT}`; ctx.textAlign = 'left'; ctx.fillStyle = '#c4d9e7';
  ctx.fillText('GUÍA DE CAPTURA', card.x + 11, card.y + 18);
  const fps = p.isMonitoring ? p.diagnostics?.sqm?.fpsEffective : undefined;
  ctx.font = `11px ${FONT}`; ctx.textAlign = 'right'; ctx.fillStyle = '#93aec1';
  ctx.fillText(Number.isFinite(fps) ? `${Math.round(fps!)} fps` : '— fps', card.x + card.w - 11, card.y + 18);
  ctx.textAlign = 'left';

  ctx.save(); ctx.beginPath(); ctx.roundRect(video.x, video.y, video.w, video.h, 6); ctx.clip();
  ctx.fillStyle = '#040c14'; ctx.fillRect(video.x, video.y, video.w, video.h);
  let imageRect = video;
  if (hasVideo && source) {
    const scale = Math.min(video.w / source.videoWidth, video.h / source.videoHeight);
    const w = source.videoWidth * scale; const h = source.videoHeight * scale;
    imageRect = { x: video.x + (video.w - w) / 2, y: video.y + (video.h - h) / 2, w, h };
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(source, imageRect.x, imageRect.y, w, h);
    const roi = mapCapturePreviewRoi(p.diagnostics?.roi, p.diagnostics?.frameSize, imageRect);
    if (roi) {
      ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
      ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);
      ctx.fillStyle = '#05121de6'; ctx.fillRect(video.x + 2, video.y + video.h - 16, 29, 15);
      ctx.fillStyle = '#d6f5ee'; ctx.font = `11px ${FONT}`;
      ctx.fillText('ROI', video.x + 5, video.y + video.h - 5);
    }
  } else {
    // Un sensor sin imagen muestra ausencia explícita, sin vídeo ni pulso retenidos.
    ctx.strokeStyle = '#345065'; ctx.lineWidth = 1;
    ctx.strokeRect(video.x + video.w * .28, video.y + video.h * .25, video.w * .44, video.h * .40);
    ctx.beginPath(); ctx.arc(video.x + video.w / 2, video.y + video.h * .45, 5, 0, Math.PI * 2); ctx.stroke();
    ctx.font = `11px ${FONT}`; ctx.fillStyle = '#9cb4c5'; ctx.textAlign = 'center';
    ctx.fillText('Sin imagen', video.x + video.w / 2, video.y + video.h - 5, video.w - 4); ctx.textAlign = 'left';
  }
  ctx.restore();
  ctx.fillStyle = accent; ctx.font = `600 ${compact ? 12 : 13}px system-ui, sans-serif`;
  const titleH = captureText(ctx, title, text.x, text.y + 11, text.w, compact ? 14 : 16, 2);
  ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = '#b0c6d5';
  captureText(ctx, detail, text.x, text.y + titleH + 14, text.w, 13, compact ? 2 : 3);

  const sqm = p.isMonitoring && hasVideo ? p.diagnostics?.sqm : undefined;
  const light = typeof sqm?.saturationRatio === 'number' && typeof sqm?.underexposureRatio === 'number'
    ? clamp(1 - sqm.saturationRatio - sqm.underexposureRatio, 0, 1) : undefined;
  const meters = [
    { label: 'Cubre', value: evidence?.seal },
    { label: 'Quietud', value: evidence?.motion },
    { label: 'Pulso', value: evidence?.pulsatility },
    { label: 'Luz útil', value: light },
  ];
  const cellW = (card.w - 20) / meters.length;
  const meterY = card.y + card.h - 36;
  ctx.beginPath(); ctx.moveTo(card.x + 10, meterY - 9); ctx.lineTo(card.x + card.w - 10, meterY - 9);
  ctx.strokeStyle = 'rgba(142,181,206,.18)'; ctx.stroke();
  meters.forEach((meter, i) => {
    const x = card.x + 10 + i * cellW;
    const measured = typeof meter.value === 'number' && Number.isFinite(meter.value);
    const level = measured ? clamp(meter.value!, 0, 1) : 0;
    ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = '#99b3c6'; ctx.fillText(meter.label, x, meterY, cellW - 3);
    ctx.font = `11px ${FONT}`; ctx.fillStyle = measured ? '#e1edf3' : '#7892a5';
    ctx.fillText(measured ? `${Math.round(level * 100)}%` : '—', x, meterY + 15, cellW - 3);
    ctx.fillStyle = '#2a4050'; ctx.fillRect(x, meterY + 23, cellW - 7, 2);
    if (measured) { ctx.fillStyle = accent; ctx.fillRect(x, meterY + 23, (cellW - 7) * level, 2); }
  });
  ctx.restore();
}

