/**
 * ETIOLOGÍA DE LA SEÑAL — Motor de inferencia causal del propio sistema.
 *
 * Este módulo NO contiene mensajes pregrabados por estado ni un "selector de
 * funciones" en la entrada. Contiene un modelo de hipótesis: cada causa posible
 * declara qué evidencia FÍSICA esperaría ver, el motor compara esa expectativa
 * con lo que la señal realmente muestra, puntúa cada hipótesis y devuelve la más
 * probable CON la evidencia que la sostiene y la que la contradice.
 *
 * La explicación que ve el usuario se genera a partir de los números medidos en
 * ESTE frame, no de una tabla de frases: por eso puede decir "qué pasa y por
 * qué" aunque el caso no estuviera previsto.
 *
 * ── Por qué el razonamiento vive aquí y no en un LLM ────────────────────────
 * El bucle de decisión corre en el Worker, por frame, en un APK que puede estar
 * sin red. Un LLM añadiría latencia no acotada, dependencia de red,
 * no-determinismo (imposible de testear) y coste por frame. La inferencia
 * determinista sobre evidencia medida es más rápida, auditable y verificable, y
 * su salida es exacta. Si algún día se quiere prosa más natural, este módulo ya
 * entrega la estructura (hipótesis ganadora, evidencia a favor/en contra) que un
 * LLM podría redactar sin volver a decidir nada.
 *
 * ── Anclas de la literatura ─────────────────────────────────────────────────
 *  - Anastomosis arteriovenosas (glomus): máxima densidad en el dedo; control
 *    simpático adrenérgico puro; el flujo se regula RETIRANDO el tono
 *    vasoconstrictor. (Sauder & Winson, PMC4861183; Kellogg, Adv Physiol Educ
 *    2014; Taylor et al., Univ. Wollongong.)
 *  - «when the hands were cooler, the pulsatile component of PI decreased,
 *    whereas the nonpulsatile component remained unchanged» — Sci Rep
 *    2020;10:6741. Es decir: vasoconstricción = AC↓ con DC estable;
 *    presión mecánica = AC↓ con DC↑.
 *  - El PI es un marcador validado de perfusión y de tono simpático: cae con
 *    frío, dolor, estrés e hipoperfusión (JCDR; Indian J Pediatr 2019;
 *    Cureus 2024, R=0.665–0.779 contra láser Doppler).
 *  - El recalentamiento local eleva la amplitud pulsátil de forma monótona
 *    (hasta 23×; iPPG térmica 2016 y 2026): un dedo frío SUBE su PI bajo el
 *    flash, un dedo aplastado no.
 */

import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

const P = VITAL_THRESHOLDS.PRESSURE;

/** Estado técnico de la captura. Un sensor degradado no aporta evidencia
 *  fisiológica: es una precondición, no una hipótesis que compita. */
export type CaptureCondition = 'OK' | 'SATURATED' | 'UNDEREXPOSED' | 'LOW_FPS' | 'MOTION';

export type SignalCauseId =
  | 'NO_CONTACT'
  | 'OFF_CENTER'
  | 'EXCESS_PRESSURE'
  | 'INSUFFICIENT_CONTACT'
  | 'VASOCONSTRICTION'
  | 'MOTION'
  | 'SATURATED'
  | 'UNDEREXPOSED'
  | 'LOW_FPS'
  | 'OPTIMAL';

/** Instrucción derivada de la causa. La UI no elige: la recibe. */
export type SignalAction =
  | 'REPOSITION'
  | 'CENTER'
  | 'PRESS_MORE'
  | 'RELEASE'
  | 'WARM'
  | 'HOLD'
  | 'WAIT'
  | 'FIX_SATURATION'
  | 'FIX_LIGHT'
  | 'FIX_FPS';

/** Toda la evidencia MEDIDA que el motor puede usar. Nada aquí es inventado:
 *  cada campo sale del procesador de señal. */
