/**
 * NEXUS FUSION CORE — Motor de fusión N-fuentes de presión arterial
 * =================================================================
 * Fusionado sobre un modelo de estado caminante x = [MAP, PP] en el marco
 * "trustworthy" de la literatura (npj Digital Medicine 2026, Towards
 * trustworthy AI-driven cuffless BP monitoring): cada fuente aporta su
 * propio estimado Y SU PROPIA incertidumbre, y la fusión pondera por
 * verosimilitud calibrada — nadie pesa por reputación, pesa por calidad.
 *
 * Fuentes contempladas (capítulo 7 de docs/nexus-vitals-blueprint.md):
 *  - PWA_WINDKESSEL  : motor físico PDA+Windkessel existente (pwaPhysiologicalBpEngine).
 *  - CROSS_SITE_PTT  : tiempo de tránsito cara→dedo (crossSiteTransitTime).
 *  - MLP_REGRESSOR   : regresor neuronal con procedencia verificada.
 *  - HRV_PROXY       : covariable de modulación barorregulatoria.
 *  - USER_REFERENCE  : referencia directa del tensiómetro del usuario.
 *
 * La relación de salida es la fisiológica estándar (coherente con el motor
 * actual): SBP = MAP + 2/3·PP, DBP = MAP − 1/3·PP; la banda p5–p95 dimana
 * de la covarianza del estado (σ combinada), nunca de una tabla fija.
 *
 * Módulo puro y sin estado global (instancias independientes por sesión).
 */

import { clamp } from '@/utils/math';
import {
  estimateCrossSiteTransitTime,
  type CrossSiteTimingOptions,
  type CrossSiteTimingResult,
} from './crossSiteTransitTime';
import {
  assessNexusCoherence,
  tauCvPercentFromBeats,
  type NexusCoherenceResult,
} from './nexusCoherence';

/** Z de una distribución normal para el intervalo p5–p95 (two-sided 90%). */
const Z_90 = 1.6449;

export type NexusSourceId =
  | 'PWA_WINDKESSEL'
  | 'CROSS_SITE_PTT'
  | 'MLP_REGRESSOR'
  | 'HRV_PROXY'
  | 'USER_REFERENCE';

export interface NexusBpObservation {
  source: NexusSourceId;
  /** Precisión media (mmHg) aportada por la fuente. */
  map: number;
  /** Presión de pulso (mmHg) aportada por la fuente. */
  pulsePressure: number;
  /** Varianza de MAP en mmHg² (σ²). */
  mapVariance: number;
  /** Varianza de PP en mmHg² (σ²). */
  pulsePressureVariance: number;
  /** Calidad 0–100 de la observación. */
  quality: number;
  /** Reloj real del estimador (ms desde epoch de la sesión). */
  timestampMs: number;
}

export interface NexusFusionBand {
  p5: number;
  p95: number;
}

export interface NexusFusionState {
  map: number | null;
  pulsePressure: number | null;
  systolic: number | null;
  diastolic: number | null;
  sbpBand: NexusFusionBand | null;
  dbpBand: NexusFusionBand | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  sourcesUsed: NexusSourceId[];
}

export interface NexusFusionRates {
  /** σ de paseo aleatorio de MAP (mmHg por sqrt de minuto). */
  mapSigmaPerSqrtMin: number;
  /** σ de paseo aleatorio de PP (mmHg por sqrt de minuto). */
  ppSigmaPerSqrtMin: number;
}

/** Ritmo fisiológico por defecto: la PA cambia ~1–2 mmHg/min bajo reposo. */
export const DEFAULT_FUSION_RATES: NexusFusionRates = {
  mapSigmaPerSqrtMin: 1.2,
  ppSigmaPerSqrtMin: 0.8,
};

/**
 * Coeficientes personales del modelo PTT↔PA (forma SBP ≈ k/τ² + c, Moens–Korteweg).
 * Sin calibración personal: valores prior de escala fisiológica y varianza alta.
 */
export interface PttPersonalModel {
  kSbpMmHgS2: number;
  cSbpMmHg: number;
  kDbpMmHgS2: number;
  cDbpMmHg: number;
  /** true si fue ajustado con referencias del usuario (baja varianza). */
  calibrated: boolean;
}

