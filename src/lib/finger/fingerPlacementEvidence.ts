/**
 * FINGER PLACEMENT EVIDENCE — Evidencia física REAL de la colocación del dedo.
 *
 * El razonamiento de PRESIÓN TRANSMURAL vive en
 * `src/lib/pressure/transmuralPressureModel.ts` (fuente única, con la
 * literatura y el modelo continuo). Este módulo NO vuelve a clasificar presión:
 * agrega el veredicto del modelo con la evidencia de ubicación, cobertura y
 * movimiento para producir el score de colocación y la guía de UI.
 *
 * Modelo transmural (resumen):
 *  - PRESIÓN BAJA : la yema no cubre la lente, o el pulso es débil sin
 *                   evidencia de colapso.
 *  - PRESIÓN ÓPTIMA: máxima amplitud pulsátil sostenida (PI cerca del mejor
 *                   reciente) con la lente sellada.
 *  - PRESIÓN ALTA : la presión externa supera la arteriolar y colapsa el lecho
 *                   capilar. La AC cae frente al mejor reciente, el DC sube y la
 *                   varianza temporal se aplana.
 *
 * La cámara NO mide fuerza ni mmHg: solo se clasifica el estado RELATIVO del
 * lecho capilar. Ver `transmuralPressureModel.ts` para las referencias.
 */

import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import {
  createTransmuralState,
  observeTransmuralPressure,
  resetTransmuralState,
  type TransmuralAxis,
  type TransmuralGuidance,
  type TransmuralModelState,
  type TransmuralState,
} from '@/lib/pressure/transmuralPressureModel';

export type PressureVerdict = TransmuralState;
export type PlacementVerdict = 'NO_FINGER' | 'EDGE' | 'OFF_CENTER' | 'CENTERED';
export type { TransmuralAction, TransmuralGuidance } from '@/lib/pressure/transmuralPressureModel';

export interface FingerPlacementEvidence {
  score: number;
  pressure: PressureVerdict;
  /** Posición continua [0..1]: 0 suave, 0.5 óptima, 1 fuerte. Cursor del gauge. */
  pressureScore: number;
  /** Lado del óptimo según el modelo (informativo para guía/háptico). */
  pressureAxis: TransmuralAxis;
  /** Índice de blanqueo [0..1] del modelo transmural. */
  blanching: number;
  /** Sellado óptico [0..1]: fracción de lente cubierta por tejido. */
  seal: number;
  /** Pulso normalizado [0..1]. */
  pulsatility: number;
  /** Fracción de tejido perfundido [0..1]. */
  perfusedFraction: number;
  placement: PlacementVerdict;
  /** Guía ANTES `failing`. Se mantiene por compatibilidad con la UI existente. */
  failing: string[];
  /** Instrucción estructurada: acción + titular + detalle + progreso. */
  guidance: TransmuralGuidance;
  coverage: number;
  centering: number;
  stability: number;
  motion: number;
}

const W_PULSE = 0.34;
const W_COVER = 0.26;
const W_CENTER = 0.18;
const W_STABIL = 0.12;
const W_MOTION = 0.10;

const EMA_A = 0.22;

const {
  COVER_MIN,
  COVER_GOOD,
  PULSE_FLAT,
  SCORE_ALPHA,
  PI_PULSELESS,
} = VITAL_THRESHOLDS.PRESSURE;

/** Estado del modelo transmural (episodio de contacto actual). */
const model: TransmuralModelState = createTransmuralState();

/** Suavizados de colocación que no pertenecen al modelo de presión. */
const ev = {
  center: 0,
  stab: 0,
  prevCover: 0,
  score: 0.5,
  scoreVerdict: 'NONE' as PressureVerdict,
};

