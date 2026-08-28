/**
 * PPG 3D PROJECTION — Capa de profundidad real para el monitor cardíaco.
 *
 * Render en CANVAS 2D PURO con proyección en perspectiva (modelo pinhole / ley 1/z).
 * Implementa dos elementos validados de visualización 3D:
 *   1) GRILLA-PISO en perspectiva (técnica "outrun/synthwave floor"): las filas de
 *      profundidad se comprimen hacia un horizonte y las columnas de tiempo convergen
 *      a un punto de fuga → profundidad real.
 *   2) ONDA como CINTA 3D EXTRUIDA (ribbon): cresta frontal honesta + cara lateral
 *      hacia el piso + cara superior con grosor en profundidad + sombra proyectada.
 *
 * CLAVE: la onda NO se recalcula. Reusa EXACTAMENTE las mismas coordenadas honestas
 * (`coords`) que produce el render 2D (mismo gate de strength, misma agudeza ^1.75,
 * misma marcación de arritmia, mismo barrido temporal). El 3D es sólo presentación:
 * la actividad cardíaca del dedo se representa idéntica al modo 2D.
 */
import { WINDOW_MS, type PpgRenderState } from './ppgCanvasRenderer';

/** Fuente monoespaciada (misma familia que el renderer 2D). */
const FONT = '"SF Mono", Consolas, "Roboto Mono", "JetBrains Mono", monospace';

/** Coordenada honesta de la onda, idéntica a la que arma `drawSignal` en 2D. */
export interface WaveCoord {
  x: number;
  y: number;
  isArr: boolean;
  val: number;
}

/** Geometría 2D de la zona de onda, para recuperar amplitud normalizada y tiempo. */
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
   *  - h  [0..1] altura sobre el piso (0 = piso, 1 = altura máxima)
   */
  project: (u: number, d: number, h: number) => ProjPoint;
  scaleAt: (d: number) => number;
  /**
   * Proyecta un punto del PISO en coordenadas-mundo:
   *  - xWorld: desplazamiento lateral en px-a-distancia-cercana (0 = centro)
   *  - zWorld: profundidad real [zNear..zFar]
   * Las unidades de xWorld y de la profundidad comparten escala → celdas cuadradas.
   */
  floorPoint: (xWorld: number, zWorld: number) => ProjPoint;
}

// === Calibración de la cámara virtual ===========================================
const Z_NEAR = 1;
const Z_FAR = 5.2; // compresión de profundidad (mayor = horizonte más comprimido)
const HORIZON_FRAC = 0.08; // horizonte más alto → piso (grilla) más grande
const NEAR_MARGIN_PX = 30; // sitio para el tacograma + etiquetas de tiempo del eje
const MAX_LIFT_FRAC = 0.62; // altura máx. de la onda como fracción del piso visible
const WAVE_D_FRONT = 0.05;
const WAVE_D_BACK = 0.18;

