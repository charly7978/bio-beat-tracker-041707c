/**
 * POLÍTICA ADAPTATIVA EN TIEMPO REAL (ROI / FILTROS / RANGOS DE CALIDAD)
 *
 * No usa umbrales absolutos: cada decisión se toma sobre la DISTRIBUCIÓN de la
 * propia sesión. Se mantienen medias y varianzas online (Welford exponencial)
 * de SQI y movimiento, y las decisiones se derivan de la posición RELATIVA
 * (z-score → escala 0..1) de la muestra actual dentro de esa distribución.
 *
 * Consecuencia práctica:
 *  - Un teléfono "ruidoso" no queda permanentemente bloqueado por un umbral fijo:
 *    su propio nivel base se convierte en la referencia.
 *  - Una sesión limpia se vuelve más exigente automáticamente.
 *
 * Todo el estado es reiniciable (`resetAdaptivePolicy`) para no arrastrar
 * memoria entre sesiones ni entre cambios de cámara.
 */
import { clamp, clamp01 } from '../../utils/math';

export interface AdaptiveRuntimePolicy {
  /** Factor multiplicativo sobre ROI_SIZE_FRACTION (0.62..1.0). */
  roiScale: number;
  /** Corte inferior del pasabanda de pulso (Hz). */
  bandLowHz: number;
  /** Corte superior del pasabanda de pulso (Hz). */
  bandHighHz: number;
  /** Histéresis dinámica (ms) para cambiar de fuente de señal. */
  sourceHysteresisMs: number;
  /** Posición relativa del SQI actual en la sesión (0..1). */
  qualityRelative: number;
  /** Posición relativa del movimiento actual en la sesión (0..1). */
  motionRelative: number;

  // --- estado interno (online stats) ---
  sqiMean: number;
  sqiVar: number;
  motionMean: number;
  motionVar: number;
  samples: number;
}

const BASE = {
  ROI_SCALE_MIN: 0.62,
  ROI_SCALE_MAX: 1.0,
  BAND_LOW_MIN: 0.45,
  BAND_LOW_MAX: 0.85,
  BAND_HIGH_MIN: 2.6,
  BAND_HIGH_MAX: 4.6,
  HYST_MIN_MS: 1800,
  HYST_MAX_MS: 6000,
  /** Inercia de las estadísticas online (más alto = memoria más larga). */
  STAT_ALPHA: 0.02,
  /** Suavizado de las salidas para evitar oscilación frame a frame. */
  OUT_ALPHA: 0.08,
  /** Nº de muestras antes de confiar en la distribución de la sesión. */
  WARMUP_SAMPLES: 45,
} as const;

/** z-score → 0..1 mediante logística; sin umbrales duros. */
function relativePosition(value: number, mean: number, variance: number): number {
  const sd = Math.sqrt(Math.max(variance, 1e-9));
  const z = (value - mean) / sd;
  return 1 / (1 + Math.exp(-z));
}

export function createAdaptivePolicy(): AdaptiveRuntimePolicy {
  return {
    roiScale: 1,
    bandLowHz: 0.5,
    bandHighHz: 4.5,
    sourceHysteresisMs: 4000,
    qualityRelative: 0.5,
    motionRelative: 0.5,
    sqiMean: 0,
    sqiVar: 1,
    motionMean: 0,
    motionVar: 1,
    samples: 0,
  };
}

export function resetAdaptivePolicy(p: AdaptiveRuntimePolicy): AdaptiveRuntimePolicy {
  Object.assign(p, createAdaptivePolicy());
  return p;
}

export interface AdaptiveInput {
  /** SQI global 0..100 del frame. */
  sqi: number;
  /** Score de movimiento (IMU + señal). */
  motion: number;
  /** Índice de perfusión AC/DC. */
  perfusionIndex: number;
  /** Periodicidad/autocorrelación 0..1. */
  periodicity: number;
  /** BPM conocido (0 si aún no hay). */
  bpm: number;
}