export interface EtiologyEvidence {
  /** Sellado óptico [0..1]: lente cubierta por tejido. */
  seal: number;
  /** Sellado normalizado [0..1] contra COVER_MIN..COVER_GOOD. */
  sealNorm: number;
  /** Pulsatilidad normalizada [0..1] (PI / PI_REF). */
  pulsatility: number;
  /** PI actual / mejor PI del episodio [0..1]. */
  perfusionRatio: number;
  /** ¿Se estableció alguna vez un pulso de referencia en este episodio? */
  hasReference: boolean;
  /** DC actual / DC del mejor pulso. >1 = el DC subió sobre el punto de mejor pulso. */
  dcRatio: number;
  /** Subida rápida del DC [0..1]. */
  dcRise: number;
  /** Índice de blanqueo [0..1]. */
  blanching: number;
  /** Tendencia del PI: +1 subiendo (recalentamiento), -1 bajando, 0 estable. */
  piTrend: -1 | 0 | 1;
  /** CV temporal normalizado [0..1]: 1 = pulsátil, 0 = plano. */
  cvRatio: number;
  /** Fracción de tejido que además está perfundido [0..1]. */
  perfusedFraction: number;
  /** Quietud [0..1]: 1 = dedo quieto. */
  stillness: number;
  /** Centrado [0..1]: 1 = yema centrada en la lente. */
  centering: number;
  /** Condición técnica de la captura. */
  capture: CaptureCondition;
}

/** Una evidencia concreta que el motor usó, con su valor medido. */
export interface EtiologyFactor {
  /** Nombre corto de la evidencia (para depurar y explicar). */
  id: string;
  /** Valor medido [0..1]. */
  value: number;
  /** Cuánto empuja hacia la hipótesis ganadora [-1..1]. */
  contribution: number;
}

export interface SignalEtiology {
  /** Causa dominante. */
  cause: SignalCauseId;
  /** Etiqueta corta para la UI. */
  label: string;
  /** Instrucción derivada de la causa. */
  action: SignalAction;
  /** Titular breve. */
  headline: string;
  /** Explicación generada con los números medidos: qué pasa y por qué. */
  explanation: string;
  /** Confianza [0..1] de la causa dominante. */
  confidence: number;
  /** Hipótesis alternativas con su probabilidad, para no ocultar ambigüedad. */
  alternatives: Array<{ cause: SignalCauseId; probability: number }>;
  /** Evidencia que sostuvo la decisión. */
  supporting: EtiologyFactor[];
  /** Evidencia que contradijo la decisión. */
  contradicting: EtiologyFactor[];
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}

/**
 * Acoplamiento óptico mínimo para que una hipótesis de PERFUSIÓN sea aplicable.
 * Por debajo de esto la AC baja porque la luz no entra al tejido, no porque el
 * lecho capilar esté cerrado: diagnosticar frío o blanqueo sería inventar.
 */
const COUPLING_GATE = 0.5;

/**
 * Centrado mínimo para descartar el descentrado como causa. Por encima de esto
 * la geometría está bien y no puede explicar una señal débil.
 */
const CENTERING_GATE = 0.6;

/**
 * Quietud mínima para que la lectura óptica describa sangre y no movimiento.
 * Con movimiento grosero el patrón que cambia entre frames es el dedo, así que
 * ninguna hipótesis fisiológica es sostenible.
 */
const STILLNESS_GATE = 0.35;

/** El centro geométrico no invalida tejido que ya aporta contacto y pulso útiles. */
export function hasUsableOpticalContact(
  e: Pick<EtiologyEvidence, 'seal' | 'pulsatility' | 'stillness' | 'capture'>,
): boolean {
  return e.capture === 'OK' &&
    e.seal >= P.COVER_GOOD &&
    e.pulsatility >= P.PULSE_OK &&
    e.stillness >= VITAL_THRESHOLDS.PLACEMENT.STILL_MIN;
}

