/**
 * PPG 3D PROJECTION — Capa de profundidad de alta fidelidad para el monitor cardíaco.
 *
 * Render en CANVAS 2D PURO con proyección en perspectiva matemática (ley pinhole 1/z).
 * Elementos clave:
 *   1) GRILLA-PISO 3D fluida y ensanchada (Z-travel continuo sin tirones con smoothstep),
 *      resplandor atmosférico en el horizonte y ondas de choque elípticas en el piso.
 *   2) ONDA CARDÍACA 3D como CINTA CURVADA (Smooth Splines):
 *      - Cresta frontal suavizada mediante curvas cuadráticas continuas.
 *      - Cara superior de cinta volumétrica con grosor en profundidad (Z-Back).
 *      - Pared vertical con gradiente translúcido hacia el piso.
 *      - Sombra proyectada difusa en el plano de la grilla.
 *      - Marcadores fiduciales flotantes con columnas láser y anillos de impacto en el piso.
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
const Z_FAR = 5.6;
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

function smoothstep(min: number, max: number, value: number): number {
  const x = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return x * x * (3 - 2 * x);
}

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
 * Dibuja la GRILLA-PISO en perspectiva fluida y ensanchada (Z-Travel continuo sin tirones con smoothstep),
 * resplandor en el horizonte y ondas de choque de impacto fisiológico en el piso.
 */