// Paleta local calibrada
const C = {
  signal: '34, 197, 94',
  signalBright: '74, 222, 128',
  arr: '239, 68, 68',
  cyan: '0, 242, 255',
  horizon: '103, 232, 249',
  gridMinor: '255, 255, 255',
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
  const scaleAt = (d: number) => Z_NEAR / zAt(d);

  const project = (u: number, d: number, h: number): ProjPoint => {
    const s = scaleAt(d);
    const x = vpX + (u - 0.5) * plot.w * s;
    const groundY = horizonY + floorSpanY * s;
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
 * Dibuja la GRILLA-PISO en perspectiva con resplandor en el horizonte y baldosas holográficas.
 */
export function drawGrid3D(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const proj = makeProjector(state);
  const { plot } = state.layout;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  // Fondo espacial profundo con viñeta
  const bgGrad = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
  bgGrad.addColorStop(0, '#02050c');
  bgGrad.addColorStop(0.5, '#050a16');
  bgGrad.addColorStop(1, '#020409');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

  // Resplandor de horizonte / flare atmosférico
  const horizonGlow = ctx.createRadialGradient(proj.vpX, proj.horizonY, 5, proj.vpX, proj.horizonY, plot.w * 0.6);
  horizonGlow.addColorStop(0, 'rgba(6, 182, 212, 0.25)');
  horizonGlow.addColorStop(0.3, 'rgba(34, 197, 94, 0.12)');
  horizonGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = horizonGlow;
  ctx.fillRect(plot.x, plot.y, plot.w, proj.horizonY + 60);

  // Línea de horizonte brillante
  ctx.strokeStyle = `rgba(${C.horizon}, 0.55)`;
  ctx.shadowColor = '#00f2ff';
  ctx.shadowBlur = 8;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(plot.x, proj.horizonY);
  ctx.lineTo(plot.x + plot.w, proj.horizonY);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // === GRILLA CUADRADA en perspectiva ===
  const TARGET_COLS = 11;
  const cellPx = proj.plotW / TARGET_COLS;
  const halfCols = Math.ceil(TARGET_COLS / 2);
  const halfX = halfCols * cellPx;
  const dZ = cellPx / proj.floorSpanY;

  // Filas (Z constante)
  let rowIdx = 0;
  let prevRowY = Number.POSITIVE_INFINITY;
  for (let z = proj.zNear; z <= proj.zFar + 1e-6; z += dZ, rowIdx++) {
    const a = proj.floorPoint(-halfX, z);
    if (prevRowY - a.y < 2) break;
    const b = proj.floorPoint(halfX, z);
    const isMajor = rowIdx % 5 === 0;
    const fade = 0.25 + 0.75 * a.scale;
    const alpha = (isMajor ? 0.60 : 0.28) * fade;
    ctx.strokeStyle = isMajor ? `rgba(${C.horizon}, ${alpha.toFixed(3)})` : `rgba(${C.gridMinor}, ${alpha.toFixed(3)})`;
    ctx.lineWidth = isMajor ? 1.3 : 0.7;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    prevRowY = a.y;
  }

  // Columnas (X constante)
  for (let k = -halfCols; k <= halfCols; k++) {
    const xw = k * cellPx;
    const near = proj.floorPoint(xw, proj.zNear);
    const far = proj.floorPoint(xw, proj.zFar);
    const isMajor = k % 5 === 0;
    const g = ctx.createLinearGradient(near.x, near.y, far.x, far.y);
    g.addColorStop(0, `rgba(${isMajor ? C.horizon : C.gridMinor}, ${isMajor ? 0.60 : 0.30})`);
    g.addColorStop(1, `rgba(${isMajor ? C.horizon : C.gridMinor}, 0.05)`);
    ctx.strokeStyle = g;
    ctx.lineWidth = isMajor ? 1.2 : 0.7;
    ctx.beginPath();
    ctx.moveTo(near.x, near.y);
    ctx.lineTo(far.x, far.y);
    ctx.stroke();
  }

  // Borde frontal (baseline cero con resplandor)
  const fl = proj.floorPoint(-halfX, proj.zNear);
  const fr = proj.floorPoint(halfX, proj.zNear);
  ctx.save();
  ctx.strokeStyle = `rgba(${C.signal}, 0.85)`;
  ctx.shadowColor = '#22c55e';
  ctx.shadowBlur = 8;
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  ctx.moveTo(fl.x, fl.y);
  ctx.lineTo(fr.x, fr.y);
  ctx.stroke();
  ctx.restore();

  // Referencias numéricas de los ejes
  drawGridReferences3D(ctx, proj, plot, state.amplitudeStats);

  ctx.restore();
}

/** Etiquetas numéricas de los ejes: amplitud (a.u.) a la izquierda y tiempo (-Ns) al frente. */
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
    ctx.strokeStyle = 'rgba(255,255,255,0.30)';
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
    ctx.fillText(`-${sBack}s`, p.x, proj.nearY + 14);
  }
}

