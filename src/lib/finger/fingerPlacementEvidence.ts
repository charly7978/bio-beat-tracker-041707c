/**
 * FINGER PLACEMENT EVIDENCE — Evidencia física REAL de la colocación del dedo.
 *
 * MODELO ÚNICO DE PRESIÓN (presión transmural / microvascular blanching):
 *  - PRESIÓN BAJA : fuga de luz y SNR bajo (cobertura insuficiente) o pulso
 *                   débil sin colapso relativo frente al mejor reciente.
 *  - PRESIÓN ÓPTIMA: máxima amplitud pulsátil sostenida (PI cerca del mejor
 *                   reciente) con cobertura buena de la lente.
 *  - PRESIÓN ALTA : la presión externa supera la arteriolar y colapsa el lecho
 *                   capilar. La AC cae frente al mejor reciente (medido en PI RAW,
 *                   no normalizado, para no saturar a PI ≥ PI_REF), el DC sube o
 *                   se estanca alto y la varianza temporal se aplana.
 *
 * La cámara NO mide fuerza ni mmHg: solo se clasifica el estado RELATIVO del
 * lecho capilar con señales ya medidas por el pipeline. La literatura muestra
 * que el DC sube con la fuerza de contacto y que AC/AC-DC alcanzan un máximo y
 * después caen al seguir apretando (Teng & Zhang, Physiol. Meas. 25(5) 2004;
 * Sensors 2020/2024; revisiones 2023 sobre presión transmural).
 *
 * Fusiona métricas ya medidas (cero cómputo de señal nuevo):
 *  - UBICACIÓN    : centroide del dedo dentro del ROI.
 *  - COBERTURA    : tiles "dedo" / total del ROI.
 *  - MOVIMIENTO   : micro-movimiento óptico + IMU (fusionados aguas arriba).
 *  - PULSABILIDAD : PI real (AC/DC) en RAW y normalizado contra el mejor reciente.
 *  - DC           : nivel y tendencia lenta (proxy de fuerza de contacto).
 *  - VARIANZA     : CV temporal del rojo (pulsatilidad cruda + ruido).
 *
 * Consumidores: gauge de presión, guía 3D y hápticos de presión (vía router).
 */

import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

export type PressureVerdict = 'NONE' | 'LIGHT' | 'IDEAL' | 'HEAVY';
export type PlacementVerdict = 'NO_FINGER' | 'EDGE' | 'OFF_CENTER' | 'CENTERED';