/** Prior sin calibración (varianza dominante): la fusión apenas confía en él.
 *  Unidades: k en mmHg·s², c en mmHg. Escala fisiológica para τ∈[0.1,0.35] s. */
export const UNCALIBRATED_PTT_MODEL: PttPersonalModel = {
  kSbpMmHgS2: 4.2,
  cSbpMmHg: 25,
  kDbpMmHgS2: 2.2,
  cDbpMmHg: 25,
  calibrated: false,
};

export interface CrossSiteTimingBundle {
  tauMs: number;
  quality: number;
  spectralCoherence: number;
  beatsAgreed: number;
  /** Coeficiente de variación del τ latido a latido, opcional. */
  tauCvPercent?: number;
}

/**
 * Mapea τ (s) a presión con el modelo de coeficientes aportado.
 * Forma clásica e inversa: mayor τ ⇒ menor rigidez ⇒ menor presión.
 */
export function pttModelToPressures(tauMs: number, model: PttPersonalModel): { sbp: number; dbp: number } {
  const tauSec = clamp(tauMs, 10, 900) / 1000;
  const inv2 = 1 / (tauSec * tauSec);
  return {
    sbp: model.kSbpMmHgS2 * inv2 + model.cSbpMmHg,
    dbp: model.kDbpMmHgS2 * inv2 + model.cDbpMmHg,
  };
}

/**
 * Construye la observación NEXUS de fuente CROSS_SITE_PTT a partir del paquete
 * del estimador. La varianza refleja calibración y calidad (nunca baja si el
 * usuario no calibró: es honestidad en formato estadístico).
 */
export function crossSiteObservationFromTiming(
  bundle: CrossSiteTimingBundle,
  model: PttPersonalModel,
  timestampMs: number,
): NexusBpObservation | null {
  if (!Number.isFinite(bundle.tauMs) || bundle.tauMs <= 0) return null;
  const { sbp, dbp } = pttModelToPressures(bundle.tauMs, model);
  const map = dbp + (sbp - dbp) / 3;
  const pp = sbp - dbp;
  // σ técnica del estimador de tránsito (mejora con calidad)…
  const sigmaTechnical = 8 + (100 - clamp(bundle.quality, 0, 100)) * 0.35;
  // …y barniz de calibración personal (sin calibrar aporta incertidumbre alta)
  const sigmaCalibration = model.calibrated ? 3 : 22;
  const sigmaSbp = Math.sqrt(sigmaTechnical * sigmaTechnical + sigmaCalibration * sigmaCalibration);
  const sigmaDbp = sigmaSbp * 0.8;
  // Propagación lineal (variables sqrt-sum Wiener-estándar):
  const sigmaPp = Math.sqrt(sigmaSbp * sigmaSbp + sigmaDbp * sigmaDbp);
  const sigmaMap = sigmaPp / 3;
  return {
    source: 'CROSS_SITE_PTT',
    map,
    pulsePressure: pp,
    mapVariance: sigmaMap * sigmaMap,
    pulsePressureVariance: sigmaPp * sigmaPp,
    quality: clamp(bundle.quality, 0, 100),
    timestampMs,
  };
}

/**
 * Construye la observación de la fuente PWA_WINDKESSEL a partir de un
 * estimado del motor existente (MAP/PP + calidad de features).
 */
export function pwaObservationFromEstimate(
  map: number,
  pulsePressure: number,
  featureQuality0to100: number,
  timestampMs: number,
): NexusBpObservation {
  const q = clamp(featureQuality0to100, 0, 100);
  const sigma = 3 + (100 - q) * 0.12; // 3 mmHg mejor caso → ~15 mmHg peor caso
  return {
    source: 'PWA_WINDKESSEL',
    map,
    pulsePressure,
    mapVariance: sigma * sigma,
    pulsePressureVariance: (sigma * 1.15) * (sigma * 1.15),
    quality: q,
    timestampMs,
  };
}

