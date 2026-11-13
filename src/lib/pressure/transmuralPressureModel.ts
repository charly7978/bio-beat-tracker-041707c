/**
 * MODELO FISIOLÓGICO DE PRESIÓN TRANSMURAL (microvascular blanching).
 *
 * Este módulo es la ÚNICA implementación del razonamiento de presión. Es puro
 * (sin React, sin DOM, sin temporizadores) para poder verificarse en tests y
 * ejecutarse dentro del Worker de señal.
 *
 * ── Fisiología ──────────────────────────────────────────────────────────────
 * La presión transmural de un vaso es Pt = Pa − Pe (presión arterial interna
 * menos presión externa). La pulsación óptica es máxima cuando Pt ≈ 0; si Pe
 * supera la presión diastólica/arteriolar, los capilares se colapsan
 * (blanching) y la AC cae aunque el dedo siga apoyado.
 *
 * ── Las DOS observaciones, y por qué están separadas ────────────────────────
 * El error de diseño que hacía que el veredicto fuera arbitrario era medir una
 * sola cosa con dos nombres. "Cobertura" se alimentaba de los píxeles que
 * pasaban el filtro AC/DC, así que con el flash encendido y el rojo saturado el
 * filtro colapsaba y el modelo veía "poco dedo" con el dedo bien apoyado. La
 * física exige separar:
 *
 *  1. SELLADO  (sealRatio)  → "¿la yema cubre la lente?"
 *     Se mide por absorción cromática (el rojo domina al promedio verde/azul),
 *     SIN exigir pulso ni exposición correcta. Es la variable de la FUERZA
 *     aplicada en el rango de contacto útil.
 *
 *  2. PERFUSIÓN (perfusionIndex = AC/DC) → "¿hay flujo sanguíneo?"
 *     Crece hasta un máximo y luego cae. Su colapso con sellado alto y DC alto
 *     es la firma de la isquemia por presión.
 *
 * Con ambas, el lado del óptimo deja de ser una conjetura:
 *   sellado bajo                        → LIGHT  (apoya más)
 *   sellado alto + AC colapsada + DC ↑  → HEAVY  (suelta)
 *   sellado alto + AC cerca del máximo  → IDEAL  (mantén)
 *
 * ── Anclas publicadas ───────────────────────────────────────────────────────
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
 * y `guidance` entrega la instrucción exacta que la UI y el háptico deben
 * mostrar, para que la guía no se reinvente en cada capa.
 */

import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

const P = VITAL_THRESHOLDS.PRESSURE;

/** El movimiento degrada pero no anula; por encima de esto la señal no vale. */
const MOTION_BAD = 0.45;
const MOTION_GOOD_MIN = 0.40;

/** Fracción mínima de píxeles de tejido que deben estar perfundidos: se usa
 *  solo como contexto de guía, nunca para decidir el blanqueo. */
const PERFUSED_FLOOR = 0.22;

export type TransmuralState = 'NONE' | 'LIGHT' | 'IDEAL' | 'HEAVY';
export type TransmuralAxis = 'UNKNOWN' | 'UNDER' | 'OPTIMAL' | 'OVER';
export type TransmuralReason =
  | 'WARMUP'
  | 'NO_CONTACT'
  | 'MOTION'
  | 'SETTLING'
  | 'NO_REFERENCE'
  | 'UNDER'
  | 'OPTIMAL'
  | 'OVER';

/** Instrucción concreta para el usuario. La UI no inventa texto: lo recibe. */
export type TransmuralAction =
  | 'WAIT'
  | 'PRESS_MORE'
  | 'HOLD'
  | 'RELEASE'
  | 'REPOSITION';

export interface TransmuralSample {
  /** Sellado óptico [0..1]: fracción del área explorada cubierta por tejido. */
  sealRatio: number;
  /** Score de movimiento [0..1] (0 = quieto). */
  motionScore: number;
  /** PI crudo AC/DC medido por el pipeline. */
  perfusionIndex: number;
  /** Nivel DC del rojo de los píxeles de tejido (escala 0–255 del sensor). */
  dcLevel: number;
  /** CV temporal del rojo en el ROI. */
  roiRedCv: number;
  /**
   * Fracción de píxeles de tejido que además están perfundidos [0..1].
   * Opcional: si no se informa, el blanqueo se evalúa solo con el sellado.
   */
  perfusedFraction?: number;
}

