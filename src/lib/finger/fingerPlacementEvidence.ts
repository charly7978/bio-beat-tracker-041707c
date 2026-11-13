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
  inferSignalEtiology,
  hasUsableOpticalContact,
  type CaptureCondition,
  type SignalAction,
  type SignalEtiology,
} from '@/lib/pressure/signalEtiology';
import {
  createTransmuralState,
  observeTransmuralPressure,
  resetTransmuralState,
  type TransmuralAxis,
  type TransmuralModelState,
  type TransmuralState,
} from '@/lib/pressure/transmuralPressureModel';

export type PressureVerdict = TransmuralState;
export type PlacementVerdict = 'NO_FINGER' | 'EDGE' | 'OFF_CENTER' | 'CENTERED';
export type { SignalEtiology };

/**
 * Veredicto AGREGADO de colocación. Es el único que la ventana de
 * previsualización puede usar para decir "OK": sólo `READY` significa que la
 * contacto aporta pulso útil, sin presión excesiva ni captura degradada. No
 * exige centrar tejido que ya entrega señal. Un `READY` de aquí más un `acquisitionStage === 'READY'` del
 * estabilizador es lo que la app llama "todo bien".
 */
export type PlacementReadiness = 'NO_CONTACT' | 'ALIGNING' | 'PRESSURE' | 'READY';

/** Guía que consume la capa de presentación. */
export interface TransmuralGuidance {
  action: SignalAction;
  headline: string;
  detail: string;
  progress: number;
  confidence: number;
}

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
  /**
   * Centroide SUAVIZADO del tejido en coordenadas del encuadre [0..1]
   * (0,0 = esquina superior izquierda del frame). Es la posición REAL del dedo
   * que ve la cámara: la guía visual se dibuja aquí, no en un vector inventado.
   */
  centroid: { x: number; y: number };
  /**
   * Vector de CORRECCIÓN: lo que hay que mover el dedo para llevar el centroide
   * al centro óptico de la lente, en coordenadas del encuadre. `(0,0)` = centrado.
   */
  offset: { x: number; y: number };
  /** [0..1]: 1 = perfectamente centrado (misma escala que `centering`). */
  alignment: number;
  /** Veredicto agregado: sólo `READY` declara la colocación completa correcta. */
  readiness: PlacementReadiness;
  /** Guía ANTES `failing`. Se mantiene por compatibilidad con la UI existente. */
  failing: string[];
  /** Instrucción estructurada: acción + titular + detalle + progreso. */
  guidance: TransmuralGuidance;
  /** Razonamiento causal completo: causa ganadora, alternativas y evidencia. */
  etiology: SignalEtiology;
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
  SCORE_ALPHA,
  PULSE_OK,
} = VITAL_THRESHOLDS.PRESSURE;

const {
  CENTERED_MIN,
  EDGE_MAX,
  STILL_MIN,
} = VITAL_THRESHOLDS.PLACEMENT;

/** Estado del modelo transmural (episodio de contacto actual). */
const model: TransmuralModelState = createTransmuralState();

/** Suavizados de colocación que no pertenecen al modelo de presión. */
const ev = {
  center: 0,
  stab: 0,
  prevCover: 0,
  score: 0.5,
  scoreVerdict: 'NONE' as PressureVerdict,
  /** Centroide suavizado del tejido (coordenadas del encuadre). */
  cx: 0.5,
  cy: 0.5,
};