interface CauseSpec {
  label: string;
  action: SignalAction;
  /** Pesos por evidencia. Positivo confirma; negativo descarta. */
  weights: Record<string, number>;
  /**
   * Precondición fisiológica. Sin ella la hipótesis NO es aplicable y no entra
   * en la competición: no se puede diagnosticar perfusión sin acoplamiento
   * óptico, ni "apoyo insuficiente" si no hay apoyo. Sin este filtro, los
   * términos genéricos de "pulso débil" hacían que la vasoconstricción ganara
   * incluso con la lente sin cubrir.
   */
  eligible?: (e: EtiologyEvidence) => boolean;
}

/**
 * Modelo de hipótesis. Cada causa declara la firma de evidencia que la
 * literatura asocia a ella. Los pesos no son "umbrales de UI": son la fuerza con
 * que cada evidencia confirma (peso > 0) o DESCARTA (peso < 0) esa causa.
 *
 * La evidencia negativa es imprescindible: sin ella, con la lente sin cubrir el
 * motor podía "diagnosticar" vasoconstricción porque el pulso era débil, cuando
 * lo único demostrado es que no hay acoplamiento óptico. Diagnosticar perfusión
 * sin contacto es imposible, y el modelo debe saberlo.
 */
const CAUSES: Record<SignalCauseId, CauseSpec> = {
  NO_CONTACT: {
    label: 'Falta de contacto',
    action: 'REPOSITION',
    // Se mide contra el PISO de contacto (COVER_MIN), no contra la cobertura
    // buena: así "no hay dedo" no se confunde con "el dedo cubre poco", que es
    // otra causa con otra instrucción.
    weights: { belowContactFloor: 3.5, sealPresent: -2.0, pulseWeak: 0.4, offCenter: 0.5 },
  },
  OFF_CENTER: {
    label: 'Contacto incompleto y descentrado',
    action: 'CENTER',
    // Precondición geométrica: si la yema está centrada, el descentrado no es
    // una causa posible de la señal débil, por mucho residuo que quede.
    eligible: (e) => clamp01(e.centering) < CENTERING_GATE && !hasUsableOpticalContact(e),
    weights: { sealMissing: 1.4, offCenter: 2.6, sealPresent: 0.8, pulseWeak: 0.5 },
  },
  EXCESS_PRESSURE: {
    // Blanqueo mecánico: el pulso cae mientras el DC sube sobre el punto de
    // mejor pulso del propio dedo (Teng 2004; IEEE TIM 2023). Exige acoplamiento
    // óptico: sin lente cubierta la AC baja por fuga de luz, no por colapso.
    label: 'Presión excesiva: blanqueo capilar',
    action: 'RELEASE',
    eligible: (e) => clamp01(e.sealNorm) >= COUPLING_GATE,
    weights: {
      sealPresent: 2.0,
      sealMissing: -2.0,
      pulseWeak: 1.2,
      // Una hipótesis que predice pulso débil no puede ganar con pulso fuerte.
      pulseStrong: -1.5,
      // Si el dedo está descentrado, la geometría ya explica la señal débil.
      offCenter: -1.0,
      dcAbove: 2.2,
      blanching: 1.8,
      piFalling: 0.8,
      cvFlat: 0.6,
    },
  },
  VASOCONSTRICTION: {
    // AC baja con DC estable y tendencia al alza por recalentamiento bajo el
    // flash: el dedo está frío, no mal apoyado. Exige acoplamiento óptico.
    label: 'Vasoconstricción: dedo frío o estrés',
    action: 'WARM',
    eligible: (e) => clamp01(e.sealNorm) >= COUPLING_GATE,
    weights: {
      sealPresent: 2.2,
      sealMissing: -2.5,
      pulseWeak: 1.4,
      pulseStrong: -2.0,
      offCenter: -1.5,
      dcSteady: 1.8,
      piRising: 1.2,
      perfusedLow: 1.0,
      noReference: 0.6,
    },
  },
  INSUFFICIENT_CONTACT: {
    // Lente no cubierta del todo por la yema: aquí sí, apoyar más cubre más
    // lente. Si la lente YA está cubierta, apretar no añade cobertura: resta.
    label: 'Apoyo insuficiente sobre la lente',
    action: 'PRESS_MORE',
    eligible: (e) => e.seal >= P.COVER_MIN,
    weights: {
      sealMissing: 1.6,
      sealPresent: -2.0,
      pulseWeak: 0.8,
      pulseStrong: -1.2,
      dcSteady: 0.6,
    },
  },
  MOTION: {
    label: 'Artefacto de movimiento',
    action: 'WAIT',
    weights: { motion: 3.0, stillness: -1.0 },
  },
  SATURATED: {
    label: 'Sensor saturado',
    action: 'FIX_SATURATION',
    weights: { saturated: 4.0 },
  },
  UNDEREXPOSED: {
    label: 'Iluminación insuficiente',
    action: 'FIX_LIGHT',
    weights: { underexposed: 4.0 },
  },
  LOW_FPS: {
    label: 'Fotogramas insuficientes',
    action: 'FIX_FPS',
    weights: { lowFps: 4.0 },
  },
  OPTIMAL: {
    label: 'Contacto óptimo',
    action: 'HOLD',
    weights: {
      sealPresent: 1.2,
      sealMissing: -1.2,
      pulseStrong: 2.0,
      pulseWeak: -1.5,
      dcSteady: 1.4,
      stillness: 1.0,
      centering: 0.6,
      motion: -1.5,
    },
  },
};