export function drawGrid3D(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const proj = makeProjector(state);
  const { plot } = state.layout;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  // 1. Fondo espacial profundo con viñeta
  const bgGrad = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
  bgGrad.addColorStop(0, '#02050e');
  bgGrad.addColorStop(0.45, '#050b18');
  bgGrad.addColorStop(1, '#010307');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

  // 2. Resplandor atmosférico en el horizonte (Aurora biométrica)
  const pulseScale = state.sweepPulse ? Math.max(state.sweepPulse, 0.05) : 0.05;
  const horizonGlow = ctx.createRadialGradient(
    proj.vpX,
    proj.horizonY,
    4,
    proj.vpX,
    proj.horizonY,
    plot.w * (0.60 + pulseScale * 0.25)
  );
  horizonGlow.addColorStop(0, `rgba(6, 182, 212, ${0.30 + pulseScale * 0.15})`);
  horizonGlow.addColorStop(0.35, `rgba(34, 197, 94, ${0.14 + pulseScale * 0.08})`);
  horizonGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = horizonGlow;
  ctx.fillRect(plot.x, plot.y, plot.w, proj.horizonY + 80);

  // 3. Línea de horizonte brillante con resplandor láser
  ctx.strokeStyle = `rgba(${C.horizon}, 0.70)`;
  ctx.shadowColor = '#00f2ff';
  ctx.shadowBlur = 8;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(plot.x, proj.horizonY);
  ctx.lineTo(plot.x + plot.w, proj.horizonY);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 4. Lente óptica biométrica ACOSTADA EN EL PISO EN PERSPECTIVA 3D (Detrás de las líneas de la grilla)
  drawFloorOpticalLens3D(ctx, state, proj);

  // 5. Parámetros de la grilla ensanchada
  const TARGET_COLS = 19;
  const WIDE_FACTOR = 1.45;
  const cellPx = (proj.plotW * WIDE_FACTOR) / TARGET_COLS;
  const halfCols = Math.ceil(TARGET_COLS / 2);
  const halfX = halfCols * cellPx;
  const dZ = 0.26;

  // Avance continuo en el eje Z (Z-Travel sereno y suave)
  const travelSpeed = 0.00022;
  const zOffset = (state.now * travelSpeed) % dZ;

  // 6. Filas de profundidad (Z constante) con desvanecimiento smoothstep en los extremos
  for (let z = proj.zNear + (dZ - zOffset); z <= proj.zFar + dZ; z += dZ) {
    if (z < proj.zNear || z > proj.zFar) continue;
    const a = proj.floorPoint(-halfX, z);
    const b = proj.floorPoint(halfX, z);

    // Entrada y salida suave sin saltos ópticos
    const nearFade = smoothstep(proj.zNear, proj.zNear + 0.35, z);
    const farFade = smoothstep(proj.zFar, proj.zFar - 1.1, z);
    const alpha = 0.38 * nearFade * farFade;
    if (alpha <= 0.01) continue;

    ctx.strokeStyle = `rgba(${C.horizon}, ${alpha.toFixed(3)})`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // 6. Columnas longitudinales (X constante que convergen al punto de fuga)
  for (let k = -halfCols; k <= halfCols; k++) {
    const xw = k * cellPx;
    const near = proj.floorPoint(xw, proj.zNear);
    const far = proj.floorPoint(xw, proj.zFar);
    const isCenter = k === 0;
    const isMajor = k % 3 === 0;

    const g = ctx.createLinearGradient(near.x, near.y, far.x, far.y);
    g.addColorStop(0, `rgba(${isCenter ? C.cyan : isMajor ? C.horizon : C.gridMinor}, ${isCenter ? 0.65 : isMajor ? 0.40 : 0.18})`);
    g.addColorStop(0.7, `rgba(${isCenter ? C.cyan : isMajor ? C.horizon : C.gridMinor}, 0.08)`);
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.strokeStyle = g;
    ctx.lineWidth = isCenter ? 1.4 : isMajor ? 1.0 : 0.6;
    ctx.beginPath();
    ctx.moveTo(near.x, near.y);
    ctx.lineTo(far.x, far.y);
    ctx.stroke();
  }

  // 7. Ondas de Choque Relativistas en el Piso (Dual Harmonic Floor Shockwaves en sístole)
  if (state.traceRevealed && state.sweepPulse > 0.04) {
    const shockProg = 1 - state.sweepPulse;
    const shockZ = proj.zNear + shockProg * (proj.zFar - proj.zNear) * 0.72;
    const shockRadX = (proj.plotW * 0.54) * (0.12 + 0.88 * shockProg);
    const shockCenter = proj.floorPoint(0, shockZ);
    const shockLeft = proj.floorPoint(-shockRadX, shockZ);
    const shockRight = proj.floorPoint(shockRadX, shockZ);
    const radPxX = (shockRight.x - shockLeft.x) / 2;
    const radPxY = Math.max(3, radPxX * 0.24 * shockCenter.scale);

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(shockCenter.x, shockCenter.y, radPxX, radPxY, 0, 0, Math.PI * 2);
    const shockAlpha = (1 - shockProg) * 0.55;
    ctx.strokeStyle = `rgba(0, 242, 255, ${shockAlpha.toFixed(3)})`;
    ctx.lineWidth = 2.2 * shockCenter.scale;
    ctx.shadowColor = '#00f2ff';
    ctx.shadowBlur = 12;
    ctx.stroke();

    // Anillo armónico secundario de propagación bioeléctrica
    if (shockProg > 0.15) {
      const p2 = shockProg - 0.14;
      const z2 = proj.zNear + p2 * (proj.zFar - proj.zNear) * 0.72;
      const r2X = (proj.plotW * 0.44) * (0.10 + 0.90 * p2);
      const c2 = proj.floorPoint(0, z2);
      const l2 = proj.floorPoint(-r2X, z2);
      const r2 = proj.floorPoint(r2X, z2);
      const rad2X = (r2.x - l2.x) / 2;
      const rad2Y = Math.max(2, rad2X * 0.24 * c2.scale);

      ctx.beginPath();
      ctx.ellipse(c2.x, c2.y, rad2X, rad2Y, 0, 0, Math.PI * 2);
      const a2 = (1 - p2) * 0.30;
      ctx.strokeStyle = `rgba(34, 197, 94, ${a2.toFixed(3)})`;
      ctx.lineWidth = 1.4 * c2.scale;
      ctx.shadowColor = '#22c55e';
      ctx.shadowBlur = 8;
      ctx.stroke();
    }
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
 * Dibuja la lente óptica biométrica ACOSTADA EN EL PISO EN PERSPECTIVA 3D.
 * Se ubica en el plano de suelo (h = 0) a profundidad Z_center = 2.45,
 * proyectando el video en vivo del dedo sobre el suelo en perspectiva 3D,
 * con transparencia sofisticada de zafiro, retícula táctica y anillos concéntricos en perspectiva.
 * Se renderiza DETRÁS de la grilla 3D y DETRÁS de la onda cardíaca.
 */
export function drawFloorOpticalLens3D(
  ctx: CanvasRenderingContext2D,
  state: PpgRenderState,
  proj: Projector
): void {
  const p = state.props;
  if (p.preserveResults) return;

  const isDetected = p.isFingerDetected;
  const diag = p.diagnostics;
  const progress = Math.max(0, Math.min(1, diag?.acquisitionProgress ?? 0));

  // Coordenadas en perspectiva de suelo 3D
  const centerZ = 2.45;
  const cPoint = proj.floorPoint(0, centerZ);
  const cx = cPoint.x; // Punto central X en perspectiva (vpX)
  const cy = cPoint.y; // Punto central Y en el plano de suelo

  const worldRadius = proj.plotW * 0.32;
  const rx = worldRadius * cPoint.scale; // Radio horizontal en pantalla
  const tiltRatio = 0.30; // Relación de inclinación elíptica en perspectiva de suelo
  const ry = Math.max(14, rx * tiltRatio); // Radio vertical en pantalla
  const innerRx = rx * 0.86;
  const innerRy = ry * 0.86;

  // 1. Halo acústico vascular bioluminiscente en el piso (Elipse 3D reactiva al latido y PI)
  const pi = p.perfusionIndex ?? 0;
  const piFactor = Math.min(1.0, pi * 50);
  const pulse = Math.max(state.sweepPulse, 0.04);
  const auraRx = rx * (1.20 + pulse * (0.24 + piFactor * 0.16));
  const auraRy = ry * (1.20 + pulse * (0.24 + piFactor * 0.16));
  const aura = ctx.createRadialGradient(cx, cy, 3, cx, cy, auraRx);
  if (isDetected) {
    aura.addColorStop(0, `rgba(6, 182, 212, ${0.22 + pulse * 0.25})`);
    aura.addColorStop(0.55, `rgba(34, 197, 94, ${0.10 + pulse * 0.14})`);
    aura.addColorStop(1, 'rgba(0, 0, 0, 0)');
  } else {
    aura.addColorStop(0, 'rgba(245, 158, 11, 0.18)');
    aura.addColorStop(0.55, 'rgba(245, 158, 11, 0.05)');
    aura.addColorStop(1, 'rgba(0, 0, 0, 0)');
  }
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, auraRx, auraRy, 0, 0, Math.PI * 2);
  ctx.fillStyle = aura;
  ctx.fill();
  ctx.restore();

  // 2. Video en vivo del dedo ACOSTADO EN PERSPECTIVA 3D sobre el piso
  const source = typeof p.getVideoElement === 'function' ? p.getVideoElement() : null;
  let hasValidFrame = false;
  let sw = 0;
  let sh = 0;

  if (source instanceof HTMLVideoElement) {
    if (source.videoWidth > 0 && source.videoHeight > 0) {
      hasValidFrame = true;
      sw = source.videoWidth;
      sh = source.videoHeight;
    }
  } else if (source instanceof HTMLCanvasElement) {
    if (source.width > 0 && source.height > 0) {
      hasValidFrame = true;
      sw = source.width;
      sh = source.height;
    }
  }

  ctx.save();
  // Clip elíptico en perspectiva de suelo
  ctx.beginPath();
  ctx.ellipse(cx, cy, innerRx, innerRy, 0, 0, Math.PI * 2);
  ctx.clip();

  if (hasValidFrame && source) {
    const size = Math.min(sw, sw > 0 ? sh : sw);
    const sx = (sw - size) / 2;
    const sy = (sh - size) / 2;

    // Aplica transformación afín de inclinación de perspectiva al video
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1.0, tiltRatio);
    ctx.translate(-cx, -cy);

    ctx.globalAlpha = isDetected ? 0.70 : 0.45;
    ctx.drawImage(
      source,
      sx,
      sy,
      size,
      size,
      cx - innerRx,
      cy - innerRx,
      innerRx * 2,
      innerRx * 2
    );
    ctx.restore();
    ctx.globalAlpha = 1.0;
  } else {
    ctx.fillStyle = '#030814';
    ctx.fillRect(cx - innerRx, cy - innerRy, innerRx * 2, innerRy * 2);
  }

  // Capa de cristal zafiro translúcida sobre el piso 3D
  const lensGrad = ctx.createRadialGradient(cx, cy, innerRx * 0.08, cx, cy, innerRx);
  lensGrad.addColorStop(0, 'rgba(4, 12, 24, 0.12)');
  lensGrad.addColorStop(0.60, 'rgba(2, 8, 18, 0.28)');
  lensGrad.addColorStop(0.85, 'rgba(2, 6, 14, 0.50)');
  lensGrad.addColorStop(1, 'rgba(1, 4, 10, 0.72)');
  ctx.fillStyle = lensGrad;
  ctx.fillRect(cx - innerRx, cy - innerRy, innerRx * 2, innerRy * 2);

  // Micro-scanlines en el piso en perspectiva
  ctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
  for (let ly = cy - innerRy; ly <= cy + innerRy; ly += 2.5) {
    ctx.fillRect(cx - innerRx, ly, innerRx * 2, 1);
  }

  // Reflejo especular elíptico de cristal
  ctx.beginPath();
  ctx.ellipse(cx, cy, innerRx * 0.90, innerRy * 0.90, 0, -Math.PI * 0.75, -Math.PI * 0.25);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(cx, cy, innerRx * 0.90, innerRy * 0.90, 0, Math.PI * 0.35, Math.PI * 0.65);
  ctx.strokeStyle = 'rgba(103, 232, 249, 0.18)';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // 3 Arcos espectrales periféricos de absorción óptica tisular (660nm Rojo arterial, 525nm Verde capilar, 470nm Azul)
  const specRx = innerRx * 0.94;
  const specRy = innerRy * 0.94;
  ctx.lineWidth = 1.4;
  // Arco Rojo 660nm (Arterial pulsátil) - Sector superior izquierdo
  ctx.strokeStyle = 'rgba(239, 68, 68, 0.45)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, specRx, specRy, 0, -Math.PI * 0.85, -Math.PI * 0.55);
  ctx.stroke();

  // Arco Verde 525nm (Microvascular capilar superficial) - Sector superior derecho
  ctx.strokeStyle = 'rgba(34, 197, 94, 0.45)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, specRx, specRy, 0, -Math.PI * 0.45, -Math.PI * 0.15);
  ctx.stroke();

  // Arco Azul 470nm (Absorción de referencia) - Sector inferior
  ctx.strokeStyle = 'rgba(6, 182, 212, 0.40)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, specRx, specRy, 0, Math.PI * 0.25, Math.PI * 0.75);
  ctx.stroke();

  // Retícula táctica 3D acostada (+)
  ctx.strokeStyle = isDetected ? 'rgba(0, 242, 255, 0.45)' : 'rgba(245, 158, 11, 0.50)';
  ctx.lineWidth = 0.8;
  const crossLenX = 8;
  const crossLenY = crossLenX * tiltRatio;
  ctx.beginPath();
  ctx.moveTo(cx - crossLenX, cy); ctx.lineTo(cx + crossLenX, cy);
  ctx.moveTo(cx, cy - crossLenY); ctx.lineTo(cx, cy + crossLenY);
  ctx.stroke();

  // Escáner láser 3D de grado quirúrgico que barre el piso en el eje de profundidad Z
  const scanZOffset = Math.sin(state.now * 0.0028) * (innerRy * 0.72);
  const scanBeamY = cy + scanZOffset;
  const ribbonDepth = 6 * tiltRatio;

  // Estela Gaussiana luminiscente del láser en el piso en perspectiva
  const trailGrad = ctx.createLinearGradient(0, scanBeamY - ribbonDepth, 0, scanBeamY + ribbonDepth);
  trailGrad.addColorStop(0, 'rgba(0, 242, 255, 0)');
  trailGrad.addColorStop(0.5, isDetected ? 'rgba(0, 242, 255, 0.22)' : 'rgba(245, 158, 11, 0.16)');
  trailGrad.addColorStop(1, 'rgba(0, 242, 255, 0)');
  ctx.fillStyle = trailGrad;
  ctx.fillRect(cx - innerRx * 0.76, scanBeamY - ribbonDepth, innerRx * 1.52, ribbonDepth * 2);

  // Haz láser quirúrgico principal con bloom
  ctx.strokeStyle = isDetected ? 'rgba(0, 242, 255, 0.85)' : 'rgba(245, 158, 11, 0.75)';
  ctx.shadowColor = isDetected ? '#00f2ff' : '#f59e0b';
  ctx.shadowBlur = 5;
  ctx.lineWidth = 1.0;
  ctx.beginPath();
  ctx.moveTo(cx - innerRx * 0.78, scanBeamY);
  ctx.lineTo(cx + innerRx * 0.78, scanBeamY);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Marcas axiales de calibración micrométrica sobre el haz láser móvil
  ctx.strokeStyle = isDetected ? 'rgba(255, 255, 255, 0.75)' : 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 0.8;
  const tickFractions = [-0.6, -0.3, 0, 0.3, 0.6];
  for (let k = 0; k < tickFractions.length; k++) {
    const tx = cx + innerRx * tickFractions[k];
    const th = (k === 2 ? 3.5 : 2.0) * tiltRatio;
    ctx.beginPath();
    ctx.moveTo(tx, scanBeamY - th);
    ctx.lineTo(tx, scanBeamY + th);
    ctx.stroke();
  }

  ctx.restore(); // Fin del clip elíptico 3D

  // 3. Bisel elíptico 3D concéntrico de titanio en el plano de suelo
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.20)';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.ellipse(cx, cy, innerRx + 1, innerRy + 1 * tiltRatio, 0, 0, Math.PI * 2);
  ctx.stroke();

  // Anillo exterior elíptico
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = isDetected ? 'rgba(0, 242, 255, 0.40)' : 'rgba(245, 158, 11, 0.40)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();

  // En calibración: Arco de progreso elíptico en el piso (0% - 100%)
  if (!state.traceRevealed) {
    if (isDetected) {
      const progAngle = progress * Math.PI * 2;
      ctx.strokeStyle = '#00f2ff';
      ctx.shadowColor = '#00f2ff';
      ctx.shadowBlur = 6;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, -Math.PI / 2, -Math.PI / 2 + progAngle);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  // Dial colimador de 24 divisiones con marcas de azimut cardinal en el piso
  const rot = (state.now * 0.0008) % (Math.PI * 2);
  ctx.strokeStyle = 'rgba(103, 232, 249, 0.32)';
  ctx.lineWidth = 0.8;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
    const isCardinal = a % (Math.PI / 2) === 0;
    const tickLen = isCardinal ? 5.5 : 3.0;
    const cos = Math.cos(a + rot);
    const sin = Math.sin(a + rot);
    const p1x = cx + cos * (innerRx + 2);
    const p1y = cy + sin * (innerRy + 2 * tiltRatio);
    const p2x = cx + cos * (innerRx + 2 + tickLen);
    const p2y = cy + sin * (innerRy + (2 + tickLen) * tiltRatio);
    ctx.beginPath();
    ctx.moveTo(p1x, p1y);
    ctx.lineTo(p2x, p2y);
    ctx.stroke();
  }

  // Badge clínico de guía óptica proyectado en la base del piso
  let statusText = 'POSICIONAR YEMA';
  let statusColor = '#f59e0b';
  let statusRgb = '245, 158, 11';
  if (isDetected) {
    const isSaturated = (diag?.sqm as Record<string, number> | undefined)?.saturationRatio && (diag?.sqm as Record<string, number>).saturationRatio > 0.15;
    if (isSaturated) {
      statusText = 'ISQUEMIA / SOBREPRESIÓN';
      statusColor = '#ef4444';
      statusRgb = '239, 68, 68';
    } else if (p.contactState === 'UNSTABLE_CONTACT' || (p.quality ?? 0) < 30) {
      statusText = 'CONTACTO LIGERO';
      statusColor = '#f59e0b';
      statusRgb = '245, 158, 11';
    } else {
      statusText = `PERFUSIÓN ÓPTIMA · PI ${(pi * 100).toFixed(1)}%`;
      statusColor = '#22c55e';
      statusRgb = '34, 197, 94';
    }
  }

  const badgeW = isDetected ? 122 : 94;
  const badgeH = 13;
  const badgeY = cy + ry + 4;
  ctx.fillStyle = 'rgba(6, 14, 28, 0.88)';
  ctx.beginPath();
  ctx.roundRect(cx - badgeW / 2, badgeY, badgeW, badgeH, 6);
  ctx.fill();
  ctx.strokeStyle = `rgba(${statusRgb}, 0.40)`;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx - badgeW / 2 + 7, badgeY + 6.5, 2.0, 0, Math.PI * 2);
  ctx.fillStyle = statusColor;
  if (isDetected) {
    ctx.shadowColor = statusColor;
    ctx.shadowBlur = 4;
  }
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.font = `bold 7px ${FONT}`;
  ctx.fillStyle = isDetected ? '#ffffff' : '#fde68a';
  ctx.textAlign = 'center';
  ctx.fillText(statusText, cx + 4, badgeY + 9.5);

  ctx.restore();
}

