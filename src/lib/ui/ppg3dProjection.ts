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
 * (`coords`) que produce el render 2D (mismo gate de strength, misma agudeza ^1.75,
 * misma marcaciÃ³n de arritmia, mismo barrido temporal). El 3D es sÃ³lo presentaciÃ³n:
 * la actividad cardÃ­aca del dedo se representa idÃ©ntica al modo 2D.
 *
 * Sin dependencias de Three.js / React-Three-Fiber (no compilan en mÃ³vil, son pesadas).
 * SÃ³lo importa el TIPO del renderer (erased en runtime) â†’ sin ciclos de import.
 */
import { WINDOW_MS, type PpgRenderState } from './ppgCanvasRenderer';

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
  signal: '34, 197, 94', // verde ECG
  signalBright: '74, 222, 128',
  arr: '239, 68, 68',
  cyan: '0, 242, 255',
  horizon: '103, 232, 249',
  gridMinor: '255, 255, 255', // lÃ­neas de grilla BLANCAS
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
 * Dibuja la GRILLA-PISO en perspectiva (reemplaza `drawECGGrid` cuando 3D estÃ¡ activo).
 * Mantiene la semÃ¡ntica ECG (lÃ­neas mayores/menores) pero con profundidad real.
 */
export function drawGrid3D(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const proj = makeProjector(state);
  const { plot } = state.layout;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  // Fondo NEGRO sÃ³lido detrÃ¡s de la grilla.
  ctx.fillStyle = '#000000';
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

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
    const alpha = (isMajor ? 0.55 : 0.25) * fade;
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
    g.addColorStop(0, `rgba(${C.gridMinor}, ${isMajor ? 0.55 : 0.25})`);
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
  drawGridReferences3D(ctx, proj, plot, state.amplitudeStats);

  ctx.restore();
}