export function resetPlacementEvidence(): void {
  resetTransmuralState(model);
  ev.center = 0;
  ev.stab = 0;
  ev.prevCover = 0;
  ev.score = 0.5;
  ev.scoreVerdict = 'NONE';
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function norm(v: number, lo: number, hi: number): number {
  return v <= lo ? 0 : v >= hi ? 1 : (v - lo) / (hi - lo);
}

export interface EvidenceInput {
  /**
   * Sellado óptico [0..1]: fracción del área explorada cubierta por tejido del
   * dedo. NO es la máscara AC/DC (esa colapsa con el flash y hacía que el
   * modelo viera "poco dedo" con el dedo bien apoyado).
   */
  sealRatio: number;
  /** Fracción del tejido que además está perfundido [0..1]. */
  perfusedFraction?: number;
  centroidX: number;
  centroidY: number;
  motionScore: number;
  perfusionIndex: number;
  /** Nivel DC del rojo de los píxeles de tejido (misma escala 0–255). */
  dcLevel: number;
  /** CV temporal del rojo en el ROI (pulsatilidad cruda + ruido). */
  roiRedCv: number;
}

export function computePlacementEvidence(input: EvidenceInput): FingerPlacementEvidence {
  const reading = observeTransmuralPressure(model, {
    sealRatio: input.sealRatio,
    perfusedFraction: input.perfusedFraction,
    motionScore: input.motionScore,
    perfusionIndex: input.perfusionIndex,
    dcLevel: input.dcLevel,
    roiRedCv: input.roiRedCv,
  });

  const d = 1 - EMA_A;

  const dx = (input.centroidX - 0.5) * 2;
  const dy = (input.centroidY - 0.5) * 2;
  const dist = Math.min(1, Math.hypot(dx, dy) / 1.2);
  ev.center = ev.center * d + (1 - dist) * EMA_A;

  // Estabilidad: cambio de sellado frame a frame + quietud.
  const stabInst = clamp(
    1 - (Math.abs(input.sealRatio - ev.prevCover) * 2.2 + (1 - reading.motion) * 0.6),
    0,
    1,
  );
  ev.prevCover = input.sealRatio;
  ev.stab = ev.stab * d + stabInst * EMA_A;

  const pressure = reading.state;
  const coverage = reading.seal;

  // Score continuo [0..1] para el cursor del gauge. En una transición de
  // veredicto se reinicia al valor instantáneo para no arrastrar la EMA del
  // estado anterior (evita un cursor incoherente con el nuevo veredicto).
  const transitioned = ev.scoreVerdict !== pressure;
  ev.scoreVerdict = pressure;
  if (pressure === 'NONE') {
    ev.score = 0.5;
  } else if (transitioned) {
    ev.score = reading.fraction;
  } else {
    ev.score = ev.score * (1 - SCORE_ALPHA) + reading.fraction * SCORE_ALPHA;
  }

  let placement: PlacementVerdict;
  if (model.frame < 12 || coverage < COVER_MIN) placement = 'NO_FINGER';
  else if (ev.center >= 0.72) placement = 'CENTERED';
  else if (ev.center >= 0.45) placement = 'OFF_CENTER';
  else placement = 'EDGE';

  const score = clamp(
    W_PULSE * reading.pulsatility +
    W_COVER * norm(coverage, COVER_MIN, COVER_GOOD) +
    W_CENTER * ev.center +
    W_STABIL * ev.stab +
    W_MOTION * reading.motion,
    0,
    1,
  );

  const failing: string[] = [];
  if (pressure === 'HEAVY') {
    failing.push(
      ev.score > 0.80
        ? 'Presión excesiva: suelta más'
        : 'Presión excesiva: suelta un poco el dedo',
    );
  } else if (pressure === 'LIGHT') {
    failing.push(
      coverage < COVER_GOOD
        ? 'Presión baja: cubre la lente con la yema'
        : ev.score < 0.25
          ? 'Presiona más: la señal es débil'
          : 'Presiona un poco más: la señal es débil',
    );
  } else if (pressure === 'NONE' && coverage >= COVER_MIN && reading.pulsatility < PULSE_FLAT) {
    failing.push('Presión no evaluable: recoloca el dedo');
  }
  if (reading.pulsatility < 0.25 && pressure !== 'HEAVY' && coverage >= COVER_MIN) {
    failing.push('Sin pulso detectable: mantén presión suave y constante');
  }
  if (reading.pulsatility < 0.25 && pressure === 'HEAVY' && coverage >= COVER_MIN) {
    // La confirmación de colapso manda sobre el mensaje genérico.
    failing.push('Sin pulso útil: el lecho capilar está colapsado');
  }
  if (coverage < 0.45 && pressure !== 'LIGHT') failing.push('Cubre más la lente con la yema');
  if (ev.center < 0.6) failing.push('Centra la yema en la lente');
  if (reading.motion < 0.55) failing.push('Sostén el dedo quieto');

  const guidance = reading.guidance;
  // Mensajes redundantes fuera del titular: el banner ya dice la acción.
  if (guidance.action === 'REPOSITION' && !failing.includes(guidance.headline)) {
    failing.unshift(guidance.headline);
  }
  if (guidance.action === 'PRESS_MORE' && reading.pulsatility < PI_PULSELESS && coverage >= COVER_MIN) {
    failing.push('Sin pulso útil: el lecho capilar necesita más apoyo');
  }

  return {
    score,
    pressure,
    pressureScore: ev.score,
    pressureAxis: reading.axis,
    blanching: reading.blanching,
    seal: reading.seal,
    pulsatility: reading.pulsatility,
    perfusedFraction: input.perfusedFraction ?? 0,
    placement,
    failing,
    guidance,
    coverage,
    centering: ev.center,
    stability: ev.stab,
    motion: reading.motion,
  };
}