export interface TransmuralReading {
  /** Veredicto con histéresis. */
  state: TransmuralState;
  /** Lado del óptimo estimado (informativo; el veredicto manda). */
  axis: TransmuralAxis;
  /** Grado continuo [0..1]: 0.5 = óptimo. */
  fraction: number;
  /** Confianza [0..1] de la estimación (sellado + pulso + quietud). */
  confidence: number;
  /** Índice de blanqueo [0..1] (AC colapsada + DC + planitud). */
  blanching: number;
  /** Proxy de fuerza de contacto [0..1] derivado del DC. */
  forceProxy: number;
  /** PI actual / mejor PI del episodio [0..1]. */
  perfusionRatio: number;
  /** Acoplamiento óptico [0..1] (sellado vs. sellado bueno). */
  coupling: number;
  /** Sellado EMA del episodio [0..1]. */
  seal: number;
  /** Sellado normalizado [0..1] contra COVER_MIN..COVER_GOOD. */
  sealNorm: number;
  /** Pulso normalizado contra PI_REF [0..1]. */
  pulsatility: number;
  /** Quietud EMA [0..1] (1 = dedo quieto). */
  motion: number;
  /** Tendencia del DC [-1..1] (>0 = apretando). */
  dcTrend: number;
  /** Existe un PI de referencia válido para comparar. */
  hasReference: boolean;
  /** Motivo del veredicto. */
  reason: TransmuralReason;
  /** Instrucción concreta para el usuario. */
  guidance: TransmuralGuidance;
}

export interface TransmuralGuidance {
  action: TransmuralAction;
  /** Titular corto, en mayúsculas, para el banner. */
  headline: string;
  /** Explicación breve del porqué (evidencia, no adivinación). */
  detail: string;
  /** Cercanía al óptimo [0..1]: 1 = Pt ≈ 0. */
  progress: number;
  /** Confianza del veredicto [0..1]. */
  confidence: number;
}

export interface TransmuralModelState {
  frame: number;
  /** Sellado EMA. */
  seal: number;
  dcFast: number;
  dcSlow: number;
  dcMin: number;
  /** DC lento cuando el dedo selló la lente por primera vez en el episodio. */
  dcRef: number;
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
  /** El dedo ya selló la lente alguna vez en este episodio. */
  sealLearned: boolean;
  state: TransmuralState;
  candidate: TransmuralState;
  candidateRun: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? clamp(v, 0, 1) : 0;
}

export function createTransmuralState(): TransmuralModelState {
  return {
    frame: 0,
    seal: 0,
    dcFast: 0,
    dcSlow: 0,
    dcMin: 0,
    dcRef: 0,
    dcAtPeak: 0,
    cv: 0,
    piFast: 0,
    piPeak: 0,
    motion: 0,
    lastFraction: 0.5,
    peakLearned: false,
    sealLearned: false,
    state: 'NONE',
    candidate: 'NONE',
    candidateRun: 0,
  };
}

/** Reinicia el episodio sin cambiar la identidad del objeto (útil en refs). */
export function resetTransmuralState(state: TransmuralModelState): void {
  state.frame = 0;
  state.seal = 0;
  state.dcFast = 0;
  state.dcSlow = 0;
  state.dcMin = 0;
  state.dcRef = 0;
  state.dcAtPeak = 0;
  state.cv = 0;
  state.piFast = 0;
  state.piPeak = 0;
  state.motion = 0;
  state.lastFraction = 0.5;
  state.peakLearned = false;
  state.sealLearned = false;
  state.state = 'NONE';
  state.candidate = 'NONE';
  state.candidateRun = 0;
}