/** Etiquetas numÃ©ricas de los ejes: amplitud (a.u.) a la izquierda y tiempo (-Ns) al frente. */
function drawGridReferences3D(
  ctx: CanvasRenderingContext2D,
  proj: Projector,
  plot: { x: number; y: number; w: number; h: number },
  stats: { min: number; max: number; range: number },
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
    for (let i = 1; i < n; i++) ctx.lineTo(Pf[i].x, Pf[i].y);
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(Pb[i].x, Pb[i].y);
    ctx.closePath();
    ctx.fillStyle = `rgba(${C.signalBright}, 0.16)`;
    ctx.fill();
  }

  // 3) Cara frontal (pared vertical de la cresta al piso) con degradado.
  const wallGrad = ctx.createLinearGradient(0, proj.horizonY, 0, proj.nearY);
  wallGrad.addColorStop(0, `rgba(${C.signal}, ${revealed ? 0.34 : 0.12})`);
  wallGrad.addColorStop(1, `rgba(${C.signal}, 0.02)`);
  ctx.beginPath();
  ctx.moveTo(Pfloor[0].x, Pfloor[0].y);
  for (let i = 0; i < n; i++) ctx.lineTo(Pf[i].x, Pf[i].y);
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
    for (let i = s; i < e; i++) ctx.lineTo(Pf[i].x, Pf[i].y);
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
    for (let i = 1; i < n; i++) ctx.lineTo(Pb[i].x, Pb[i].y);
    ctx.strokeStyle = `rgba(${C.signal}, 0.28)`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 5) Cresta frontal: la onda honesta. Segmentada por arritmia, con glow.
  const drawCrestSeg = (from: number, to: number, arr: boolean) => {
    ctx.beginPath();
    ctx.moveTo(Pf[from].x, Pf[from].y);
    for (let i = from + 1; i <= to; i++) ctx.lineTo(Pf[i].x, Pf[i].y);
    if (revealed) {
      ctx.strokeStyle = arr ? `rgba(${C.arr}, 0.9)` : `rgb(${C.signalBright})`;
      ctx.shadowColor = arr ? `rgba(${C.arr}, 0.55)` : `rgba(${C.signal}, 0.55)`;
      ctx.shadowBlur = 10;
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
  if (revealed) {
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
  const pulse = Math.max(state.sweepPulse, 0.04);
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

// === POZO DE PREVISUALIZACIÃ“N DINÃMICO ==========================================
// Ventana viva del dedo embebida en el piso 3D. CRECE con la calidad del
// contacto (animaciÃ³n con easing asimÃ©trico: abre firme, encoge honesto y
// rÃ¡pido) hasta â‰ˆ tamaÃ±o del dedo cuando el contacto es Ã³ptimo. Visor mÃ©dico
// premium: bisel con gradiente, bracketes de visor, barra de progreso,
// vidrio superior, scanline animada, tinte y pulso por estado.
// La cinta de la onda fluye POR ENCIMA (el pozo se dibuja antes que ella).

const WELL_D_FRONT = 0.38;      // borde frontal del hueco (0=near, 1=horizonte)
const WELL_D_BACK = 0.52;       // borde trasero (donde se apoya el panel)
const WELL_HALF_W_FRAC = 0.26;  // semiancho del hueco vs plotW
const WELL_PANEL_H_FRAC = 0.74; // altura del panel vs su ancho
const WELL_SIZE_MIN = 0.30;     // tamaÃ±o inicial (sin contacto) vs hueco mÃ¡ximo
const WELL_SIZE_MAX = 1.08;     // tamaÃ±o con contacto Ã³ptimo ("tamaÃ±o del dedo")
const WELL_EASE_UP = 0.045;     // crecimiento suave por frame (~1.1 s a 60 fps)
const WELL_EASE_DOWN = 0.20;    // encogimiento rÃ¡pido y honesto

/** TamaÃ±o animado persistente [0..1] (el render corre en rAF). */
let wellSizeEma = 0;

interface WellTheme { edge: string; core: string; glow: string; tint: string; label: string; }
function wellThemeFor(contactState?: string, pressure?: string, pressureScore?: number): WellTheme {
  // El color/etiqueta del pozo siguen el veredicto de presión cuando existe,
  // para no mostrar verde "CONTACTO ÓPTIMO" mientras hay colapso capilar.
  const score = typeof pressureScore === 'number' && Number.isFinite(pressureScore)
    ? Math.max(0, Math.min(1, pressureScore))
    : 0.5;
  if (pressure === 'HEAVY') {
    const severe = score > 0.80;
    return {
      edge: 'rgba(239,68,68,0.95)', core: 'rgba(252,165,165,0.9)',
      glow: `rgba(239,68,68,${(0.28 + 0.22 * score).toFixed(3)})`, tint: '239,68,68',
      label: severe ? 'PRESIÓN ALTA · SUELTA MÁS' : 'PRESIÓN ALTA · SUELTA UN POCO',
    };
  }
  if (pressure === 'LIGHT') {
    const severe = score < 0.25;
    return {
      edge: 'rgba(245,158,11,0.95)', core: 'rgba(253,230,138,0.9)',
      glow: 'rgba(245,158,11,0.35)', tint: '245,158,11',
      label: severe ? 'PRESIÓN BAJA · APOYA MÁS' : 'PRESIÓN BAJA · APOYA UN POCO',
    };
  }
  if (pressure === 'IDEAL') {
    return {
      edge: 'rgba(34,197,94,0.95)', core: 'rgba(134,239,172,0.9)',
      glow: 'rgba(34,197,94,0.40)', tint: '34,197,94',
      label: 'CONTACTO ÓPTIMO',
    };
  }
  switch (contactState) {
    case 'STABLE_CONTACT':
      return {
        edge: 'rgba(34,197,94,0.95)', core: 'rgba(134,239,172,0.9)',
        glow: 'rgba(34,197,94,0.40)', tint: '34,197,94',
        label: 'CONTACTO Ã“PTIMO',
      };
    case 'UNSTABLE_CONTACT':
      return {
        edge: 'rgba(245,158,11,0.95)', core: 'rgba(253,230,138,0.9)',
        glow: 'rgba(245,158,11,0.35)', tint: '245,158,11',
        label: 'AJUSTA LA POSICIÃ“N',
      };
    default:
      return {
        edge: 'rgba(148,163,184,0.55)', core: 'rgba(226,232,240,0.8)',
        glow: 'rgba(148,163,184,0.15)', tint: '148,163,184',
        label: 'APOYA EL DEDO EN LA LENTE',
      };
  }
}

/**
 * Score de colocaciÃ³n [0..1] SOLO con seÃ±ales ya presentes en el render state
 * (cero cÃ³mputo nuevo del pipeline). El tamaÃ±o de la ventana es su feedback.
 */
function wellScoreOf(state: PpgRenderState, _contactState?: string): number {
  // EVIDENCIA FISICA REAL: score directo del modulo fingerPlacementEvidence
  // (presion/ubicacion/movimiento/pulso medidos por frame en el pipeline).
  // Sin evidencia (pipeline parado, sin monitoreo, senal stale) -> 0:
  // la ventana NUNCA queda agrandada con datos viejos.
  const evidence = state.props.diagnostics?.placementEvidence;
  if (!evidence) return 0;
  return clamp(evidence.score, 0, 1);
}

/** RectÃ¡ngulo redondeado compatible (ctx.roundRect no existe en WebViews viejos). */
function roundRectPath(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Dibuja el pozo de previsualizaciÃ³n sobre el piso 3D. Debe llamarse DESPUÃ‰S de
 * `drawGrid3D` y ANTES de la onda (`drawSignal`), para que las ondas cardÃ­acas
 * fluyan visualmente por encima de la ventana.
 *
 * @param source  element de video de la cÃ¡mara trasera (o null â†’ pozo vacÃ­o).
 */
export function drawPreviewWell3D(
  ctx: CanvasRenderingContext2D,
  state: PpgRenderState,
  source: HTMLVideoElement | null,
  contactState?: string,
): void {
  const proj = makeProjector(state);
  const { plot } = state.layout;
  const pressureEvidence = state.props.diagnostics?.placementEvidence;
  const theme = wellThemeFor(contactState, pressureEvidence?.pressure, pressureEvidence?.pressureScore);

  // AnimaciÃ³n del tamaÃ±o: sube suave, baja rÃ¡pido (feedback honesto).
  const target = wellScoreOf(state, contactState);
  const ease = target > wellSizeEma ? WELL_EASE_UP : WELL_EASE_DOWN;
  wellSizeEma += (target - wellSizeEma) * ease;
  const size = wellSizeEma; // [0..1]

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  // 1) HUECO en el piso (FIJO = el "sillÃ³n" donde vive la ventana): trapecio
  // escorzado con paredes internas sombreadas.
  const halfW = plot.w * WELL_HALF_W_FRAC;
  const zF = proj.zNear + WELL_D_BACK * (proj.zFar - proj.zNear);
  const zn = proj.zNear + WELL_D_FRONT * (proj.zFar - proj.zNear);
  const fl = proj.floorPoint(-halfW, zn);
  const fr = proj.floorPoint(halfW, zn);
  const bl = proj.floorPoint(-halfW, zF);
  const br = proj.floorPoint(halfW, zF);

  ctx.beginPath();
  ctx.moveTo(fl.x, fl.y);
  ctx.lineTo(fr.x, fr.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.82)';
  ctx.fill();

  const wallShade = (a: ProjPoint, b: ProjPoint, alpha: number) => {
    const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    g.addColorStop(0, `rgba(0,0,0,${alpha})`);
    g.addColorStop(1, 'rgba(0,0,0,0.15)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(b.x, b.y + 6 * b.scale);
    ctx.lineTo(a.x, a.y + 6 * a.scale);
    ctx.closePath();
    ctx.fill();
  };
  wallShade(fl, bl, 0.55);
  wallShade(fr, br, 0.55);
  wallShade(bl, br, 0.35);

  // Bisel del hueco con brillo degradado hacia el panel (luz que emana).
  const bezGrad = ctx.createLinearGradient(0, fl.y, 0, bl.y);
  bezGrad.addColorStop(0, 'rgba(255,255,255,0.10)');
  bezGrad.addColorStop(1, theme.edge);
  ctx.beginPath();
  ctx.moveTo(fl.x, fl.y);
  ctx.lineTo(fr.x, fr.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.strokeStyle = bezGrad;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // 2) PANEL DINÃMICO de pie sobre el borde trasero del hueco. TamaÃ±o = score.
  const base = proj.floorPoint(0, zF);
  const maxW = halfW * 2 * proj.scaleAt(WELL_D_BACK) * 1.18;
  const panelW = maxW * (WELL_SIZE_MIN + (WELL_SIZE_MAX - WELL_SIZE_MIN) * size);
  const panelH = panelW * WELL_PANEL_H_FRAC;
  const px = base.x - panelW / 2;
  const py = base.y - panelH;

  // Glow reactivo (intensidad crece con el tamaÃ±o â†’ refuerzo positivo).
  ctx.shadowColor = theme.glow;
  ctx.shadowBlur = 10 + 18 * size;
  roundRectPath(ctx, px, py, panelW, panelH, Math.max(6, panelW * 0.08));
  const frameGrad = ctx.createLinearGradient(0, py, 0, py + panelH);
  frameGrad.addColorStop(0, theme.core);
  frameGrad.addColorStop(1, theme.edge);
  ctx.strokeStyle = frameGrad;
  ctx.lineWidth = 1.5 + 1.2 * size;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 3) VIDEO vivo (o pantalla apagada), recorte central del dedo.
  const hasVideo = !!source && source.readyState >= 2 && source.videoWidth > 0;
  roundRectPath(ctx, px, py, panelW, panelH, Math.max(6, panelW * 0.08));
  ctx.save();
  ctx.clip();
  if (hasVideo) {
    const v = source as HTMLVideoElement;
    const side = Math.min(v.videoWidth, v.videoHeight) * 0.9;
    const sx = (v.videoWidth - side) / 2;
    const sy = (v.videoHeight - side) / 2;
    ctx.globalAlpha = 0.95;
    ctx.drawImage(v, sx, sy, side, side, px, py, panelW, panelH);
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = 'rgba(10,12,16,0.9)';
    ctx.fillRect(px, py, panelW, panelH);
  }

  // 3a) Tinte por estado (baÃ±a el video con el color del veredicto).
  ctx.fillStyle = `rgba(${theme.tint}, ${0.10 + 0.14 * size})`;
  ctx.fillRect(px, py, panelW, panelH);

  // 3b) Vidrio superior (reflejo de pantalla) â€”æ„Ÿ de visor mÃ©dico.
  const glass = ctx.createLinearGradient(0, py, 0, py + panelH * 0.45);
  glass.addColorStop(0, 'rgba(255,255,255,0.10)');
  glass.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glass;
  ctx.fillRect(px, py, panelW, panelH * 0.45);

  // 3c) Scanline animada (vive incluso sin video â†’ "sensor activo").
  const scanY = py + ((state.now / 14) % Math.max(8, panelH));
  const scan = ctx.createLinearGradient(0, scanY - 6, 0, scanY + 6);
  scan.addColorStop(0, 'rgba(255,255,255,0)');
  scan.addColorStop(0.5, `rgba(${theme.tint}, 0.10)`);
  scan.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = scan;
  ctx.fillRect(px, scanY - 6, panelW, 12);
  ctx.restore(); // fin clip del panel

  // 4) BRACKETES de visor (4 esquinas en L, estilo cÃ¡mara mÃ©dica).
  const bl2 = Math.max(7, panelW * 0.16);
  const bw = 2 + size;
  ctx.strokeStyle = theme.core;
  ctx.lineWidth = bw;
  ctx.lineCap = 'round';
  const corners: Array<[number, number, number, number]> = [
    [px, py + bl2, px, py], [px, py, px + bl2, py],
    [px + panelW - bl2, py, px + panelW, py], [px + panelW, py, px + panelW, py + bl2],
    [px + panelW, py + panelH - bl2, px + panelW, py + panelH], [px + panelW, py + panelH, px + panelW - bl2, py + panelH],
    [px + bl2, py + panelH, px, py + panelH], [px, py + panelH, px, py + panelH - bl2],
  ];
  for (const [x1, y1, x2, y2] of corners) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // 5) PULSO al latir (STABLE): anillo expansivo desde el centro del panel.
  if (contactState === 'STABLE_CONTACT') {
    const pulse = Math.max(state.sweepPulse, 0.04);
    const cx = base.x;
    const cy = py + panelH / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.min(panelW, panelH) * (0.42 + pulse * 0.22), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(34,197,94, ${(0.28 * (1 - pulse)).toFixed(3)})`;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  // 6) ETIQUETA de guÃ­a sobre el panel + porcentaje de colocaciÃ³n.
  // Guia EXACTA: el primer criterio que falla segun la evidencia fisica.
  const evidence = state.props.diagnostics?.placementEvidence;
  const guideText = evidence && evidence.failing.length > 0 && size > 0.08
    ? evidence.failing[0]
    : theme.label;
  ctx.font = `bold 9px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = theme.core;
  ctx.fillText(guideText, base.x, py - 14);
  ctx.font = `bold 11px ${FONT}`;
  ctx.fillText(`${Math.round(size * 100)}%`, base.x, py - 4);

  // 7) BARRA de progreso bajo el panel (micro-feedback adicional).
  const barW = panelW * 0.72;
  const barH = 2.6;
  const barX = base.x - barW / 2;
  const barY = base.y + 5;
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = theme.edge;
  ctx.fillRect(barX, barY, barW * size, barH);

  ctx.restore();
}
