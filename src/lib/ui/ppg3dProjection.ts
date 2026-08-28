/**
 * PPG 3D PROJECTION — Capa de profundidad de alta fidelidad para el monitor cardíaco.
 *
 * Render en CANVAS 2D PURO con proyección en perspectiva matemática (ley pinhole 1/z).
 * Elementos clave:
 *   1) GRILLA-PISO animada en perspectiva con flujo infinito en Z (Z-travel continuo),
 *      resplandor atmosférico en el horizonte y ondas de choque elípticas en el piso al latir.
 *   2) ONDA CARDÍACA 3D como CINTA CURVADA (Smooth Splines):
 *      - Cresta frontal suavizada mediante curvas cuadráticas continuas.
 *      - Cara superior de cinta volumétrica con grosor en profundidad (Z-Back).
 *      - Pared vertical con gradiente translúcido hacia el piso.
 *      - Sombra proyectada difusa en el plano de la grilla.
 *      - Marcadores fiduciales flotantes con columnas láser y anillos de impacto en el piso.
 *
 * Reusa 100% las coordenadas honestas de la señal cardíaca.
 */
import { WINDOW_MS, type PpgRenderState } from './ppgCanvasRenderer';

const FONT = '"SF Mono", Consolas, "Roboto Mono", "JetBrains Mono", monospace';

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

// Calibración de cámara virtual en perspectiva
const Z_NEAR = 1.0;
const Z_FAR = 5.4;
const HORIZON_FRAC = 0.08;
const NEAR_MARGIN_PX = 32;
const MAX_LIFT_FRAC = 0.65;
const WAVE_D_FRONT = 0.05;
const WAVE_D_BACK = 0.20;