// Pools estáticos pre-asignados para erradicar el 100% de asignaciones GC por frame en 3D
const POOL_CAPACITY = 2048;
const POOL_PF_X = new Float32Array(POOL_CAPACITY);
const POOL_PF_Y = new Float32Array(POOL_CAPACITY);
const POOL_PF_SCALE = new Float32Array(POOL_CAPACITY);
const POOL_PB_X = new Float32Array(POOL_CAPACITY);
const POOL_PB_Y = new Float32Array(POOL_CAPACITY);
const POOL_PFLOOR_X = new Float32Array(POOL_CAPACITY);
const POOL_PFLOOR_Y = new Float32Array(POOL_CAPACITY);

/**
 * Dibuja la ONDA CARDÍACA 3D como cinta extruida con curvatura suave (Splines / Quadratic Curves),
 * bisel brillante, pared vertical con degradado y marcadores fiduciales con anillos en el piso.
 * IMPLEMENTACIÓN DE ALTO RENDIMIENTO: CERO ASIGNACIONES DINÁMICAS (TypedArray Pooled).
 */
export function drawWaveRibbon3D(
  ctx: CanvasRenderingContext2D,
  state: PpgRenderState,
  coords: WaveCoord[],
  geom: WaveGeom,
): void {
  const n = Math.min(coords.length, POOL_CAPACITY);
  if (n < 2 || geom.waveH <= 0) return;
  const proj = makeProjector(state);
  const { plot } = state.layout;
  const revealed = state.traceRevealed;
  const pulse = Math.max(state.sweepPulse, 0.04);

  const sFront = proj.scaleAt(WAVE_D_FRONT);
  const sBack = proj.scaleAt(WAVE_D_BACK);
  const groundYFront = proj.horizonY + proj.floorSpanY * sFront;
  const groundYBack = proj.horizonY + proj.floorSpanY * sBack;
  const intensity = clamp(state.threeD?.intensity ?? 1, 0.6, 1.4);
  const maxLift = proj.floorSpanY * MAX_LIFT_FRAC * intensity;

  for (let i = 0; i < n; i++) {
    const c = coords[i];
    const u = clamp((c.x - plot.x) / plot.w, 0, 1);
    const h = clamp((geom.waveBaseY - c.y) / geom.waveH, 0, 1);
    const xOffset = (u - 0.5) * plot.w;

    const xf = proj.vpX + xOffset * sFront;
    const yf = groundYFront - h * maxLift * sFront;
    const xb = proj.vpX + xOffset * sBack;
    const yb = groundYBack - h * maxLift * sBack;

    POOL_PF_X[i] = xf;
    POOL_PF_Y[i] = yf;
    POOL_PF_SCALE[i] = sFront;
    POOL_PB_X[i] = xb;
    POOL_PB_Y[i] = yb;
    POOL_PFLOOR_X[i] = xf;
    POOL_PFLOOR_Y[i] = groundYFront;
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const traceSmoothPath = (xArr: Float32Array, yArr: Float32Array, from = 0, to = n - 1) => {
    if (to <= from) return;
    ctx.moveTo(xArr[from], yArr[from]);
    for (let i = from; i < to; i++) {
      const xc = (xArr[i] + xArr[i + 1]) * 0.5;
      const yc = (yArr[i] + yArr[i + 1]) * 0.5;
      ctx.quadraticCurveTo(xArr[i], yArr[i], xc, yc);
    }
    ctx.lineTo(xArr[to], yArr[to]);
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
      traceSmoothPath(POOL_PFLOOR_X, POOL_PFLOOR_Y, s, e);
      ctx.strokeStyle = `rgba(${col}, ${isArr ? 0.38 : 0.16})`;
      ctx.lineWidth = isArr ? 8 : 6;
      ctx.shadowColor = `rgba(${col}, ${isArr ? 0.35 : 0.08})`;
      ctx.shadowBlur = isArr ? 12 : 4;
      ctx.stroke();
      ctx.shadowBlur = 0;
      s = e;
    }
  }

  // 2) Cara superior de la cinta (Grosor 3D) con bisel bioluminiscente
  if (revealed) {
    ctx.beginPath();
    ctx.moveTo(POOL_PF_X[0], POOL_PF_Y[0]);
    traceSmoothPath(POOL_PF_X, POOL_PF_Y, 0, n - 1);
    ctx.lineTo(POOL_PB_X[n - 1], POOL_PB_Y[n - 1]);
    for (let i = n - 2; i >= 0; i--) {
      ctx.lineTo(POOL_PB_X[i], POOL_PB_Y[i]);
    }
    ctx.closePath();
    const topGrad = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
    topGrad.addColorStop(0, `rgba(${C.signalBright}, ${0.30 + pulse * 0.20})`);
    topGrad.addColorStop(0.6, `rgba(${C.cyan}, ${0.18 + pulse * 0.12})`);
    topGrad.addColorStop(1, 'rgba(6, 182, 212, 0.05)');
    ctx.fillStyle = topGrad;
    ctx.fill();
  }

  // 3) Cara frontal vertical con degradado volumétrico y oclusión ambiental en suelo
  const wallGrad = ctx.createLinearGradient(0, proj.horizonY, 0, proj.nearY);
  wallGrad.addColorStop(0, `rgba(${C.signal}, ${revealed ? 0.44 : 0.15})`);
  wallGrad.addColorStop(0.55, `rgba(${C.signal}, ${revealed ? 0.20 : 0.05})`);
  wallGrad.addColorStop(0.92, 'rgba(6, 182, 212, 0.06)');
  wallGrad.addColorStop(1, 'rgba(0, 0, 0, 0.25)');

  ctx.beginPath();
  ctx.moveTo(POOL_PFLOOR_X[0], POOL_PFLOOR_Y[0]);
  traceSmoothPath(POOL_PF_X, POOL_PF_Y, 0, n - 1);
  ctx.lineTo(POOL_PFLOOR_X[n - 1], POOL_PFLOOR_Y[n - 1]);
  for (let i = n - 2; i >= 0; i--) {
    ctx.lineTo(POOL_PFLOOR_X[i], POOL_PFLOOR_Y[i]);
  }
  ctx.closePath();
  ctx.fillStyle = wallGrad;
  ctx.fill();

  // 3b) Cara de arritmia sobre-pintada en carmesí intenso
  let s = 0;
  while (s < n) {
    if (!coords[s].isArr) { s++; continue; }
    let e = s;
    while (e < n && coords[e].isArr) e++;
    ctx.beginPath();
    ctx.moveTo(POOL_PFLOOR_X[s], POOL_PFLOOR_Y[s]);
    traceSmoothPath(POOL_PF_X, POOL_PF_Y, s, e - 1);
    ctx.lineTo(POOL_PFLOOR_X[e - 1], POOL_PFLOOR_Y[e - 1]);
    for (let i = e - 2; i >= s; i--) ctx.lineTo(POOL_PFLOOR_X[i], POOL_PFLOOR_Y[i]);
    ctx.closePath();
    ctx.fillStyle = `rgba(${C.arr}, 0.58)`;
    ctx.fill();
    s = e;
  }

  // 4) Cresta trasera suave
  if (revealed) {
    ctx.beginPath();
    traceSmoothPath(POOL_PB_X, POOL_PB_Y, 0, n - 1);
    ctx.strokeStyle = `rgba(${C.signal}, 0.35)`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 5) Cresta frontal bioluminiscente con núcleo blanco de fósforo
  const drawCrestSeg = (from: number, to: number, arr: boolean) => {
    ctx.beginPath();
    traceSmoothPath(POOL_PF_X, POOL_PF_Y, from, to);
    if (revealed) {
      ctx.strokeStyle = arr ? `rgba(${C.arr}, 0.95)` : `rgb(${C.signalBright})`;
      ctx.shadowColor = arr ? `rgba(${C.arr}, 0.75)` : `rgba(${C.signal}, 0.75)`;
      ctx.shadowBlur = 12;
      ctx.lineWidth = 2.4;
      ctx.stroke();

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
      const px = POOL_PF_X[i];
      const py = POOL_PF_Y[i];
      const pScale = POOL_PF_SCALE[i];
      const pfgX = POOL_PFLOOR_X[i];
      const pfgY = POOL_PFLOOR_Y[i];

      // Pico sistólico (SYS)
      if (v > prev && v > next && v > prev2 && v > next2 && v > geom.midValue) {
        ctx.strokeStyle = isArr ? 'rgba(239, 68, 68, 0.45)' : 'rgba(0, 242, 255, 0.40)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(px, py + 4);
        ctx.lineTo(pfgX, pfgY);
        ctx.stroke();
        ctx.setLineDash([]);

        const impactRadX = 6 * pScale;
        const impactRadY = impactRadX * 0.35;
        ctx.beginPath();
        ctx.ellipse(pfgX, pfgY, impactRadX, impactRadY, 0, 0, Math.PI * 2);
        ctx.strokeStyle = isArr ? 'rgba(239, 68, 68, 0.65)' : 'rgba(0, 242, 255, 0.65)';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        const r = 3.2 + pScale * 1.8;
        ctx.beginPath();
        ctx.moveTo(px, py - r);
        ctx.lineTo(px + r, py);
        ctx.lineTo(px, py + r);
        ctx.lineTo(px - r, py);
        ctx.closePath();
        ctx.fillStyle = isArr ? `rgb(${C.arr})` : '#ffffff';
        ctx.shadowColor = isArr ? `rgb(${C.arr})` : `rgb(${C.cyan})`;
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.font = `bold 9px ${FONT}`;
        ctx.fillStyle = isArr ? `rgb(${C.arr})` : `rgb(${C.cyan})`;
        ctx.fillText(v.toFixed(1), px, py - 11);
        ctx.font = `bold 7px ${FONT}`;
        ctx.fillStyle = isArr ? '#fecaca' : 'rgba(255, 255, 255, 0.85)';
        ctx.fillText(isArr ? 'ARR' : 'SYS', px, py - 21);

        if (isArr) {
          ctx.beginPath();
          ctx.arc(px, py, r + 4, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${C.arr}, 0.75)`;
          ctx.lineWidth = 1.6;
          ctx.stroke();
        }
      }

      // Valle diastólico (DIA)
      if (v < prev && v < next && v < prev2 && v < next2 && v < geom.midValue) {
        ctx.beginPath();
        ctx.arc(px, py, 2.4, 0, Math.PI * 2);
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.font = `bold 9px ${FONT}`;
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(v.toFixed(1), px, py + 15);
        ctx.font = `7px ${FONT}`;
        ctx.fillText('DIA', px, py + 24);
      }

      // Onda de Reflexión / Marea (Tidal Wave - T) (Elgendi 2012)
      // Hombro o inflexión en la pendiente descendente sistólica antes de la escotadura dícrota
      const d1Curr = v - prev;
      const d1Next = next - v;
      const d2Curr = d1Next - d1Curr;
      const isTidalShoulder =
        d1Curr < -0.12 &&
        d2Curr > 0.28 &&
        v > geom.midValue + 0.12 * Math.abs(geom.midValue || 1) &&
        prev < prev2 &&
        !(v > prev && v > next);

      if (isTidalShoulder && quality > 65) {
        ctx.beginPath();
        ctx.arc(px, py, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(52, 211, 153, 0.85)';
        ctx.shadowColor = '#10b981';
        ctx.shadowBlur = 4;
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.font = `bold 7px ${FONT}`;
        ctx.fillStyle = '#6ee7b7';
        ctx.fillText('T', px, py - 7);
      }

      // Muesca dícrota (DIC)
      if (d1Curr < 0 && d1Next > d1Curr && d1Next < 0 && v > geom.midValue) {
        ctx.beginPath();
        ctx.arc(px, py, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(103, 232, 249, 0.75)';
        ctx.fill();
        if (quality > 70) {
          ctx.font = `7px ${FONT}`;
          ctx.fillStyle = 'rgba(103, 232, 249, 0.9)';
          ctx.fillText('DIC', px, py - 7);
        }
      }
    }
  }

  // 7) Cursor conductor en la cabeza de la señal 3D
  const headX = POOL_PF_X[n - 1];
  const headY = POOL_PF_Y[n - 1];
  const headScale = POOL_PF_SCALE[n - 1];
  const headArr = coords[n - 1].isArr;

  if (revealed && pulse > 0.10) {
    for (let rIdx = 1; rIdx <= 2; rIdx++) {
      const ringRad = (8 + pulse * (16 * rIdx)) * headScale;
      const ringAlpha = (1 - pulse) * (0.6 / rIdx);
      ctx.beginPath();
      ctx.arc(headX, headY, ringRad, 0, Math.PI * 2);
      ctx.strokeStyle = headArr ? `rgba(239, 68, 68, ${ringAlpha})` : `rgba(0, 242, 255, ${ringAlpha})`;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }

  ctx.beginPath();
  ctx.arc(headX, headY, (6 + pulse * 6) * (0.7 + 0.3 * headScale), 0, Math.PI * 2);
  ctx.fillStyle = revealed
    ? headArr ? `rgba(${C.arr}, 0.35)` : `rgba(${C.cyan}, 0.35)`
    : 'rgba(148, 163, 184, 0.18)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(headX, headY, 3, 0, Math.PI * 2);
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