export function resetPlacementEvidence(): void {
  resetTransmuralState(model);
  ev.center = 0;
  ev.stab = 0;
  ev.prevCover = 0;
  ev.score = 0.5;
  ev.scoreVerdict = 'NONE';
  ev.cx = 0.5;
  ev.cy = 0.5;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function norm(v: number, lo: number, hi: number): number {
  return v <= lo ? 0 : v >= hi ? 1 : (v - lo) / (hi - lo);
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? clamp(v, 0, 1) : 0;
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
  /**
   * Condición técnica de la captura. Un sensor saturado, subexpuesto o lento no
   * aporta evidencia fisiológica: el motor la trata como precondición, no como
   * una hipótesis que compita con las demás.
   */
  capture?: CaptureCondition;
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

  // Centroide SUAVIZADO del tejido: es la posición real del dedo en el frame y
  // lo que dibuja la guía de la ventana. El primer frame arranca en la medida
  // (no en el centro) para no arrastrar medio segundo de animación falsa.
  const cxInst = clamp01(input.centroidX);
  const cyInst = clamp01(input.centroidY);
  if (model.frame <= 1) {
    ev.cx = cxInst;
    ev.cy = cyInst;
  } else {
    ev.cx = ev.cx * d + cxInst * EMA_A;
    ev.cy = ev.cy * d + cyInst * EMA_A;
  }
  // Vector de corrección: del centroide medido AL centro de la lente.
  const offsetX = 0.5 - ev.cx;
  const offsetY = 0.5 - ev.cy;
  const alignment = clamp01(ev.center);

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
  else if (ev.center >= CENTERED_MIN) placement = 'CENTERED';
  else if (ev.center >= EDGE_MAX) placement = 'OFF_CENTER';
  else placement = 'EDGE';

  // ── Veredicto AGREGADO de colocación ────────────────────────────────────────
  // Sólo READY afirma que la colocación está completa. Se apoya en magnitudes
  // ya medidas (sellado, pulso, quietud) y en la precondición de
  // captura: un sensor saturado, subexpuesto o lento no puede dar READY aunque
  // el dedo esté perfecto (no se ve el lecho capilar).
  const captureOk = (input.capture ?? 'OK') === 'OK';
  const usablePosition = hasUsableOpticalContact({
    seal: reading.seal,
    pulsatility: reading.pulsatility,
    stillness: reading.motion,
    capture: input.capture ?? 'OK',
  });
  let readiness: PlacementReadiness;
  if (placement === 'NO_FINGER') readiness = 'NO_CONTACT';
  else if (
    pressure === 'IDEAL' &&
    (placement === 'CENTERED' || usablePosition) &&
    reading.motion >= STILL_MIN &&
    reading.pulsatility >= PULSE_OK &&
    captureOk
  ) {
    readiness = 'READY';
  } else if (pressure === 'LIGHT' || pressure === 'HEAVY') {
    readiness = 'PRESSURE';
  } else {
    readiness = 'ALIGNING';
  }

  const score = clamp(
    W_PULSE * reading.pulsatility +
    W_COVER * norm(coverage, COVER_MIN, COVER_GOOD) +
    W_CENTER * ev.center +
    W_STABIL * ev.stab +
    W_MOTION * reading.motion,
    0,
    1,
  );

  // ── Razonamiento causal: el sistema decide la causa, no una tabla de frases ──
  // Se le entregan TODAS las magnitudes medidas y el motor pondera qué hipótesis
  // explica mejor la señal. La instrucción y la explicación salen de ahí.
  const etiology = inferSignalEtiology({
    seal: reading.seal,
    sealNorm: reading.sealNorm,
    pulsatility: reading.pulsatility,
    perfusionRatio: reading.perfusionRatio,
    hasReference: reading.hasReference,
    dcRatio: reading.dcRatio,
    dcRise: Math.max(0, reading.dcTrend),
    blanching: reading.blanching,
    piTrend: reading.piTrend,
    cvRatio: reading.cvRatio,
    perfusedFraction: input.perfusedFraction ?? 0,
    stillness: reading.motion,
    centering: ev.center,
    capture: input.capture ?? 'OK',
  });

  // Guía derivada de la causa inferida. El titular y el detalle son la
  // explicación generada por el motor con los números de ESTE frame.
  const guidance: TransmuralGuidance = {
    action: etiology.action,
    headline: etiology.headline,
    detail: etiology.explanation,
    progress: clamp01(
      etiology.cause === 'OPTIMAL'
        ? 0.85 + 0.15 * reading.pulsatility
        : etiology.cause === 'EXCESS_PRESSURE'
          ? 1 - reading.blanching
          : etiology.cause === 'INSUFFICIENT_CONTACT' || etiology.cause === 'OFF_CENTER'
            ? reading.sealNorm
            : 0.15,
    ),
    confidence: etiology.confidence,
  };

  // `failing` se mantiene por compatibilidad con la UI que ya lo consume. Solo
  // contiene incidencias REALES: si la causa es óptima no hay nada que corregir.
  const failing: string[] =
    etiology.cause === 'OPTIMAL' ? [] : [etiology.explanation];
  // La causa dominante ya incluye la corrección útil. No sumar una orden de
  // centrado a "afloja" o "espera": varias tareas simultáneas inducen movimiento.
  if (reading.motion < 0.55 && etiology.cause !== 'MOTION') {
    failing.push('Sostén el dedo quieto');
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
    centroid: { x: ev.cx, y: ev.cy },
    offset: { x: offsetX, y: offsetY },
    alignment,
    readiness,
    failing,
    guidance,
    etiology,
    coverage,
    centering: ev.center,
    stability: ev.stab,
    motion: reading.motion,
  };
}