function settle(
  state: TransmuralModelState,
  candidate: TransmuralState,
  /** Reinicio inmediato solo para pérdida REAL de contacto (dedo fuera). */
  immediateReset = false,
): void {
  if (candidate === state.state) {
    state.candidateRun = 0;
    return;
  }
  if (candidate === 'NONE' && immediateReset) {
    state.state = 'NONE';
    state.candidate = 'NONE';
    state.candidateRun = 0;
    return;
  }
  // La racha solo cuenta si el candidato INSISTE. Sin este reinicio, una
  // secuencia LIGHT → IDEAL → HEAVY acumulaba racha mezclando candidatos y
  // confirmaba un estado que nunca se sostuvo.
  //
  // `NONE` también exige racha (salvo pérdida real de contacto). Antes salía
  // inmediato: con evidencia alterna en el límite el estado caía a NONE en el
  // primer frame y ya no volvía, porque salir de NONE exige racha completa.
  // Resultado: el modelo se quedaba CLAVADO en "no evaluable" de forma indefinida.
  if (candidate !== state.candidate) state.candidateRun = 0;
  state.candidate = candidate;
  state.candidateRun += 1;
  const needed = candidate === 'HEAVY'
    ? P.HEAVY_ENTER_FRAMES
    : candidate === 'NONE'
      ? P.CONTACT_LOST_FRAMES
      : P.VERDICT_CONFIRM_FRAMES;
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
  const seal = clamp01(sample.sealRatio);
  const motionScore = clamp01(sample.motionScore);
  const perfusedFraction =
    typeof sample.perfusedFraction === 'number' && Number.isFinite(sample.perfusedFraction)
      ? clamp01(sample.perfusedFraction)
      : null;

  if (state.frame === 1) {
    state.seal = seal;
    state.dcFast = dc;
    state.dcSlow = dc;
    state.dcMin = dc;
    state.dcAtPeak = dc;
    state.cv = cv;
    state.piFast = pi;
    state.piPeak = pi;
    state.motion = 1 - clamp01(motionScore / MOTION_BAD);
  } else {
    const aFast = P.EMA_FAST;
    const aSlow = P.EMA_SLOW;
    state.seal += (seal - state.seal) * aFast;
    state.dcFast += (dc - state.dcFast) * aFast;
    state.dcSlow += (dc - state.dcSlow) * aSlow;
    state.cv += (cv - state.cv) * aFast;
    state.piFast += (pi - state.piFast) * aFast;
    const motionInst = 1 - clamp01(motionScore / MOTION_BAD);
    state.motion += (motionInst - state.motion) * aFast;
    if (dc < state.dcMin || state.dcMin === 0) state.dcMin = dc;
  }

  const motionBad = state.motion < MOTION_GOOD_MIN || motionScore > MOTION_BAD;
  const hasContact = state.seal >= P.COVER_MIN;

  // El sellado fija el DC de referencia del episodio: es el punto de "dedo
  // apoyado sin fuerza extra". Se ancla al DC RÁPIDO del instante en que la
  // lente se cubre — si se usara el EMA lento arrastraría el valor oscuro
  // previo al contacto y cualquier apoyo posterior parecería presión excesiva.
  if (!state.sealLearned && state.seal >= P.COVER_GOOD && state.dcFast > 0) {
    state.dcRef = state.dcFast;
    state.sealLearned = true;
  }

  // El mejor PI del episodio define Pt ≈ 0. Se congela en HEAVY y con
  // movimiento para no aprender un máximo espurio ni olvidar el colapso. El DC
  // que acompaña a ese máximo es la referencia de fuerza fisiológicamente
  // correcta: "el DC con el que el pulso fue máximo".
  if (
    state.state !== 'HEAVY' &&
    !motionBad &&
    hasContact &&
    state.frame >= P.MIN_EVIDENCE_FRAMES &&
    (!state.peakLearned || state.piFast > state.piPeak * (1 + P.PI_PEAK_MARGIN))
  ) {
    state.piPeak = Math.max(state.piPeak, state.piFast);
    state.dcAtPeak = state.dcFast;
    state.peakLearned = true;
  }

  // Endurecimiento: si el episodio arrancó con el dedo ya apoyado y el DC se
  // registró como 0 (sensor aún sin señal), `dcAtPeak` quedaría en 0 y el eje de
  // fuerza se apoyaría solo en `dcRef`. Se ancla al DC corriente en cuanto hay
  // contacto y un DC válido, sin esperar a que se aprenda el máximo.
  if (state.dcAtPeak <= 0 && hasContact && state.dcFast > 0) {
    state.dcAtPeak = state.dcFast;
  }

  const hasReference = state.piPeak >= P.AC_PEAK_MIN_PI;
  const coupling = clamp01(state.seal / Math.max(1e-6, P.COVER_GOOD));
  const sealNorm = clamp01(
    (state.seal - P.COVER_MIN) / Math.max(1e-6, P.COVER_GOOD - P.COVER_MIN),
  );
  const perfusionRatio = hasReference ? clamp01(state.piFast / state.piPeak) : 0;
  const piDeficit = hasReference ? 1 - perfusionRatio : 0;
  const pulsatility = clamp01(state.piFast / Math.max(1e-6, P.PI_REF));

  // ── DC: eje monótono de la fuerza (Teng 2004, Sensors 2024) ────────────────
  // Se compara contra el DC con el que el pulso fue máximo (`dcAtPeak`), que es
  // el Pt ≈ 0 fisiológico; antes de aprenderlo se usa el DC de sellado. Nunca se
  // usa el mínimo del episodio: un frame oscuro previo al contacto falseaba toda
  // la lectura de fuerza.
  const dcBaseline = state.dcAtPeak > 0 ? state.dcAtPeak : state.dcRef;
  const dcBaselineValid = dcBaseline >= P.DC_MIN_BASELINE;
  const dcSpan = Math.max(dcBaseline * P.DC_DYNAMIC_SPAN, P.DC_MIN_SPAN);
  const forceProxy = dcBaselineValid
    ? clamp01((state.dcFast - dcBaseline) / dcSpan)
    : 0;
  const dcDelta = hasReference && dcBaselineValid
    ? (state.dcFast - state.dcAtPeak) / Math.max(state.dcAtPeak, P.DC_REF_FLOOR)
    : 0;
  const dcRise = dcBaselineValid
    ? clamp01(
      ((state.dcFast - state.dcSlow) / Math.max(state.dcSlow, 1)) / P.DC_RISE_FULL,
    )
    : 0;
  const dcHigh = dcBaselineValid &&
    (state.dcFast - dcBaseline) / Math.max(dcBaseline, 1) >= P.DC_HIGH_MIN;
  const dcTrend = dcBaselineValid
    ? clamp(
      ((state.dcFast - state.dcSlow) / Math.max(state.dcSlow, 1)) / P.DC_RISE_FULL,
      -1,
      1,
    )
    : 0;

  // Planitud del CV: 1 = sin pulsación, 0 = CV en el piso fisiológico.
  const flat = 1 - clamp01(state.cv / Math.max(1e-6, P.CV_FLAT_REF));

  // ── Blanqueo microvascular ────────────────────────────────────────────────
  // Requiere evidencia de FUERZA (DC subiendo o alto). Sin ese requisito, un
  // dedo frío con AC baja y DC normal se leería como "blanqueo 74%" en el gauge.
  // Y con él, el caso extremo —isquemia total, cero píxeles perfundidos— sigue
  // siendo detectable, porque el DC delata la fuerza: atar el blanqueo a la
  // fracción perfundida lo apagaba justo cuando el colapso era completo.
  const couplingFactor = sealNorm;
  const forceEvidence = Math.max(dcRise, dcHigh ? 1 : 0);
  // Acoplamiento suficiente: con sellado pobre la AC baja por fuga de luz, no por
  // isquemia. Este es el umbral que antes quedaba definido y sin usar.
  const couplingOk = coupling >= P.BLANCH_COUPLING_MIN;
  const blanchEligible = hasContact && couplingOk && forceEvidence > 0;
  const blanching = blanchEligible
    ? clamp01(
      couplingFactor * (
        P.BLANCH_AC_WEIGHT * piDeficit +
        P.BLANCH_FLAT_WEIGHT * flat +
        P.BLANCH_DC_WEIGHT * forceEvidence
      ),
    )
    : 0;

  // ── Veredicto ─────────────────────────────────────────────────────────────
  // Orden de prioridad: la isquemia manda, después el sellado, después el pulso.
  let candidate: TransmuralState;
  if (state.frame < P.MIN_EVIDENCE_FRAMES || state.seal < P.COVER_MIN) {
    candidate = 'NONE';
  } else if (motionBad) {
    candidate = state.state === 'NONE' ? 'NONE' : state.state;
  } else if (state.state === 'HEAVY') {
    // Salida de HEAVY solo con recuperación real del pulso y del blanqueo.
    candidate =
      perfusionRatio >= P.PI_RECOVER && blanching <= P.BLANCH_EXIT && !dcHigh
        ? 'IDEAL'
        : 'HEAVY';
  } else if (blanchEligible && blanching >= P.BLANCH_ENTER && forceEvidence > 0) {
    // El colapso requiere que el auto-exposure ya se haya asentado: declararlo
    // durante el warm-up del AE producía veredictos que el usuario veía cambiar.
    candidate = state.frame >= P.HEAVY_WARMUP_FRAMES ? 'HEAVY' : 'NONE';
  } else if (blanchEligible && blanching >= P.BLANCH_EXIT) {
    // Banda de transición: hay evidencia de colapso incipiente (DC subiendo,
    // AC cayendo, blanqueo por encima del umbral de salida) pero todavía no
    // alcanza para CONFIRMAR la isquemia. Sin esta banda el veredicto caía a
    // IDEAL y la guía afirmaba "presión óptima · mantén" justo cuando el usuario
    // estaba apretando de más: el síntoma exacto de "dice cualquier cosa".
    // Se declara "no confirmable" en lugar de afirmar el óptimo.
    candidate = 'NONE';
  } else if (state.seal < P.COVER_GOOD) {
    // Lente no cubierta por la yema: es el caso más común de "apoya bien".
    candidate = 'LIGHT';
  } else if (!hasReference) {
    // Sin máximo de referencia el pulso no es comparable: solo el sellado
    // autoriza a afirmar que el apoyo es correcto.
    candidate = pulsatility >= P.PULSE_OK ? 'IDEAL' : 'NONE';
  } else if (piDeficit >= P.PI_DEFICIT_LIGHT && !dcHigh) {
    candidate = 'LIGHT';
  } else {
    candidate = 'IDEAL';
  }
  // Pérdida REAL de contacto: el dedo ya no cubre la lente. Solo este caso
  // reinicia de inmediato; "no confirmable" exige racha como cualquier estado.
  settle(state, candidate, state.seal < P.COVER_MIN);

  // ── Eje: lado del óptimo ──────────────────────────────────────────────────
  let axis: TransmuralAxis;
  if (state.frame < P.MIN_EVIDENCE_FRAMES || state.seal < P.COVER_MIN) {
    axis = 'UNKNOWN';
  } else if (state.state === 'HEAVY') {
    axis = 'OVER';
  } else if (state.state === 'LIGHT') {
    axis = 'UNDER';
  } else if (state.seal < P.COVER_GOOD) {
    axis = 'UNDER';
  } else if (!hasReference) {
    axis = pulsatility >= P.PULSE_OK ? 'OPTIMAL' : 'UNKNOWN';
  } else if (piDeficit <= P.PI_DEFICIT_OPTIMAL) {
    axis = 'OPTIMAL';
  } else if (blanchEligible && blanching >= P.BLANCH_ENTER) {
    axis = 'OVER';
  } else if (dcDelta <= -P.DC_DISPLACE_MIN || !dcHigh) {
    axis = 'UNDER';
  } else {
    axis = 'UNKNOWN';
  }

  // Con movimiento no se afirma un lado nuevo: el eje queda anclado al veredicto
  // ya confirmado (o neutro) hasta que la señal se estabilice.
  if (motionBad) {
    axis = state.state === 'HEAVY'
      ? 'OVER'
      : state.state === 'LIGHT'
        ? 'UNDER'
        : 'UNKNOWN';
  }

  // ── Grado continuo ────────────────────────────────────────────────────────
  // OVER/UNDER usan el déficit de PI, el sellado y la pulsatilidad para que el
  // cursor se mueva de forma proporcional, no a saltos entre dos mesetas.
  let fraction: number;
  if (axis === 'OVER') {
    fraction = 0.5 + 0.5 * Math.max(piDeficit, blanching * 0.95);
  } else if (axis === 'UNDER') {
    const lateral = Math.max(
      1 - sealNorm,
      piDeficit * 0.65,
      1 - pulsatility,
    );
    fraction = 0.5 - 0.5 * clamp01(0.25 + 0.75 * lateral);
  } else if (axis === 'OPTIMAL') {
    fraction = 0.5 + clamp(dcDelta * 0.3, -0.06, 0.06);
  } else {
    fraction = 0.5;
  }
  // Sin contacto no se afirma grado: el cursor vuelve al centro en lugar de
  // quedarse clavado donde lo dejó el último veredicto (p. ej. 0,70 de HEAVY).
  if (state.seal < P.COVER_MIN || state.frame < P.MIN_EVIDENCE_FRAMES) {
    fraction = 0.5;
  } else {
    if (state.state === 'HEAVY') fraction = Math.max(fraction, 0.70);
    if (state.state === 'LIGHT') fraction = Math.min(fraction, 0.42);
    // NONE conserva el grado del eje conocido (OVER/UNDER) para que el cursor se
    // mueva aunque el veredicto aún no esté confirmado; solo el eje UNKNOWN deja
    // el cursor en el centro.
  }

  // Durante movimiento se mantiene el último grado válido: la interfaz no debe
  // interpretar un artefacto como un cambio de presión.
  if (motionBad) {
    fraction = state.state === 'NONE' ? 0.5 : state.lastFraction;
  } else {
    state.lastFraction = fraction;
  }
  fraction = clamp01(fraction);

  // ── Motivo ────────────────────────────────────────────────────────────────
  // Se deriva del veredicto ASENTADO, no del candidato instantáneo. Derivarlo del
  // candidato hacía que el texto de guía cambiara 3 veces mientras la histéresis
  // confirmaba un solo estado: el usuario veía "presiona más" → "mantén" →
  // "suelta" en menos de medio segundo, sin que nada real hubiera cambiado.
  let reason: TransmuralReason;
  if (state.frame < P.MIN_EVIDENCE_FRAMES) reason = 'WARMUP';
  else if (state.seal < P.COVER_MIN) reason = 'NO_CONTACT';
  else if (motionBad) reason = 'MOTION';
  else if (state.state === 'HEAVY') reason = 'OVER';
  else if (state.state === 'LIGHT') reason = 'UNDER';
  else if (state.state === 'IDEAL') {
    // Urgencia: si hay un candidato correctivo pendiente, NO se afirma "mantén".
    // Afirmar "presión óptima" mientras la presión ya es excesiva es el "dice
    // cualquier cosa". Se muestra neutro hasta que el candidato se confirme.
    reason = candidate === 'IDEAL' ? 'OPTIMAL' : 'SETTLING';
  }
  else if (!hasReference) reason = 'NO_REFERENCE';
  else reason = 'SETTLING';

  const confidence = clamp01(
    0.34 * coupling +
    0.28 * perfusionRatio +
    0.18 * state.motion +
    0.20 * (hasReference ? 1 : 0),
  );

  const guidance = buildGuidance({
    reason,
    state: state.state,
    action: axis,
    seal,
    sealNorm,
    pulsatility,
    blanching,
    confidence,
    perfusedOk: perfusedFraction === null || perfusedFraction >= PERFUSED_FLOOR,
  });

  return {
    state: state.state,
    axis,
    fraction,
    confidence,
    blanching,
    forceProxy,
    perfusionRatio,
    coupling,
    seal: state.seal,
    sealNorm,
    pulsatility,
    motion: state.motion,
    dcTrend,
    hasReference,
    reason,
    guidance,
  };
}

