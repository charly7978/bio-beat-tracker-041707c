/**
 * MODELO FISIOLÓGICO DE PRESIÓN TRANSMURAL (microvascular blanching).
 *
 * Este módulo es la ÚNICA implementación del razonamiento de presión. Es puro
 * (sin React, sin DOM, sin temporizadores) para poder verificarse en tests y
 * ejecutarse dentro del Worker de señal.
 *
 * ── Fisiología ──────────────────────────────────────────────────────────────
 * La presión transmural de un vaso es Pt = Pa − Pe (presión arterial interna
 * menos presión externa). La pulsación óptica es máxima cuando Pt ≈ 0, es decir
 * cuando la presión externa se acerca a la presión arterial media del lecho
 * superficial; si Pe supera la presión diastólica/arteriolar, los capilares se
 * colapsan (blanching) y la AC cae aunque el dedo siga apoyado.
 *
 * La cámara no mide fuerza ni mmHg. El modelo estima el LADO del óptimo en el
 * que está el dedo usando dos observables ya medidos por el pipeline:
 *  - DC rojo: crece de forma monótona con la fuerza de contacto.
 *  - PI (AC/DC): crece hasta un máximo y luego cae.
 * Ambas observaciones están publicadas y son el eje del modelo:
 *
 *  1. Teng & Zhang, Physiol. Meas. 25(5):1323–1335 (2004) — 15 sujetos,
 *     0.2–1.8 N: DC ↑ monótono; AC y AC/DC ↑ hasta un máximo (0.2–1.0 N; la
 *     mayoría en 0.2–0.4 N) y después ↓. DOI 10.1088/0967-3334/25/5/020.
 *  2. May, Mejía-Mejía et al., Sensors 21(24):8421 (2021) — phantom tejido-vaso:
 *     óptimo de SNR entre 35.1 y 48.1 mmHg; por encima cae la amplitud.
 *     DOI 10.3390/s21248421 · PMID 34960512.
 *  3. Biomed. Eng. Lett. 44 (2024) — 20–30 mmHg (leve) hasta la DBP da los
 *     mejores índices; por encima de la MAP aparece sobrenormalización.
 *     DOI 10.1016/j.bea.2024.100123.
 *  4. Sensors 24(9):2692 (2024) — el DC correlaciona con la fuerza de contacto
 *     y hay histéresis entre carga y descarga. DOI 10.3390/s24092692.
 *  5. IEEE TIM 62 (2023), tonometría MW-PPG — Pt = Pa − Pe y colapso
 *     progresivo de capilares/arteriolas superficiales al subir Pe.
 *     DOI 10.1109/TIM.2023.3293873.
 *  6. Appl. Sci. 14(13):5704 (2024) — SQI óptimo con fuerza normalizada
 *     0.2–0.4; 0.4–0.6 captura morfología más compleja. DOI 10.3390/app14135704.
 *
 * ── Salida ──────────────────────────────────────────────────────────────────
 * `fraction` es el GRADO CONTINUO de presión [0..1]: 0 = apoyo muy leve,
 * 0.5 = óptimo (Pt ≈ 0), 1 = presión excesiva con colapso. No es una presión
 * absoluta: es un índice relativo del estado del lecho capilar.
 *
 * `state` añade histéresis (entrar/salir de HEAVY exige evidencia sostenida)
 * y `reason` explica el veredicto para que la guía visual y el háptico sean
 * coherentes con la evidencia.
 */

import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

const P = VITAL_THRESHOLDS.PRESSURE;

const MOTION_BAD = 0.45;
const MOTION_GOOD_MIN = 0.40;

export type TransmuralState = 'NONE' | 'LIGHT' | 'IDEAL' | 'HEAVY';
export type TransmuralAxis = 'UNKNOWN' | 'UNDER' | 'OPTIMAL' | 'OVER';
export type TransmuralReason =
  | 'WARMUP'
  | 'NO_CONTACT'
  | 'MOTION'
  | 'LOW_COUPLING'
  | 'NO_REFERENCE'
  | 'UNDER'
  | 'OPTIMAL'
  | 'OVER';

export interface TransmuralSample {
  /** Cobertura del ROI por la yema [0..1]. */
  coverageRatio: number;
  /** Score de movimiento [0..1] (0 = quieto). */
  motionScore: number;
  /** PI crudo AC/DC medido por el pipeline. */
  perfusionIndex: number;
  /** Nivel DC del rojo (misma escala 0–255 del sensor). */
  dcLevel: number;
  /** CV temporal del rojo en el ROI. */
  roiRedCv: number;
}