/**
 * Avanza la política un frame. Muta y devuelve `p` (hot path: sin alocaciones).
 */
export function updateAdaptivePolicy(
  p: AdaptiveRuntimePolicy,
  input: AdaptiveInput,
): AdaptiveRuntimePolicy {
  const a = BASE.STAT_ALPHA;

  // Estadística online (EMA de media y varianza) — la referencia es la sesión.
  const dSqi = input.sqi - p.sqiMean;
  p.sqiMean += a * dSqi;
  p.sqiVar = (1 - a) * (p.sqiVar + a * dSqi * dSqi);

  const dMot = input.motion - p.motionMean;
  p.motionMean += a * dMot;
  p.motionVar = (1 - a) * (p.motionVar + a * dMot * dMot);

  p.samples++;
  const trust = clamp01(p.samples / BASE.WARMUP_SAMPLES);

  const qRel = relativePosition(input.sqi, p.sqiMean, p.sqiVar);
  const mRel = relativePosition(input.motion, p.motionMean, p.motionVar);
  p.qualityRelative = qRel;
  p.motionRelative = mRel;

  // --- ROI ---
  // Movimiento relativo alto → ROI más pequeña y centrada (menos borde/desliz).
  // Calidad relativa baja con poco movimiento → ROI más amplia para recuperar
  // fotones útiles y reencontrar la zona pulsátil.
  const shrink = mRel * trust;
  const expand = (1 - qRel) * (1 - mRel) * trust;
  const roiTarget =
    BASE.ROI_SCALE_MAX -
    shrink * (BASE.ROI_SCALE_MAX - BASE.ROI_SCALE_MIN) +
    expand * 0.0; // la expansión solo cancela el encogimiento, nunca supera el máximo
  p.roiScale += (clamp(roiTarget, BASE.ROI_SCALE_MIN, BASE.ROI_SCALE_MAX) - p.roiScale) * BASE.OUT_ALPHA;

  // --- BANDA DEL FILTRO ---
  // Con ritmo estimado fiable (periodicidad alta) la banda se estrecha alrededor
  // del armónico fundamental; con señal pobre o movimiento se ensancha para no
  // perder adaptación durante la readquisición.
  const fHr = input.bpm > 0 ? input.bpm / 60 : 0;
  const confidence = clamp01(input.periodicity) * qRel * trust;
  if (fHr > 0.6 && fHr < 4) {
    const lowTarget = clamp(fHr * (1 - 0.55 * confidence) * 0.75, BASE.BAND_LOW_MIN, BASE.BAND_LOW_MAX);
    const highTarget = clamp(
      fHr * (2.6 - 0.9 * confidence),
      BASE.BAND_HIGH_MIN,
      BASE.BAND_HIGH_MAX,
    );
    p.bandLowHz += (lowTarget - p.bandLowHz) * BASE.OUT_ALPHA;
    p.bandHighHz += (highTarget - p.bandHighHz) * BASE.OUT_ALPHA;
  } else {
    // Sin ritmo fiable: banda ancha (búsqueda) modulada por movimiento relativo.
    const lowTarget = BASE.BAND_LOW_MIN + mRel * 0.15;
    const highTarget = BASE.BAND_HIGH_MAX - mRel * 0.9;
    p.bandLowHz += (lowTarget - p.bandLowHz) * BASE.OUT_ALPHA;
    p.bandHighHz += (highTarget - p.bandHighHz) * BASE.OUT_ALPHA;
  }

  // --- HISTÉRESIS DE FUENTE ---
  // Señal inestable (calidad relativa baja o movimiento alto) → conmutar menos.
  const hystTarget =
    BASE.HYST_MIN_MS + (BASE.HYST_MAX_MS - BASE.HYST_MIN_MS) * clamp01(mRel * 0.6 + (1 - qRel) * 0.4);
  p.sourceHysteresisMs += (hystTarget - p.sourceHysteresisMs) * BASE.OUT_ALPHA;

  return p;
}