/**
 * Dibuja la ONDA como cinta 3D extruida sobre el piso en perspectiva con bisel brillante
 * y columnas de proyección vertical holográfica en los picos sistólicos.
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

  // 1) Sombra proyectada en el piso con desenfoque
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
      ctx.strokeStyle = `rgba(${col}, ${isArr ? 0.40 : 0.16})`;
      ctx.lineWidth = isArr ? 9 : 7;
      ctx.shadowColor = `rgba(${col}, ${isArr ? 0.35 : 0.08})`;
      ctx.shadowBlur = isArr ? 14 : 4;
      ctx.stroke();
      ctx.shadowBlur = 0;
      s = e;
    }
  }

  // 1b) Rayos de arritmia hacia el punto de fuga
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
      ctx.strokeStyle = `rgba(${C.arr}, ${(0.10 + 0.15 * fade).toFixed(3)})`;
      ctx.lineWidth = 1.6 + 1.6 * fade;
      ctx.stroke();
    }
  }

  // 2) Cara superior de la cinta (grosor 3D) con brillo translúcido
  if (revealed) {
    ctx.beginPath();
    ctx.moveTo(Pf[0].x, Pf[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(Pf[i].x, Pf[i].y);
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(Pb[i].x, Pb[i].y);
    ctx.closePath();
    ctx.fillStyle = `rgba(${C.signalBright}, 0.22)`;
    ctx.fill();
  }

  // 3) Cara frontal vertical con degradado volumétrico
  const wallGrad = ctx.createLinearGradient(0, proj.horizonY, 0, proj.nearY);
  wallGrad.addColorStop(0, `rgba(${C.signal}, ${revealed ? 0.40 : 0.15})`);
  wallGrad.addColorStop(0.6, `rgba(${C.signal}, ${revealed ? 0.18 : 0.05})`);
  wallGrad.addColorStop(1, `rgba(${C.signal}, 0.01)`);
  ctx.beginPath();
  ctx.moveTo(Pfloor[0].x, Pfloor[0].y);
  for (let i = 0; i < n; i++) ctx.lineTo(Pf[i].x, Pf[i].y);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(Pfloor[i].x, Pfloor[i].y);
  ctx.closePath();
  ctx.fillStyle = wallGrad;
  ctx.fill();

  // 3b) Cara de arritmia sobre-pintada en carmesí
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
    ctx.fillStyle = `rgba(${C.arr}, 0.55)`;
    ctx.fill();
    s = e;
  }

  // 4) Cresta trasera
  if (revealed) {
    ctx.beginPath();
    ctx.moveTo(Pb[0].x, Pb[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(Pb[i].x, Pb[i].y);
    ctx.strokeStyle = `rgba(${C.signal}, 0.35)`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 5) Cresta frontal (onda honesta con haz de alta luminosidad)
  const drawCrestSeg = (from: number, to: number, arr: boolean) => {
    ctx.beginPath();
    ctx.moveTo(Pf[from].x, Pf[from].y);
    for (let i = from + 1; i <= to; i++) ctx.lineTo(Pf[i].x, Pf[i].y);
    if (revealed) {
      ctx.strokeStyle = arr ? `rgba(${C.arr}, 0.95)` : `rgb(${C.signalBright})`;
      ctx.shadowColor = arr ? `rgba(${C.arr}, 0.65)` : `rgba(${C.signal}, 0.65)`;
      ctx.shadowBlur = 12;
      ctx.lineWidth = 2.4;
      ctx.stroke();

      // Núcleo blanco fino
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.0;
      ctx.shadowBlur = 3;
      ctx.shadowColor = '#ffffff';
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
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

  // 6) Marcadores fiduciales 3D y Columnas de Proyección Vertical Láser
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
      const pfG = Pfloor[i];

      // Pico sistólico (SYS) con columna láser vertical
      if (v > prev && v > next && v > prev2 && v > next2 && v > geom.midValue) {
        // Columna láser hacia el piso en perspectiva
        ctx.strokeStyle = isArr ? 'rgba(239, 68, 68, 0.40)' : 'rgba(0, 242, 255, 0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y + 4);
        ctx.lineTo(pfG.x, pfG.y);
        ctx.stroke();
        ctx.setLineDash([]);

        const r = 3.0 + p.scale * 1.8;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = isArr ? `rgb(${C.arr})` : '#ffffff';
        ctx.shadowColor = isArr ? `rgb(${C.arr})` : `rgb(${C.cyan})`;
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.font = `bold 9px ${FONT}`;
        ctx.fillStyle = isArr ? `rgb(${C.arr})` : `rgb(${C.cyan})`;
        ctx.fillText(v.toFixed(1), p.x, p.y - 11);
        ctx.font = `bold 7px ${FONT}`;
        ctx.fillStyle = isArr ? '#fecaca' : 'rgba(255, 255, 255, 0.85)';
        ctx.fillText(isArr ? 'ARR' : 'SYS', p.x, p.y - 21);

        if (isArr) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${C.arr}, 0.75)`;
          ctx.lineWidth = 1.6;
          ctx.stroke();
        }
      }

      // Valle diastólico (DIA)
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

      // Muesca dícrota (DIC)
      const d1Curr = v - prev;
      const d1Next = next - v;
      if (d1Curr < 0 && d1Next > d1Curr && d1Next < 0 && v > geom.midValue) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(103, 232, 249, 0.75)';
        ctx.fill();
        if (quality > 70) {
          ctx.font = `7px ${FONT}`;
          ctx.fillStyle = 'rgba(103, 232, 249, 0.9)';
          ctx.fillText('DIC', p.x, p.y - 7);
        }
      }
    }
  }

  // 7) Halo pulsátil en la punta conductora 3D
  const head = Pf[n - 1];
  const headArr = coords[n - 1].isArr;
  const pulse = Math.max(state.sweepPulse, 0.04);
  
  if (revealed && pulse > 0.12) {
    ctx.beginPath();
    ctx.arc(head.x, head.y, (12 + pulse * 20) * head.scale, 0, Math.PI * 2);
    ctx.strokeStyle = headArr ? 'rgba(239, 68, 68, 0.35)' : 'rgba(0, 242, 255, 0.35)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(head.x, head.y, (6 + pulse * 8) * (0.7 + 0.3 * head.scale), 0, Math.PI * 2);
  ctx.fillStyle = revealed
    ? headArr ? `rgba(${C.arr}, 0.35)` : `rgba(${C.cyan}, 0.35)`
    : 'rgba(148, 163, 184, 0.18)';
  ctx.fill();
  
  ctx.beginPath();
  ctx.arc(head.x, head.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = headArr ? '#ef4444' : '#00f2ff';
  ctx.shadowBlur = 8;
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.restore();
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