export interface TransmuralReading {
  /** Veredicto con histéresis. */
  state: TransmuralState;
  /** Lado del óptimo estimado (informativo; el veredicto manda). */
  axis: TransmuralAxis;
  /** Grado continuo [0..1]: 0.5 = óptimo. */
  fraction: number;
  /** Confianza [0..1] de la estimación (cobertura + pulso + quietud). */
  confidence: number;
  /** Índice de blanqueo [0..1] (AC colapsada + DC + planitud). */
  blanching: number;
  /** Proxy de fuerza de contacto [0..1] derivado del DC. */
  forceProxy: number;
  /** PI actual / mejor PI del episodio [0..1]. */
  perfusionRatio: number;
  /** Acoplamiento óptico [0..1] (cobertura vs. sellado). */
  coupling: number;
  /** Cobertura EMA del episodio (para el score de colocación). */
  coverage: number;
  /** Pulso normalizado contra PI_REF [0..1]. */
  pulsatility: number;
  /** Quietud EMA [0..1] (1 = dedo quieto). */
  motion: number;
  /** Tendencia del DC [-1..1] (>0 = apretando). */
  dcTrend: number;
  /** Existe un PI de referencia válido para comparar. */
  hasReference: boolean;
  /** Motivo del veredicto (para guía visual/háptica). */
  reason: TransmuralReason;
}