/**
 * Motor de fusión: filtrado de Kalman de dos estados ([MAP, PP]) con proceso
 * caminante (Q por minuto) y actualizaciones secuenciales por observación.
 */export class NexusFusionCore {
  private mapState: number | null = null;
  private ppState: number | null = null;
  private mapVar: number = Number.POSITIVE_INFINITY;
  private ppVar: number = Number.POSITIVE_INFINITY;
  private lastTimestampMs: number | null = null;
  private sourcesUsed = new Set<NexusSourceId>();

  constructor(private readonly rates: NexusFusionRates = DEFAULT_FUSION_RATES) {}

  reset(): void {
    this.mapState = null;
    this.ppState = null;
    this.mapVar = Number.POSITIVE_INFINITY;
    this.ppVar = Number.POSITIVE_INFINITY;
    this.lastTimestampMs = null;
    this.sourcesUsed = new Set();
  }

  /**
   * Aporta una observación de una fuente. Las varianzas inválidas o negativas
   * se descartan explícitamente (sin silenciosidad).
   */
  pushObservation(obs: NexusBpObservation): void {
    if (!Number.isFinite(obs.map) || !Number.isFinite(obs.pulsePressure)) return;
    if (!Number.isFinite(obs.mapVariance) || obs.mapVariance <= 0) return;
    if (!Number.isFinite(obs.pulsePressureVariance) || obs.pulsePressureVariance <= 0) return;

    // Proceso caminante desde la última actualización (σ² ∝ dt)
    if (this.lastTimestampMs !== null && this.mapState !== null && this.ppState !== null) {
      const dtMin = Math.max(0, (obs.timestampMs - this.lastTimestampMs) / 60000);
      if (Number.isFinite(dtMin)) {
        this.mapVar += this.rates.mapSigmaPerSqrtMin * this.rates.mapSigmaPerSqrtMin * dtMin;
        this.ppVar += this.rates.ppSigmaPerSqrtMin * this.rates.ppSigmaPerSqrtMin * dtMin;
      }
    }

    if (this.mapState === null || this.ppState === null) {
      // Inicialización: el estado arranca en la primera fuente fiable
      this.mapState = obs.map;
      this.ppState = obs.pulsePressure;
      this.mapVar = obs.mapVariance;
      this.ppVar = obs.pulsePressureVariance;
    } else {
      // Actualización secuencial por componente (independencia asumida y armada)
      const kMap = this.mapVar / (this.mapVar + obs.mapVariance);
      this.mapState += kMap * (obs.map - this.mapState);
      this.mapVar *= 1 - kMap;

      const kPp = this.ppVar / (this.ppVar + obs.pulsePressureVariance);
      this.ppState += kPp * (obs.pulsePressure - this.ppState);
      this.ppVar *= 1 - kPp;
    }

    this.lastTimestampMs = obs.timestampMs;
    this.sourcesUsed.add(obs.source);
  }

  /** Estado fusionado actual con banda p5–p95 y nivel de confianza. */
  getState(): NexusFusionState {
    if (this.mapState === null || this.ppState === null) {
      return {
        map: null,
        pulsePressure: null,
        systolic: null,
        diastolic: null,
        sbpBand: null,
        dbpBand: null,
        confidence: null,
        sourcesUsed: [...this.sourcesUsed],
      };
    }
    const map = this.mapState;
    const pp = Math.max(8, this.ppState); // PP fisiológicamente ≥ 8 mmHg en la fusión
    const systolic = map + (2 / 3) * pp;
    const diastolic = map - (1 / 3) * pp;

    const sigmaMap = Math.sqrt(this.mapVar);
    const sigmaPp = Math.sqrt(this.ppVar);
    // σ y = |a|·σx + combinación cuadrática (independencia): σ_SBP de a=(1, 2/3)
    const sigmaSbp = Math.sqrt(sigmaMap * sigmaMap + ((2 / 3) * sigmaPp) ** 2);
    const sigmaDbp = Math.sqrt(sigmaMap * sigmaMap + ((1 / 3) * sigmaPp) ** 2);

    const sbpBand: NexusFusionBand = {
      p5: systolic - Z_90 * sigmaSbp,
      p95: systolic + Z_90 * sigmaSbp,
    };
    const dbpBand: NexusFusionBand = {
      p5: diastolic - Z_90 * sigmaDbp,
      p95: diastolic + Z_90 * sigmaDbp,
    };

    const sbpWidth = sbpBand.p95 - sbpBand.p5;
    const dbpWidth = dbpBand.p95 - dbpBand.p5;
    const confidence: NexusFusionState['confidence'] =
      sbpWidth <= 18 && dbpWidth <= 15
        ? 'HIGH'
        : sbpWidth <= 30 && dbpWidth <= 24
          ? 'MEDIUM'
          : 'LOW';

    return {
      map,
      pulsePressure: pp,
      systolic,
      diastolic,
      sbpBand,
      dbpBand,
      confidence,
      sourcesUsed: [...this.sourcesUsed],
    };
  }
}