/** Construye el vector de evidencias normalizadas a partir de la medición. */
function buildFeatures(e: EtiologyEvidence): Record<string, number> {
  const sealNorm = clamp01(e.sealNorm);
  const pulsatility = clamp01(e.pulsatility);
  const dcRatio = Number.isFinite(e.dcRatio) ? Math.max(0, e.dcRatio) : 1;
  // Cuánto ha subido el DC sobre el punto de mejor pulso del propio dedo.
  const dcAboveFull = P.DC_HIGH_MIN * 2;
  const dcAbove = clamp01((dcRatio - 1) / Math.max(1e-6, dcAboveFull));
  const cvRatio = clamp01(e.cvRatio);
  const perfused = clamp01(e.perfusedFraction);

  return {
    sealMissing: 1 - sealNorm,
    sealPresent: sealNorm,
    // Cuánto falta para alcanzar el PISO de contacto (0 si ya lo supera).
    belowContactFloor: clamp01(1 - clamp01(e.seal) / Math.max(1e-6, P.COVER_MIN)),
    pulseWeak: 1 - pulsatility,
    pulseStrong: pulsatility,
    dcAbove,
    dcSteady: 1 - dcAbove,
    piFalling: e.piTrend < 0 ? 1 : 0,
    piRising: e.piTrend > 0 ? 1 : 0,
    cvFlat: 1 - cvRatio,
    motion: 1 - clamp01(e.stillness),
    offCenter: 1 - clamp01(e.centering),
    perfusedLow: 1 - perfused,
    noReference: e.hasReference ? 0 : 1,
    stillness: clamp01(e.stillness),
    centering: clamp01(e.centering),
    blanching: clamp01(e.blanching),
    saturated: e.capture === 'SATURATED' ? 1 : 0,
    underexposed: e.capture === 'UNDEREXPOSED' ? 1 : 0,
    lowFps: e.capture === 'LOW_FPS' ? 1 : 0,
  };
}

/**
 * Condiciones técnicas que INVALIDAN cualquier lectura fisiológica. No son una
 * hipótesis más: si el sensor está saturado, la AC/DC no significa nada, así que
 * ninguna causa fisiológica puede sostenerse con esa evidencia.
 */
function technicalCause(capture: CaptureCondition): SignalCauseId | null {
  if (capture === 'SATURATED') return 'SATURATED';
  if (capture === 'UNDEREXPOSED') return 'UNDEREXPOSED';
  if (capture === 'LOW_FPS') return 'LOW_FPS';
  return null;
}

/** Explica la tendencia del PI solo cuando es informativa (no inventa flechas). */
function trendText(trend: -1 | 0 | 1, rising: string, falling: string): string {
  if (trend > 0) return `, ${rising}`;
  if (trend < 0) return `, ${falling}`;
  return '';
}