const C = {
  signal: '34, 197, 94',
  signalBright: '74, 222, 128',
  arr: '239, 68, 68',
  arrBright: '248, 113, 113',
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
 * Dibuja la GRILLA-PISO en perspectiva con avance continuo en Z (Z-Travel),
 * resplandor en el horizonte y ondas de choque de impacto fisiológico en el piso.
 */
export function drawGrid3D(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const proj = makeProjector(state);
  const { plot } = state.layout;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  // 1. Fondo espacial profundo con gradiente de oclusión
  const bgGrad = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
  bgGrad.addColorStop(0, '#02050e');
  bgGrad.addColorStop(0.45, '#050b18');
  bgGrad.addColorStop(1, '#010307');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

  // 2. Resplandor atmosférico en el horizonte (Aurora / Flare biométrico)
  const pulseScale = state.sweepPulse ? Math.max(state.sweepPulse, 0.05) : 0.05;
  const horizonGlow = ctx.createRadialGradient(
    proj.vpX,
    proj.horizonY,
    4,
    proj.vpX,
    proj.horizonY,
    plot.w * (0.55 + pulseScale * 0.2)
  );
  horizonGlow.addColorStop(0, `rgba(6, 182, 212, ${0.28 + pulseScale * 0.15})`);
  horizonGlow.addColorStop(0.35, `rgba(34, 197, 94, ${0.12 + pulseScale * 0.08})`);
  horizonGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = horizonGlow;
  ctx.fillRect(plot.x, plot.y, plot.w, proj.horizonY + 70);

  // 3. Línea de horizonte brillante con resplandor láser
  ctx.strokeStyle = `rgba(${C.horizon}, 0.65)`;
  ctx.shadowColor = '#00f2ff';
  ctx.shadowBlur = 8;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(plot.x, proj.horizonY);
  ctx.lineTo(plot.x + plot.w, proj.horizonY);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 4. Parámetros de la grilla en perspectiva
  const TARGET_COLS = 11;
  const cellPx = proj.plotW / TARGET_COLS;
  const halfCols = Math.ceil(TARGET_COLS / 2);
  const halfX = halfCols * cellPx;
  const dZ = cellPx / proj.floorSpanY;

  // Avance continuo en el eje Z (Z-Travel fluido)
  const travelSpeed = 0.00035;
  const zOffset = (state.now * travelSpeed) % dZ;

  // 5. Filas de profundidad (Z constante) con movimiento hacia adelante
  let rowIdx = 0;
  let prevRowY = Number.POSITIVE_INFINITY;
  for (let z = proj.zNear + (dZ - zOffset) % dZ; z <= proj.zFar + 1e-6; z += dZ, rowIdx++) {
    const a = proj.floorPoint(-halfX, z);
    if (prevRowY - a.y < 1.5) break;
    const b = proj.floorPoint(halfX, z);
    const isMajor = rowIdx % 4 === 0;
    const fade = 0.20 + 0.80 * a.scale;
    const alpha = (isMajor ? 0.55 : 0.22) * fade;

    ctx.strokeStyle = isMajor
      ? `rgba(${C.horizon}, ${alpha.toFixed(3)})`
      : `rgba(${C.gridMinor}, ${alpha.toFixed(3)})`;
    ctx.lineWidth = isMajor ? 1.2 : 0.6;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    prevRowY = a.y;
  }

  // 6. Columnas longitudinales (X constante que convergen al punto de fuga)
  for (let k = -halfCols; k <= halfCols; k++) {
    const xw = k * cellPx;
    const near = proj.floorPoint(xw, proj.zNear);
    const far = proj.floorPoint(xw, proj.zFar);
    const isMajor = k % 4 === 0;
    const g = ctx.createLinearGradient(near.x, near.y, far.x, far.y);
    g.addColorStop(0, `rgba(${isMajor ? C.horizon : C.gridMinor}, ${isMajor ? 0.60 : 0.28})`);
    g.addColorStop(1, `rgba(${isMajor ? C.horizon : C.gridMinor}, 0.02)`);
    ctx.strokeStyle = g;
    ctx.lineWidth = isMajor ? 1.2 : 0.6;
    ctx.beginPath();
    ctx.moveTo(near.x, near.y);
    ctx.lineTo(far.x, far.y);
    ctx.stroke();
  }

  // 7. Onda de Choque Elíptica en el Piso (Floor Shockwave en latido)
  if (state.traceRevealed && state.sweepPulse > 0.06) {
    const shockProg = 1 - state.sweepPulse; // 0..1
    const shockZ = proj.zNear + shockProg * (proj.zFar - proj.zNear) * 0.72;
    const shockRadX = (proj.plotW * 0.48) * (0.15 + 0.85 * shockProg);
    const shockCenter = proj.floorPoint(0, shockZ);
    const shockLeft = proj.floorPoint(-shockRadX, shockZ);
    const shockRight = proj.floorPoint(shockRadX, shockZ);
    const radPxX = (shockRight.x - shockLeft.x) / 2;
    const radPxY = Math.max(3, radPxX * 0.24 * shockCenter.scale);

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(shockCenter.x, shockCenter.y, radPxX, radPxY, 0, 0, Math.PI * 2);
    const shockAlpha = (1 - shockProg) * 0.50;
    ctx.strokeStyle = `rgba(0, 242, 255, ${shockAlpha.toFixed(3)})`;
    ctx.lineWidth = 2.0 * shockCenter.scale;
    ctx.shadowColor = '#00f2ff';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.restore();
  }

  // 8. Borde frontal (Baseline cero con resplandor)
  const fl = proj.floorPoint(-halfX, proj.zNear);
  const fr = proj.floorPoint(halfX, proj.zNear);
  ctx.save();
  ctx.strokeStyle = `rgba(${C.signal}, 0.90)`;
  ctx.shadowColor = '#22c55e';
  ctx.shadowBlur = 10;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(fl.x, fl.y);
  ctx.lineTo(fr.x, fr.y);
  ctx.stroke();
  ctx.restore();

  // 9. Referencias de Ejes
  drawGridReferences3D(ctx, proj, plot, state.amplitudeStats);

  ctx.restore();
}

/** Etiquetas numéricas de los ejes en 3D. */
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
 * Dibuja la ONDA CARDÍACA 3D como cinta extruida con curvatura suave (Splines / Quadratic Curves),
 * bisel brillante, pared vertical con degradado y marcadores fiduciales con anillos en el piso.
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

  // Helper para trazar camino suavizado con curvas cuadráticas
  const traceSmoothPath = (pts: ProjPoint[], from = 0, to = pts.length - 1) => {
    if (to <= from) return;
    ctx.moveTo(pts[from].x, pts[from].y);
    for (let i = from; i < to; i++) {
      const xc = (pts[i].x + pts[i + 1].x) / 2;
      const yc = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
    }
    ctx.lineTo(pts[to].x, pts[to].y);
  };

  // 1) Sombra proyectada en el piso en perspectiva
  if (revealed) {
    let s = 0;
    while (s < n - 1) {
      const isArr = coords[s].isArr;
      let e = s;
      while (e < n - 1 && coords[e].isArr === isArr) e++;
      const col = isArr ? C.arr : C.signal;
      ctx.beginPath();
      traceSmoothPath(Pfloor, s, e);
      ctx.strokeStyle = `rgba(${col}, ${isArr ? 0.38 : 0.16})`;
      ctx.lineWidth = isArr ? 8 : 6;
      ctx.shadowColor = `rgba(${col}, ${isArr ? 0.35 : 0.08})`;
      ctx.shadowBlur = isArr ? 12 : 4;
      ctx.stroke();
      ctx.shadowBlur = 0;
      s = e;
    }
  }

  // 2) Cara superior de la cinta (Grosor 3D) con suavizado
  if (revealed) {
    ctx.beginPath();
    ctx.moveTo(Pf[0].x, Pf[0].y);
    traceSmoothPath(Pf, 0, n - 1);
    ctx.lineTo(Pb[n - 1].x, Pb[n - 1].y);
    for (let i = n - 2; i >= 0; i--) {
      ctx.lineTo(Pb[i].x, Pb[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = `rgba(${C.signalBright}, 0.24)`;
    ctx.fill();
  }

  // 3) Cara frontal vertical con degradado volumétrico
  const wallGrad = ctx.createLinearGradient(0, proj.horizonY, 0, proj.nearY);
  wallGrad.addColorStop(0, `rgba(${C.signal}, ${revealed ? 0.42 : 0.15})`);
  wallGrad.addColorStop(0.55, `rgba(${C.signal}, ${revealed ? 0.18 : 0.05})`);
  wallGrad.addColorStop(1, `rgba(${C.signal}, 0.01)`);

  ctx.beginPath();
  ctx.moveTo(Pfloor[0].x, Pfloor[0].y);
  traceSmoothPath(Pf, 0, n - 1);
  ctx.lineTo(Pfloor[n - 1].x, Pfloor[n - 1].y);
  for (let i = n - 2; i >= 0; i--) {
    ctx.lineTo(Pfloor[i].x, Pfloor[i].y);
  }
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
    traceSmoothPath(Pf, s, e - 1);
    ctx.lineTo(Pfloor[e - 1].x, Pfloor[e - 1].y);
    for (let i = e - 2; i >= s; i--) ctx.lineTo(Pfloor[i].x, Pfloor[i].y);
    ctx.closePath();
    ctx.fillStyle = `rgba(${C.arr}, 0.55)`;
    ctx.fill();
    s = e;
  }

  // 4) Cresta trasera suave
  if (revealed) {
    ctx.beginPath();
    traceSmoothPath(Pb, 0, n - 1);
    ctx.strokeStyle = `rgba(${C.signal}, 0.35)`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 5) Cresta frontal (Onda cardíaca honesta con haz de fósforo y láser)
  const drawCrestSeg = (from: number, to: number, arr: boolean) => {
    ctx.beginPath();
    traceSmoothPath(Pf, from, to);
    if (revealed) {
      ctx.strokeStyle = arr ? `rgba(${C.arr}, 0.95)` : `rgb(${C.signalBright})`;
      ctx.shadowColor = arr ? `rgba(${C.arr}, 0.70)` : `rgba(${C.signal}, 0.70)`;
      ctx.shadowBlur = 12;
      ctx.lineWidth = 2.4;
      ctx.stroke();

      // Núcleo blanco eléctrico ultra-nítido
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

  // 6) Marcadores fiduciales 3D y Columnas Láser con Anillos de Impacto en el Piso
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

      // Pico sistólico (SYS)
      if (v > prev && v > next && v > prev2 && v > next2 && v > geom.midValue) {
        // Columna láser vertical punteada
        ctx.strokeStyle = isArr ? 'rgba(239, 68, 68, 0.45)' : 'rgba(0, 242, 255, 0.40)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y + 4);
        ctx.lineTo(pfG.x, pfG.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Anillo de impacto elíptico en el piso en perspectiva
        const impactRadX = 6 * p.scale;
        const impactRadY = impactRadX * 0.35;
        ctx.beginPath();
        ctx.ellipse(pfG.x, pfG.y, impactRadX, impactRadY, 0, 0, Math.PI * 2);
        ctx.strokeStyle = isArr ? 'rgba(239, 68, 68, 0.65)' : 'rgba(0, 242, 255, 0.65)';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // Diamante flotante en la cresta
        const r = 3.2 + p.scale * 1.8;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x + r, p.y);
        ctx.lineTo(p.x, p.y + r);
        ctx.lineTo(p.x - r, p.y);
        ctx.closePath();
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

  // 7) Cursor conductor en la cabeza de la señal 3D
  const head = Pf[n - 1];
  const headArr = coords[n - 1].isArr;
  const pulse = Math.max(state.sweepPulse, 0.04);

  if (revealed && pulse > 0.10) {
    for (let rIdx = 1; rIdx <= 2; rIdx++) {
      const ringRad = (8 + pulse * (16 * rIdx)) * head.scale;
      const ringAlpha = (1 - pulse) * (0.6 / rIdx);
      ctx.beginPath();
      ctx.arc(head.x, head.y, ringRad, 0, Math.PI * 2);
      ctx.strokeStyle = headArr ? `rgba(239, 68, 68, ${ringAlpha})` : `rgba(0, 242, 255, ${ringAlpha})`;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }

  ctx.beginPath();
  ctx.arc(head.x, head.y, (6 + pulse * 6) * (0.7 + 0.3 * head.scale), 0, Math.PI * 2);
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
