export type ContactState = 'NO_CONTACT' | 'UNSTABLE_CONTACT' | 'STABLE_CONTACT';

export type FingerPlacementMode = 'tip' | 'pad' | 'hybrid';

export interface ProcessedSignal {
  timestamp: number;
  rawValue: number;
  filteredValue: number;
  /** SeÃ±al verde suavizada para morfologÃ­a PA (menos AGC que HR) */
  morphologyValue?: number;
  /** Canal 3 del banco de filtros: morfologÃ­a con Bessel de fase lineal (preserva fiduciales) */
  morphologyFiltered?: number;
  /** Canal 4 del banco de filtros: seÃ±al de modulaciÃ³n lenta para estimaciÃ³n de FR */
  respirationFiltered?: number;
  /** Canal 5 del banco de filtros: seÃ±al limpia para detecciÃ³n de intervalos RR / arritmias */
  arrhythmiaFiltered?: number;
  /** Canal 2 del banco de filtros: componentes AC y DC separados por canal para ratio SpO2 */
  spo2Channels?: {
    acRed: number;
    dcRed: number;
    acGreen: number;
    dcGreen: number;
    acBlue?: number;
    dcBlue?: number;
  };
  placementMode?: FingerPlacementMode;
  quality: number;
  fingerDetected: boolean;
  contactState: ContactState;
  motionArtifact?: boolean;
  roi: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  perfusionIndex?: number;
  rawRed?: number;
  rawGreen?: number;
  rawBlue?: number;
  /**
   * RespiraciÃ³n derivada del acelerÃ³metro (IMU), modalidad NO-Ã³ptica que se
   * fusiona con las Ã³pticas (RIAV/RIIV/RIFV) en la Smart Fusion respiratoria.
   * Pre-estimada en el procesador porque vive con el listener DeviceMotion.
   */
  accelRespiration?: { rpm: number; quality: number };
  diagnostics?: {
    message: string;
    hasPulsatility: boolean;
    pulsatilityValue: number;
    /** Cobertura del ROI por tiles â€œdedoâ€ (0â€“1) */
    coverageRatio?: number;
    placementMode?: FingerPlacementMode;
    placementHint?: string;
    /**
     * Evidencia física de colocación (presión/ubicación/movimiento/pulso).
     * Es la ÚNICA fuente de presión: el modelo fisiológico canónico vive en
     * `src/lib/pressure/transmuralPressureModel.ts` y `fingerPlacementEvidence`
     * lo agrega con la colocación; no se admite un campo de presión paralelo.
     */
    placementEvidence?: import('../lib/finger/fingerPlacementEvidence').FingerPlacementEvidence;
    status?: import('./measurements').MeasurementStatus;
    sqm?: Partial<import('./measurements').SignalQualityMetrics>;
    /** Estado de la estabilizaciÃ³n de adquisiciÃ³n (fase inicial de colocaciÃ³n). */
    acquisitionStage?: import('../lib/acquisition/AcquisitionStabilizer').AcquisitionStage;
    /** Confianza de adquisiciÃ³n suavizada [0..1]. */
    acquisitionConfidence?: number;
    /** Progreso monÃ³tono de estabilizaciÃ³n [0..1] para la UI. */
    acquisitionProgress?: number;
  };
}

export interface ProcessingError {
  code: string;
  message: string;
  timestamp: number;
}

export interface SignalProcessor {
  initialize: () => Promise<void>;
  start: () => void;
  stop: () => void;
  calibrate: () => Promise<boolean>;
  onSignalReady?: (signal: ProcessedSignal) => void;
  onError?: (error: ProcessingError) => void;
}