/**
 * Traduce el estado medido a una instrucción concreta. Vive aquí (y no en la
 * UI) para que el texto que ve el usuario, el patrón háptico y el color del
 * gauge sean la MISMA decisión, imposible de contradecir entre sí.
 */
function buildGuidance(input: {
  reason: TransmuralReason;
  state: TransmuralState;
  action: TransmuralAxis;
  seal: number;
  sealNorm: number;
  pulsatility: number;
  blanching: number;
  confidence: number;
  perfusedOk: boolean;
}): TransmuralGuidance {
  const progress = clamp01(
    input.state === 'HEAVY'
      ? 1 - input.blanching
      : input.state === 'LIGHT'
        ? input.sealNorm * 0.5 + clamp01(input.pulsatility / Math.max(1e-6, P.PULSE_OK)) * 0.5
        : input.state === 'IDEAL'
          ? 0.85 + 0.15 * clamp01(input.pulsatility)
          : 0.35,
  );

  const base = { progress, confidence: input.confidence };

  switch (input.reason) {
    case 'WARMUP':
      return {
        ...base,
        action: 'WAIT',
        headline: 'AJUSTANDO LA CÁMARA',
        detail: 'Estabilizando exposición. Apoya el dedo sin moverlo.',
      };
    case 'NO_CONTACT':
      return {
        ...base,
        action: 'REPOSITION',
        headline: 'APOYA EL DEDO EN LA LENTE',
        detail: 'No se detecta tejido cubriendo la lente. El flash debe quedar tapado por la yema.',
      };
    case 'MOTION':
      return {
        ...base,
        action: 'WAIT',
        headline: 'NO TE MUEVAS',
        detail: 'El movimiento altera la lectura. Sostén el dedo quieto un instante.',
      };
    case 'NO_REFERENCE':
      return {
        ...base,
        action: 'PRESS_MORE',
        headline: 'PRESIONA UN POCO MÁS',
        detail: 'La lente está cubierta pero el pulso todavía no es aprovechable. Aumenta el apoyo de forma suave y constante.',
      };
    case 'SETTLING':
      // El estado aún no está confirmado: no se afirma ni se pide corregir.
      return {
        ...base,
        action: 'WAIT',
        headline: 'AJUSTANDO LA PRESIÓN',
        detail: 'La señal todavía no permite confirmar la presión. Mantén el dedo quieto un instante.',
      };
    case 'UNDER':
      return input.seal < P.COVER_GOOD
        ? {
          ...base,
          action: 'PRESS_MORE',
          headline: 'PRESIONA UN POCO MÁS',
          detail: input.seal < P.COVER_SEALED
            ? 'La yema no cubre toda la lente: entra luz de la habitación. Apoya el centro del dedo.'
            : 'La yema no cubre toda la lente. Apoya el centro del dedo sobre el cristal.',
        }
        : {
          ...base,
          action: 'PRESS_MORE',
          headline: 'PRESIONA UN POCO MÁS',
          detail: !input.perfusedOk
            ? 'El tejido apenas tiene riego. Puede ser un dedo frío: caliéntalo o apoya un poco más.'
            : 'El contacto es correcto pero el pulso es débil. Aumenta la presión despacio.',
        };
    case 'OVER':
      return {
        ...base,
        action: 'RELEASE',
        headline: input.state === 'HEAVY' ? 'SUELTA UN POCO EL DEDO' : 'PRESIONAS DE MÁS',
        detail: !input.perfusedOk
          ? 'El riego ha desaparecido del lecho capilar: la presión es excesiva. Afloja de inmediato.'
          : input.blanching > 0.7
            ? 'El flujo sanguíneo se está cortando (los capilares se colapsan). Relaja la presión.'
            : 'La presión excede la del lecho capilar. Afloja hasta notar el pulso otra vez.',
      };
    case 'OPTIMAL':
    default:
      return {
        ...base,
        action: 'HOLD',
        headline: 'PRESIÓN ÓPTIMA · MANTÉN',
        detail: 'El pulso tiene su amplitud máxima. No cambies la presión ni muevas el dedo.',
      };
  }
}