/** Explicación generada con los números MEDIDOS, no con frases de tabla. */
function explain(
  cause: SignalCauseId,
  e: EtiologyEvidence,
): string {
  const pulsPct = Math.round(clamp01(e.pulsatility) * 100);
  const dcPct = Math.round((Number.isFinite(e.dcRatio) ? e.dcRatio : 1) * 100);
  const sealPct = Math.round(clamp01(e.seal) * 100);
  const perfPct = Math.round(clamp01(e.perfusedFraction) * 100);

  switch (cause) {
    case 'SATURATED':
      return 'El sensor está saturado: el rojo llega al tope y ya no distingue luz de tejido. Cualquier lectura de pulso sería ruido. Baja el brillo o apaga el flash.';
    case 'UNDEREXPOSED':
      return 'Llega muy poca luz al sensor. Sin señal óptica no hay pulso que medir: acerca el dedo a la lente o activa el flash.';
    case 'LOW_FPS':
      return 'Los fotogramas llegan demasiado lentos para reconstruir el pulso. Cierra otras apps o baja la resolución de la cámara.';
    case 'MOTION':
      return 'El dedo se mueve y el patrón óptico cambia entre fotogramas: lo que se mide es el movimiento, no el pulso. Sostén el dedo quieto.';
    case 'NO_CONTACT':
      return `Solo el ${sealPct}% de la lente está cubierto por tejido. Sin contacto no hay pulso: apoya el dedo sobre el cristal y el flash.`;
    case 'OFF_CENTER':
      return `La yema cubre ${sealPct}% de la lente pero está descentrada. La luz se escapa por el borde y el pulso se degrada: centra el dedo sobre la lente.`;
    case 'INSUFFICIENT_CONTACT':
      return `La lente está cubierta al ${sealPct}% y el pulso está al ${pulsPct}% de lo normal. Falta superficie de contacto: apoya un poco más para sellar la lente.`;
    case 'EXCESS_PRESSURE':
      return `El pulso cayó al ${pulsPct}%${trendText(e.piTrend, 'aunque ya está remontando al aflojar', 'y sigue cayendo')} mientras el DC subió al ${dcPct}% del punto de mejor pulso de tu dedo. Eso es presión externa superando la del lecho capilar: los capilares se están colapsando. Suelta un poco.`;
    case 'VASOCONSTRICTION':
      return `El pulso está al ${pulsPct}%${trendText(e.piTrend, 'y va subiendo a medida que el dedo se calienta', 'y no mejora con el calor')} pero el DC sigue al ${dcPct}% del punto de mejor pulso: no estás apretando de más. Con el sello correcto y solo el ${perfPct}% del tejido con riego, la causa es vasoconstricción: el dedo está frío o hay tono simpático y los vasos están cerrados. Frótalo o tápalo con la otra mano; no aprietes más.`;
    case 'OPTIMAL':
      return `Lente sellada al ${sealPct}%, pulso al ${pulsPct}% de lo normal y DC estable al ${dcPct}%. El lecho capilar está bien perfundido: mantén el dedo así.`;
    default:
      return '';
  }
}

/**
 * Motor de inferencia. Devuelve la causa dominante, las alternativas y la
 * evidencia que sostuvo y contradijo la decisión.
 *
 * Es una competición de evidencia ponderada (no una cascada de if): si dos
 * causas explican la señal, gana la que acumula más evidencia a favor, y la otra
 * queda expuesta como alternativa con su probabilidad. Así el sistema puede
 * decir "creo que es X, aunque Y también encaja" en lugar de afirmar un veredicto
 * que la señal no sostiene.
 */