/**
 * PIPELINE NEXUS — composición completa de la fuente cross-site en una llamada:
 *  1) estimación τ (GCC-PHAT + pie de onda, crossSiteTransitTime),
 *  2) adjudicación de coherencia multisitio (nexusCoherence),
 *  3) si τ y coherencia son válidos → observación lista para `pushObservation`.
 *
 * Es la única ruta oficial por la que el tránsito cara→dedo entra a la fusión:
 * garantiza que la coherencia se declare SIEMPRE (sin atajos silenciosos) y
 * que un objetos INCOMPATIBLE jamás genere presión.
 */
export interface NexusPipelineInput {
  /** Serie proximal (cara, rPPG), misma línea de tiempo que la distal. */
  proximal: readonly number[];
  /** Serie distal (dedo, PPG con flash). */
  distal: readonly number[];
  /** Frecuencia de muestreo común (Hz). */
  sampleRateHz: number;
  /** Reloj real de la ventana (ms desde epoch de la sesión). */
  timestampMs: number;
  /** Frecuencia cardiaca estimada en el sitio proximal (opcional). */
  proximalBpm?: number;
  /** Frecuencia cardiaca estimada en el sitio distal (opcional). */
  distalBpm?: number;
  /** Picos proximal/distal del detector del llamador (opcional, activa pie de onda). */
  proximalPeakIndices?: readonly number[];
  distalPeakIndices?: readonly number[];
  /** Modelo personal PTT↔PA (falta → prior sin calibrar con varianza alta). */
  personalModel?: PttPersonalModel;
}

export interface NexusPipelineResult {
  timing: CrossSiteTimingResult;
  coherence: NexusCoherenceResult;
  /** null salvo que τ y coherencia sean válidos (accepted). */
  observation: NexusBpObservation | null;
}

export function deriveCrossSiteObservation(input: NexusPipelineInput): NexusPipelineResult {
  const options: CrossSiteTimingOptions = {
    sampleRateHz: input.sampleRateHz,
    proximalPeakIndices: input.proximalPeakIndices,
    distalPeakIndices: input.distalPeakIndices,
  };
  const timing = estimateCrossSiteTransitTime(input.proximal, input.distal, options);
  const tauCvPercent = timing.tauByBeatMs.length >= 2 ? tauCvPercentFromBeats(timing.tauByBeatMs) : undefined;
  const coherence = assessNexusCoherence({
    tauMs: timing.tauMs,
    proximalBpm: input.proximalBpm,
    distalBpm: input.distalBpm,
    spectralCoherence: timing.spectralCoherence,
    tauCvPercent,
  });

  let observation: NexusBpObservation | null = null;
  if (timing.tauMs !== null && coherence.level !== 'INCOMPATIBLE') {
    const quality = Math.min(timing.quality, coherence.score);
    observation = crossSiteObservationFromTiming(
      {
        tauMs: timing.tauMs,
        quality,
        spectralCoherence: timing.spectralCoherence,
        beatsAgreed: timing.beatsAgreed,
        tauCvPercent,
      },
      input.personalModel ?? UNCALIBRATED_PTT_MODEL,
      input.timestampMs,
    );
  }
  return { timing, coherence, observation };
}