export interface FingerPlacementEvidence {
  score: number;
  pressure: PressureVerdict;
  /** Posición continua [0..1]: 0 suave, 0.5 óptima, 1 fuerte. Cursor del gauge. */
  pressureScore: number;
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

const MOTION_BAD = 0.45;
const EMA_A = 0.22;

const {
  COVER_MIN,
  COVER_GOOD,
  COVER_SEALED,
  PI_REF,
  AC_PEAK_MIN_PI,
  AC_COLLAPSE_CLEAR,
  AC_COLLAPSE_RECOVER,
  PULSE_FLAT,
  PULSE_OK,
  CV_FLAT_REF,
  FLAT_HEAVY,
  DC_RISE_MIN,
  DC_HIGH_MIN,
  DC_RISE_FULL,
  HEAVY_WARMUP_FRAMES,
  HEAVY_ENTER_FRAMES,
  VERDICT_CONFIRM_FRAMES,
  PEAK_DECAY,
  DC_SLOW_ALPHA,
  SCORE_ALPHA,
} = VITAL_THRESHOLDS.PRESSURE;
const PI_FLOOR = VITAL_THRESHOLDS.QUALITY.MIN_PI;

/**
 * Estado del episodio de contacto actual. Se reinicia al perder contacto
 * (`resetPlacementEvidence`), de modo que el "mejor PI reciente" y la tendencia
 * de DC nunca sobreviven a un dedo distinto o a una recolocación.
 */
const ev = {
  cover: 0,
  center: 0,
  stab: 0,
  motion: 0,
  pulse: 0,       // PI normalizado (display)
  pulseRaw: 0,    // PI RAW (AC/DC) para colapso sin saturación
  frame: 0,
  dc: 0,
  dcSlow: 0,
  dcMin: 0,
  cv: 0,
  peak: 0,        // mejor PI normalizado reciente
  peakRaw: 0,     // mejor PI RAW reciente (congelado en HEAVY)
  score: 0.5,
  verdict: 'NONE' as PressureVerdict,
  candidateRun: 0,
};

export function resetPlacementEvidence(): void {
  ev.cover = 0;
  ev.center = 0;
  ev.stab = 0;
  ev.motion = 0;
  ev.pulse = 0;
  ev.pulseRaw = 0;
  ev.frame = 0;
  ev.dc = 0;
  ev.dcSlow = 0;
  ev.dcMin = 0;
  ev.cv = 0;
  ev.peak = 0;
  ev.peakRaw = 0;
  ev.score = 0.5;
  ev.verdict = 'NONE';
  ev.candidateRun = 0;
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
  motionScore: number;
  perfusionIndex: number;
  /** Nivel DC del rojo (misma escala 0–255 del sensor). */
  dcLevel: number;
  /** CV temporal del rojo en el ROI (pulsatilidad cruda + ruido). */
  roiRedCv: number;
}

function settlePressure(candidate: PressureVerdict): PressureVerdict {
  if (candidate === ev.verdict) {
    ev.candidateRun = 0;
    return ev.verdict;
  }
  if (candidate === 'NONE') {
    ev.verdict = 'NONE';
    ev.candidateRun = 0;
    return ev.verdict;
  }
  ev.candidateRun++;
  const needed = candidate === 'HEAVY' ? HEAVY_ENTER_FRAMES : VERDICT_CONFIRM_FRAMES;
  if (ev.candidateRun >= needed) {
    ev.verdict = candidate;
    ev.candidateRun = 0;
  }
  return ev.verdict;
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

  const rawInst = Math.max(0, input.perfusionIndex);
  const pulseInst = norm(rawInst, PI_FLOOR, PI_REF);
  ev.pulse = ev.pulse * d + pulseInst * EMA_A;
  ev.pulseRaw = ev.pulseRaw * d + rawInst * EMA_A;

  // DC y CV: nivel actual + tendencia lenta.
  const dc = Math.max(0, input.dcLevel);
  const cv = Math.max(0, input.roiRedCv);
  if (ev.frame === 1) {
    ev.dc = dc;
    ev.dcSlow = dc;
    ev.dcMin = dc;
    ev.cv = cv;
  } else {
    ev.dc = ev.dc * (1 - EMA_A) + dc * EMA_A;
    ev.dcSlow = ev.dcSlow * (1 - DC_SLOW_ALPHA) + dc * DC_SLOW_ALPHA;
    if (dc < ev.dcMin || ev.dcMin === 0) ev.dcMin = dc;
    ev.cv = ev.cv * d + cv * EMA_A;
  }

  // Movimiento alto: congelar el pico (no inflar con artefacto) y mantener
  // veredicto actual para no oscilar por un frame ruidoso.
  const motionBad = ev.motion < 0.4 || input.motionScore > MOTION_BAD;

  // Mejor PI reciente (RAW): se congela mientras el veredicto es HEAVY para
  // que la presión sostenida no se "olvide" y cause HEAVY→LIGHT falso.
  const prevVerdict = ev.verdict;
  if (prevVerdict !== 'HEAVY' && !motionBad) {
    ev.peak = Math.max(ev.peak * PEAK_DECAY, ev.pulse);
    ev.peakRaw = Math.max(ev.peakRaw * PEAK_DECAY, ev.pulseRaw);
  }
  const hasPeak = ev.peakRaw >= AC_PEAK_MIN_PI;
  const acCollapse = hasPeak
    ? clamp(1 - ev.pulseRaw / ev.peakRaw, 0, 1)
    : 0;

  // Firma de contacto fuerte: DC por encima de su tendencia lenta.
  const dcRise = ev.dcSlow > 4
    ? clamp(((ev.dc - ev.dcSlow) / ev.dcSlow) / DC_RISE_FULL, 0, 1)
    : 0;
  // DC por encima del minimo del episodio: presion sostenida (DC alto y estable).
  const dcHigh = ev.dcMin > 0
    ? (ev.dc - ev.dcMin) / Math.max(ev.dcMin, 1) >= DC_HIGH_MIN
    : false;

  // Planitud: 1 = CV en cero (sin pulsación), 0 = CV en el piso de pulsatilidad.
  const flat = 1 - clamp(ev.cv / CV_FLAT_REF, 0, 1);
  const sealed = ev.cover >= COVER_SEALED;
  // Sellado fuerte exige evidencia positiva (DC rise) para no declarar HEAVY
  // por mera baja perfusión (falso positivo).
  const sealedFlat = sealed &&
    ev.pulse <= PULSE_FLAT &&
    flat >= FLAT_HEAVY &&
    dcRise >= DC_RISE_MIN;
  const settled = ev.frame >= HEAVY_WARMUP_FRAMES;

  const stabInst = clamp(
    1 - (Math.abs(input.coverageRatio - ev.cover) * 2.2 + (1 - motionInst) * 0.6),
    0, 1,
  );
  ev.stab = ev.stab * d + stabInst * EMA_A;

  let candidate: PressureVerdict;
  if (ev.frame < 12 || ev.cover < COVER_MIN) {
    candidate = 'NONE';
  } else if (motionBad) {
    candidate = prevVerdict === 'NONE' ? 'NONE' : prevVerdict;
  } else if (
    settled && (
      (hasPeak && acCollapse >= AC_COLLAPSE_CLEAR && ev.cover >= COVER_GOOD) ||
      (dcHigh && ev.pulse <= PULSE_FLAT && flat >= FLAT_HEAVY && ev.cover >= COVER_GOOD) ||
      sealedFlat
    )
  ) {
    candidate = 'HEAVY';
  } else if (prevVerdict === 'HEAVY') {
    // Salida de HEAVY solo con recuperación real del pulso; nunca LIGHT directo.
    if ((hasPeak && acCollapse < AC_COLLAPSE_RECOVER && ev.pulse >= PULSE_OK * 0.7) || (!dcHigh && ev.pulse >= PULSE_OK)) {
      candidate = 'IDEAL';
    } else if (ev.cover < COVER_MIN) {
      candidate = 'NONE';
    } else {
      candidate = 'HEAVY';
    }
  } else if (ev.cover >= COVER_GOOD && ev.pulse < PULSE_FLAT && !hasPeak) {
    // Sin perfusión evaluable y sin pico de referencia: no se puede distinguir
    // presión excesiva de baja perfusión → neutro (no inventar "aprieta más").
    candidate = 'NONE';
  } else if (ev.cover < COVER_GOOD) {
    candidate = 'LIGHT';
  } else if (ev.pulse < PULSE_OK && acCollapse < AC_COLLAPSE_CLEAR) {
    candidate = 'LIGHT';
  } else {
    candidate = 'IDEAL';
  }
  const pressure = settlePressure(candidate);

  // Score continuo [0..1] para el cursor del gauge.
  const sealedFactor = norm(ev.cover, COVER_GOOD, COVER_SEALED);
  let heavyScore = sealedFactor * (
    0.60 * (hasPeak ? acCollapse : 0) +
    0.25 * flat +
    0.15 * dcRise
  );
  if (sealedFlat) heavyScore = Math.max(heavyScore, 0.70);
  const underCover = 1 - norm(ev.cover, COVER_MIN, COVER_GOOD);
  const weakPulse = (!sealedFlat && acCollapse < AC_COLLAPSE_CLEAR)
    ? 1 - norm(ev.pulse, PULSE_FLAT, PULSE_OK)
    : 0;
  const lightScore = Math.max(underCover, weakPulse);
  const scoreInstant = clamp(0.5 + 0.5 * (heavyScore - lightScore), 0, 1);
  // Sin evidencia suficiente el cursor queda neutro.
  ev.score = pressure === 'NONE'
    ? 0.5
    : ev.score * (1 - SCORE_ALPHA) + scoreInstant * SCORE_ALPHA;

  let placement: PlacementVerdict;
  if (ev.frame < 12 || ev.cover < COVER_MIN) placement = 'NO_FINGER';
  else if (ev.center >= 0.72) placement = 'CENTERED';
  else if (ev.center >= 0.45) placement = 'OFF_CENTER';
  else placement = 'EDGE';

  const coverage = norm(ev.cover, COVER_MIN, COVER_GOOD);
  const score = clamp(
    W_PULSE * ev.pulse +
    W_COVER * coverage +
    W_CENTER * ev.center +
    W_STABIL * ev.stab +
    W_MOTION * ev.motion,
    0, 1,
  );

  const failing: string[] = [];
  if (pressure === 'HEAVY') {
    failing.push('Presión excesiva: suelta un poco el dedo');
  } else if (pressure === 'LIGHT') {
    failing.push(
      ev.cover < COVER_GOOD
        ? 'Presión baja: cubre la lente con la yema'
        : 'Presiona un poco más: la señal es débil',
    );
  } else if (pressure === 'NONE' && ev.cover >= COVER_MIN && ev.pulse < PULSE_FLAT) {
    failing.push('Presión no evaluable: recoloca el dedo');
  }
  if (ev.pulse < 0.25 && pressure !== 'HEAVY' && ev.cover >= COVER_MIN) {
    failing.push('Sin pulso detectable: mantén presión suave y constante');
  }
  if (coverage < 0.45 && pressure !== 'LIGHT') failing.push('Cubre más la lente con la yema');
  if (ev.center < 0.6) failing.push('Centra la yema en la lente');
  if (ev.motion < 0.55) failing.push('Sostén el dedo quieto');

  return {
    score,
    pressure,
    pressureScore: ev.score,
    placement,
    failing,
    coverage,
    centering: ev.center,
    stability: ev.stab,
    pulsatility: ev.pulse,
    motion: ev.motion,
  };
}