export function inferSignalEtiology(e: EtiologyEvidence): SignalEtiology {
  const features = buildFeatures(e);

  // Precondición técnica: sin evidencia óptica válida no se afirma fisiología.
  const tech = technicalCause(e.capture);
  if (tech) {
    const spec = CAUSES[tech];
    return {
      cause: tech,
      label: spec.label,
      action: spec.action,
      headline: spec.label.toUpperCase(),
      explanation: explain(tech, e),
      confidence: 1,
      alternatives: [],
      supporting: [{ id: 'capture', value: 1, contribution: 1 }],
      contradicting: [],
    };
  }

  // Movimiento dominante: el patrón óptico que cambia entre frames es el dedo,
  // no la sangre. Ninguna causa fisiológica es sostenible con esa evidencia, así
  // que el movimiento no compite: es una precondición.
  if (clamp01(e.stillness) < STILLNESS_GATE) {
    const spec = CAUSES.MOTION;
    return {
      cause: 'MOTION',
      label: spec.label,
      action: spec.action,
      headline: spec.label.toUpperCase(),
      explanation: explain('MOTION', e),
      confidence: 1,
      alternatives: [],
      supporting: [{ id: 'motion', value: 1 - clamp01(e.stillness), contribution: 1 }],
      contradicting: [],
    };
  }

  const scored = (Object.keys(CAUSES) as SignalCauseId[])
    .filter((cause) => {
      const spec = CAUSES[cause];
      return !spec.eligible || spec.eligible(e);
    })
    .map((cause) => {
      const spec = CAUSES[cause];
      let score = 0;
      const contributions: EtiologyFactor[] = [];
      for (const [featureId, weight] of Object.entries(spec.weights)) {
        const value = features[featureId] ?? 0;
        const contribution = value * weight;
        score += contribution;
        if (contribution !== 0) contributions.push({ id: featureId, value, contribution });
      }
      return { cause, spec, score, contributions };
    });

  // Si ninguna hipótesis es aplicable (p. ej. sin contacto ni acoplamiento), la
  // única afirmación honesta es que falta contacto.
  if (scored.length === 0) {
    const spec = CAUSES.NO_CONTACT;
    return {
      cause: 'NO_CONTACT',
      label: spec.label,
      action: spec.action,
      headline: spec.label.toUpperCase(),
      explanation: explain('NO_CONTACT', e),
      confidence: 1,
      alternatives: [],
      supporting: [{ id: 'sealMissing', value: features.sealMissing, contribution: 1 }],
      contradicting: [],
    };
  }

  const top = scored.reduce((a, b) => (b.score > a.score ? b : a));

  // Normalización softmax: los pesos pueden ser negativos (evidencia en contra),
  // así que se desplaza por el máximo antes de exponenciar. Da una probabilidad
  // interpretable sin que una hipótesis descartada reste probabilidad a las demás.
  const maxScore = top.score;
  const exps = scored.map((s) => ({
    cause: s.cause,
    weight: Math.exp(s.score - maxScore),
  }));
  const expTotal = exps.reduce((sum, e) => sum + e.weight, 0);

  const alternatives = exps
    .filter((e) => e.cause !== top.cause)
    .map((e) => ({ cause: e.cause, probability: expTotal > 0 ? e.weight / expTotal : 0 }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 2);

  const confidence = expTotal > 0 ? clamp01(exps.find((e) => e.cause === top.cause)!.weight / expTotal) : 0;

  const supporting = top.contributions
    .filter((c) => c.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3);

  // La evidencia que contradice la ganadora es la que más empuja a la segunda
  // hipótesis: es justo lo que hay que mostrar para no ocultar la ambigüedad.
  const runnerUp = scored
    .filter((s) => s.cause !== top.cause)
    .sort((a, b) => b.score - a.score)[0];
  const contradicting = runnerUp
    ? runnerUp.contributions
      .filter((c) => c.contribution > 0)
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 2)
    : [];

  const cause = top.score <= 0 ? 'OPTIMAL' : top.cause;
  const spec = CAUSES[cause];

  return {
    cause,
    label: spec.label,
    action: spec.action,
    headline: spec.label.toUpperCase(),
    explanation: explain(cause, e),
    confidence,
    alternatives,
    supporting: cause === top.cause ? supporting : [],
    contradicting: cause === top.cause ? contradicting : [],
  };
}