export interface TransmuralModelState {
  frame: number;
  cover: number;
  dcFast: number;
  dcSlow: number;
  dcMin: number;
  /** DC lento en el instante del mejor PI del episodio. */
  dcAtPeak: number;
  cv: number;
  piFast: number;
  /** Mejor PI del episodio (referencia de Pt ≈ 0). */
  piPeak: number;
  motion: number;
  /** Último grado válido; se mantiene durante movimiento para no inventar. */
  lastFraction: number;
  /** El episodio ya fijó su PI/DC de referencia (primer frame hábil). */
  peakLearned: boolean;
  state: TransmuralState;
  candidate: TransmuralState;
  candidateRun: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function createTransmuralState(): TransmuralModelState {
  return {
    frame: 0,
    cover: 0,
    dcFast: 0,
    dcSlow: 0,
    dcMin: 0,
    dcAtPeak: 0,
    cv: 0,
    piFast: 0,
    piPeak: 0,
    motion: 0,
    lastFraction: 0.5,
    peakLearned: false,
    state: 'NONE',
    candidate: 'NONE',
    candidateRun: 0,
  };
}

/** Reinicia el episodio sin cambiar la identidad del objeto (útil en refs). */
export function resetTransmuralState(state: TransmuralModelState): void {
  state.frame = 0;
  state.cover = 0;
  state.dcFast = 0;
  state.dcSlow = 0;
  state.dcMin = 0;
  state.dcAtPeak = 0;
  state.cv = 0;
  state.piFast = 0;
  state.piPeak = 0;
  state.motion = 0;
  state.lastFraction = 0.5;
  state.peakLearned = false;
  state.state = 'NONE';
  state.candidate = 'NONE';
  state.candidateRun = 0;
}

function settle(state: TransmuralModelState, candidate: TransmuralState): void {
  if (candidate === state.state) {
    state.candidateRun = 0;
    return;
  }
  if (candidate === 'NONE') {
    state.state = 'NONE';
    state.candidateRun = 0;
    return;
  }
  state.candidate = candidate;
  state.candidateRun += 1;
  const needed = candidate === 'HEAVY' ? P.HEAVY_ENTER_FRAMES : P.VERDICT_CONFIRM_FRAMES;
  if (state.candidateRun >= needed) {
    state.state = candidate;
    state.candidateRun = 0;
  }
}

/**
 * Observa un frame y devuelve la lectura fisiológica actualizada.
 * Muta `state` (es el estado del episodio) y no devuelve objetos nuevos por
 * frame más allá de la lectura.
 */
export function observeTransmuralPressure(
  state: TransmuralModelState,
  sample: TransmuralSample,
): TransmuralReading {
  state.frame += 1;

  const dc = Math.max(0, sample.dcLevel);
  const cv = Math.max(0, sample.roiRedCv);
  const pi = Math.max(0, sample.perfusionIndex);
  const cover = clamp(sample.coverageRatio, 0, 1);
  const motionScore = clamp(sample.motionScore, 0, 1);

  if (state.frame === 1) {
    state.cover = cover;
    state.dcFast = dc;
    state.dcSlow = dc;
    state.dcMin = dc;
    state.dcAtPeak = dc;
    state.cv = cv;
    state.piFast = pi;
    state.piPeak = pi;
    state.motion = 1 - clamp(motionScore / MOTION_BAD, 0, 1);
  } else {
    const aFast = P.EMA_FAST;
    const aSlow = P.EMA_SLOW;
    state.cover += (cover - state.cover) * aFast;
    state.dcFast += (dc - state.dcFast) * aFast;
    state.dcSlow += (dc - state.dcSlow) * aSlow;
    state.cv += (cv - state.cv) * aFast;
    state.piFast += (pi - state.piFast) * aFast;
    const motionInst = 1 - clamp(motionScore / MOTION_BAD, 0, 1);
    state.motion += (motionInst - state.motion) * aFast;
    if (dc < state.dcMin || state.dcMin === 0) state.dcMin = dc;
  }

  const motionBad = state.motion < MOTION_GOOD_MIN || motionScore > MOTION_BAD;

  // El mejor PI del episodio define el punto de Pt ≈ 0. Se congela en HEAVY y
  // con movimiento para no aprender un máximo espurio ni olvidar el colapso.
  if (
    state.state !== 'HEAVY' &&
    !motionBad &&
    state.frame >= P.MIN_EVIDENCE_FRAMES &&
    (!state.peakLearned || state.piFast > state.piPeak * (1 + P.PI_PEAK_MARGIN))
  ) {
    state.piPeak = Math.max(state.piPeak, state.piFast);
    state.dcAtPeak = state.dcSlow;
    state.peakLearned = true;
  }

  const hasReference = state.piPeak >= P.AC_PEAK_MIN_PI;
  const coupling = clamp(state.cover / P.COVER_GOOD, 0, 1);
  const perfusionRatio = hasReference ? clamp(state.piFast / state.piPeak, 0, 1) : 0;
  const piDeficit = hasReference ? 1 - perfusionRatio : 0;

  // DC: eje monótono de fuerza. El recorrido dinámico normaliza el episodio.
  // Sin un DC mínimo válido (dedo fuera, sensor en negro) no hay baseline de
  // fuerza: se reporta 0 en lugar de amplificar ruido.
  const dcBaselineValid = state.dcMin >= P.DC_MIN_BASELINE;
  const dcSpan = Math.max(state.dcMin * P.DC_DYNAMIC_SPAN, P.DC_MIN_SPAN);
  const forceProxy = dcBaselineValid
    ? clamp((state.dcFast - state.dcMin) / dcSpan, 0, 1)
    : 0;
  const dcDelta = hasReference && dcBaselineValid
    ? (state.dcFast - state.dcAtPeak) / Math.max(state.dcAtPeak, P.DC_REF_FLOOR)
    : 0;
  const dcRise = dcBaselineValid
    ? clamp(
      ((state.dcFast - state.dcSlow) / Math.max(state.dcSlow, 1)) / P.DC_RISE_FULL,
      0,
      1,
    )
    : 0;
  const dcHigh = dcBaselineValid &&
    (state.dcFast - state.dcMin) / Math.max(state.dcMin, 1) >= P.DC_HIGH_MIN;
  const dcTrend = dcBaselineValid
    ? clamp(
      ((state.dcFast - state.dcSlow) / Math.max(state.dcSlow, 1)) / P.DC_RISE_FULL,
      -1,
      1,
    )
    : 0;

  // Planitud del CV: 1 = sin pulsación, 0 = CV en el piso fisiológico.
  const flat = 1 - clamp(state.cv / P.CV_FLAT_REF, 0, 1);

  // El blanqueo solo es evaluable con la lente cubierta: con fuga de luz la AC
  // baja por falta de acoplamiento, no por isquemia.
  const couplingFactor = clamp(
    (state.cover - P.COVER_MIN) / Math.max(P.COVER_GOOD - P.COVER_MIN, 0.01),
    0,
    1,
  );
  const blanching = clamp(
    couplingFactor * (
      P.BLANCH_AC_WEIGHT * piDeficit +
      P.BLANCH_FLAT_WEIGHT * flat +
      P.BLANCH_DC_WEIGHT * Math.max(dcRise, dcHigh ? 1 : 0)
    ),
    0,
    1,
  );

  let candidate: TransmuralState;
  if (state.frame < P.MIN_EVIDENCE_FRAMES || state.cover < P.COVER_MIN) {
    candidate = 'NONE';
  } else if (motionBad) {
    candidate = state.state === 'NONE' ? 'NONE' : state.state;
  } else if (state.state === 'HEAVY') {
    // Salida de HEAVY solo con recuperación real del pulso y del blanqueo.
    candidate =
      perfusionRatio >= P.PI_RECOVER && blanching <= P.BLANCH_EXIT && !dcHigh
        ? 'IDEAL'
        : 'HEAVY';
  } else if (state.cover < P.COVER_GOOD) {
    candidate = 'LIGHT';
  } else if (!hasReference) {
    // Sin máximo de referencia no se puede distinguir presión excesiva de baja
    // perfusión: no se afirma nada.
    candidate = 'NONE';
  } else if (blanching >= P.BLANCH_ENTER && (dcHigh || dcRise >= P.DC_RISE_MIN)) {
    candidate = 'HEAVY';
  } else if (piDeficit >= P.PI_DEFICIT_LIGHT && !dcHigh) {
    candidate = 'LIGHT';
  } else {
    candidate = 'IDEAL';
  }
  settle(state, candidate);

  // Eje: lado del óptimo. El veredicto asentado manda para que el cursor del
  // gauge nunca contradiga la etiqueta.
  let axis: TransmuralAxis;
  if (state.frame < P.MIN_EVIDENCE_FRAMES || state.cover < P.COVER_MIN) {
    axis = 'UNKNOWN';
  } else if (state.state === 'HEAVY') {
    axis = 'OVER';
  } else if (state.state === 'LIGHT') {
    axis = 'UNDER';
  } else if (state.cover < P.COVER_GOOD) {
    axis = 'UNDER';
  } else if (!hasReference) {
    axis = 'UNKNOWN';
  } else if (piDeficit <= P.PI_DEFICIT_OPTIMAL) {
    axis = 'OPTIMAL';
  } else if (blanching >= P.BLANCH_ENTER && (dcHigh || dcRise >= P.DC_RISE_MIN)) {
    axis = 'OVER';
  } else if (dcDelta <= -P.DC_DISPLACE_MIN || !dcHigh) {
    axis = 'UNDER';
  } else {
    axis = 'UNKNOWN';
  }

  // Con movimiento no se afirma un lado nuevo: el eje queda anclado al
  // veredicto ya confirmado (o neutro) hasta que la señal se estabilice.
  if (motionBad) {
    axis = state.state === 'HEAVY'
      ? 'OVER'
      : state.state === 'LIGHT'
        ? 'UNDER'
        : 'UNKNOWN';
  }

  // Grado continuo. La rama OVER/UNDER usa el déficit de PI y el blanqueo para
  // que el cursor se mueva de forma proporcional, no a saltos.
  let fraction: number;
  if (axis === 'OVER') {
    const lateral = clamp(0.30 + 0.70 * piDeficit, 0, 1);
    fraction = 0.5 + 0.5 * Math.max(lateral, blanching * 0.9);
  } else if (axis === 'UNDER') {
    const lateral = clamp(0.30 + 0.70 * piDeficit, 0, 1);
    fraction = 0.5 - 0.5 * lateral;
  } else if (axis === 'OPTIMAL') {
    fraction = 0.5 + clamp(dcDelta * 0.4, -0.08, 0.08);
  } else {
    fraction = 0.5;
  }
  if (state.state === 'HEAVY') fraction = Math.max(fraction, 0.70);
  if (state.state === 'LIGHT') fraction = Math.min(fraction, 0.42);
  if (state.state === 'NONE') fraction = 0.5;

  // Durante movimiento se mantiene el último grado válido: la interfaz no debe
  // interpretar un artefacto como un cambio de presión.
  if (motionBad) {
    fraction = state.state === 'NONE' ? 0.5 : state.lastFraction;
  } else {
    state.lastFraction = fraction;
  }
  fraction = clamp(fraction, 0, 1);

  let reason: TransmuralReason;
  if (state.frame < P.MIN_EVIDENCE_FRAMES) reason = 'WARMUP';
  else if (state.cover < P.COVER_MIN) reason = 'NO_CONTACT';
  else if (motionBad) reason = 'MOTION';
  else if (state.state === 'HEAVY' || axis === 'OVER') reason = 'OVER';
  else if (state.state === 'LIGHT' || axis === 'UNDER') reason = 'UNDER';
  else if (!hasReference) reason = 'NO_REFERENCE';
  else reason = 'OPTIMAL';

  const confidence = clamp(
    0.30 * couplingFactor +
    0.30 * perfusionRatio +
    0.20 * state.motion +
    0.20 * (hasReference ? 1 : 0),
    0,
    1,
  );

  return {
    state: state.state,
    axis,
    fraction,
    confidence,
    blanching,
    forceProxy,
    perfusionRatio,
    coupling,
    dcTrend,
    hasReference,
    reason,
    coverage: state.cover,
    pulsatility: clamp(state.piFast / P.PI_REF, 0, 1),
    motion: state.motion,
  };
}