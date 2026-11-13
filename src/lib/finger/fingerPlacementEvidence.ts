/**
 * FINGER PLACEMENT EVIDENCE — Evidencia fisica REAL de la colocacion del dedo.
 *
 * Fusiona metricas ya medidas por el pipeline (cero simulacion):
 *  - PRESION      : cobertura alta + PI colapsado = tejido aplastado (HEAVY);
 *                   cobertura baja = apoyo ligero (LIGHT).
 *  - UBICACION    : centroide del dedo dentro del ROI (medido por frame).
 *  - COBERTURA    : tiles "dedo" / total del ROI (medido por frame).
 *  - MOVIMIENTO   : micro-movimiento optico + IMU (fusionados aguas arriba).
 *  - PULSABILIDAD : PI real (AC/DC) — la firma fisiologica del contacto.
 *  - ESTABILIDAD  : EMA de consistencia frame a frame.
 *
 * Consumidor: la ventana 3D del pozo (tamano/color/guia) y la UI.
 */

export type PressureVerdict = 'NONE' | 'LIGHT' | 'IDEAL' | 'HEAVY';
export type PlacementVerdict = 'NO_FINGER' | 'EDGE' | 'OFF_CENTER' | 'CENTERED';

export interface FingerPlacementEvidence {
  score: number;
  pressure: PressureVerdict;
  placement: PlacementVerdict;
  failing: string[];
  coverage: number;
  centering: number;
  stability: number;
  pulsatility: number;
  motion: number;
}

const W_PULSE = 0.34;
const W_COVER = 0.26;
const W_CENTER = 0.18;
const W_STABIL = 0.12;
const W_MOTION = 0.10;

const PI_REF = 0.004;
const PI_FLOOR = 0.0009;
const COV_GOOD = 0.62;
const COV_MIN = 0.12;
const MOTION_BAD = 0.45;
const EMA_A = 0.22;

const ev = {
  cover: 0, center: 0, stab: 0, motion: 0, pulse: 0, frame: 0,
};

export function resetPlacementEvidence(): void {
  ev.cover = 0; ev.center = 0; ev.stab = 0; ev.motion = 0; ev.pulse = 0; ev.frame = 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function norm(v: number, lo: number, hi: number): number {
  return v <= lo ? 0 : v >= hi ? 1 : (v - lo) / (hi - lo);
}

export interface EvidenceInput {
  coverageRatio: number;
  centroidX: number;
  centroidY: number;
  centroidMotion: number;
  motionScore: number;
  perfusionIndex: number;
  frameCount: number;
}

export function computePlacementEvidence(input: EvidenceInput): FingerPlacementEvidence {
  ev.frame++;
  const d = 1 - EMA_A;

  ev.cover = ev.cover * d + input.coverageRatio * EMA_A;

  const dx = (input.centroidX - 0.5) * 2;
  const dy = (input.centroidY - 0.5) * 2;
  const dist = Math.min(1, Math.hypot(dx, dy) / 1.2);
  ev.center = ev.center * d + (1 - dist) * EMA_A;

  const motionInst = 1 - clamp(input.motionScore / MOTION_BAD, 0, 1);
  ev.motion = ev.motion * d + motionInst * EMA_A;

  const pulseInst = norm(input.perfusionIndex, PI_FLOOR, PI_REF);
  ev.pulse = ev.pulse * d + pulseInst * EMA_A;

  const stabInst = clamp(
    1 - (Math.abs(input.coverageRatio - ev.cover) * 2.2 + (1 - motionInst) * 0.6),
    0, 1,
  );
  ev.stab = ev.stab * d + stabInst * EMA_A;

  let pressure: PressureVerdict;
  if (ev.frame < 12 || ev.cover < COV_MIN) pressure = 'NONE';
  else if (ev.cover >= 0.85 && ev.pulse < 0.15 && input.frameCount > 60) pressure = 'HEAVY';
  else if (ev.cover >= COV_GOOD * 0.8 && ev.pulse >= 0.30) pressure = 'IDEAL';
  else if (ev.cover < COV_GOOD * 0.8) pressure = 'LIGHT';
  else pressure = 'IDEAL';

  let placement: PlacementVerdict;
  if (ev.frame < 12 || ev.cover < COV_MIN) placement = 'NO_FINGER';
  else if (ev.center >= 0.72) placement = 'CENTERED';
  else if (ev.center >= 0.45) placement = 'OFF_CENTER';
  else placement = 'EDGE';

  const coverage = norm(ev.cover, COV_MIN, COV_GOOD);
  const score = clamp(
    W_PULSE * ev.pulse +
    W_COVER * coverage +
    W_CENTER * ev.center +
    W_STABIL * ev.stab +
    W_MOTION * ev.motion,
    0, 1,
  );

  const failing: string[] = [];
  if (ev.pulse < 0.25) failing.push('Sin pulso detectable - apoya con presion suave y constante');
  if (coverage < 0.45) failing.push('Cubre mas la lente con la yema');
  if (ev.center < 0.6) failing.push('Centra la yema en la lente');
  if (pressure === 'HEAVY') failing.push('Presion demasiado fuerte - aligera un poco');
  if (ev.motion < 0.55) failing.push('Sosten el dedo quieto');

  return {
    score,
    pressure,
    placement,
    failing,
    coverage,
    centering: ev.center,
    stability: ev.stab,
    pulsatility: ev.pulse,
    motion: ev.motion,
  };
}
