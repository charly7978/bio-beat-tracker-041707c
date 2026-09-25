import { median, percentile } from '../../utils/stats';


/**
 * MeasurementWindowValidator
 * ==========================
 * Puerta final de la ventana de medición. Recibe la ventana completa y decide
 * con análisis estadístico si los datos son lo bastante fiables para una fila
 * final de historial.
 *
 * HONESTIDAD TEMPORAL: los umbrales de cada vital se expresan en SEGUNDOS de
 * señal observada, no en conteo de frames. El tiempo efectivo se deriva de
 * `elapsedSeconds` (reloj de la sesión, preferido) o, en su defecto, de
 * `n / fpsMediano` observado. Contar 300 frames como "10 s" suponía 30 fps
 * fijos: a 15 fps reales, 300 frames son 20 s (y viceversa). Complejidad O(n).
 */

export interface VitalReadiness {
  hr: boolean;
  spo2: boolean;
  bp: boolean;
  respiration: boolean;
  arrhythmia: boolean;
}

export interface QualitySummary {
  sqiMedian: number;
  piMedian: number;
  fpsMedian: number;
  jitterMedian: number;
  motionP95: number;
  clippingRatio: number;
  validContactRatio: number;
  /** Segundos de señal observada que sustentan el veredicto. */
  observedSeconds: number;
}

export interface ValidationVerdict {
  accepted: boolean;
  vitalReadiness: VitalReadiness;
  rejectionReasons: string[];
  qualitySummary: QualitySummary;
}

export interface ValidationFrame {
  sqi: number;
  pi: number;
  fps: number;
  jitter: number;
  motion: number;
  isClipping: boolean;
  hasContact: boolean;
}

/** Duraciones mínimas de señal observada por vital (segundos). */
export const WINDOW_SECONDS = {
  /** Mínimo absoluto para CUALQUIER decisión. */
  MIN_ANY: 10,
  /** SpO₂ hereda el mínimo de HR (mismo pulsátil) sin extra temporal. */
  MIN_SPO2: 10,
  /** PA por morfología PPG: necesita más ciclos para promediar forma. */
  MIN_BP: 20,
  /** Respiración (0.08–0.55 Hz): varios ciclos respiratorios. */
  MIN_RESP: 30,
  /** Arritmia por RR: ventana suficiente para análisis de intervalos. */
  MIN_ARRHYTHMIA: 40,
} as const;

export class MeasurementWindowValidator {
  /**
   * Valida una ventana de frames contra umbrales de calidad y duración real.
   *
   * @param frames frames acumulados de la sesión (calidad/contacto por frame).
   * @param elapsedSeconds segundos de reloj de la sesión (preferido). Si se
   *   omite o no es finito, se estima como n / fpsMediano observado.
   */
  public static validate(frames: ValidationFrame[], elapsedSeconds?: number): ValidationVerdict {
    const reasons: string[] = [];
    const n = frames.length;

    if (n < 30) { // Mínimo absoluto de evidencia, independiente del reloj.
      return {
        accepted: false,
        vitalReadiness: { hr: false, spo2: false, bp: false, respiration: false, arrhythmia: false },
        rejectionReasons: ["Evidencia insuficiente (< 30 frames)"],
        qualitySummary: this.emptySummary()
      };
    }

    const sqis = new Float32Array(n);
    const pis = new Float32Array(n);
    const fpss = new Float32Array(n);
    const jitters = new Float32Array(n);
    const motions = new Float32Array(n);
    let clippingCount = 0;
    let contactCount = 0;

    for (let i = 0; i < n; i++) {
      sqis[i] = frames[i].sqi;
      pis[i] = frames[i].pi;
      fpss[i] = frames[i].fps;
      jitters[i] = frames[i].jitter;
      motions[i] = frames[i].motion;
      if (frames[i].isClipping) clippingCount++;
      if (frames[i].hasContact) contactCount++;
    }

    const sqiMedian = median(sqis);
    const piMedian = median(pis);
    const fpsMedian = median(fpss);
    const jitterMedian = median(jitters);
    const motionP95 = percentile(motions, 95);
    const clippingRatio = clippingCount / n;
    const validContactRatio = contactCount / n;

    // Duración observada: reloj de sesión si existe, si no n/fps observado.
    // Nunca se supone un FPS nominal: a FPS bajo, los mismos frames valen
    // MÁS segundos (y el gate de duración lo refleja).
    const fpsForTime = fpsMedian > 0 && Number.isFinite(fpsMedian) ? fpsMedian : 30;
    const observedSeconds =
      typeof elapsedSeconds === 'number' && Number.isFinite(elapsedSeconds) && elapsedSeconds >= 0
        ? elapsedSeconds
        : n / fpsForTime;

    if (observedSeconds < WINDOW_SECONDS.MIN_ANY) {
      return {
        accepted: false,
        vitalReadiness: { hr: false, spo2: false, bp: false, respiration: false, arrhythmia: false },
        rejectionReasons: [`Sesión demasiado corta (${observedSeconds.toFixed(1)} s < ${WINDOW_SECONDS.MIN_ANY} s)`],
        qualitySummary: {
          sqiMedian,
          piMedian,
          fpsMedian,
          jitterMedian,
          motionP95,
          clippingRatio,
          validContactRatio,
          observedSeconds,
        }
      };
    }

    // Puertas de calidad + duración real por vital.
    const hrReady = sqiMedian >= 45 && validContactRatio > 0.8 && observedSeconds >= WINDOW_SECONDS.MIN_ANY;
    const spo2Ready = hrReady && piMedian >= 0.005 && clippingRatio < 0.05 && observedSeconds >= WINDOW_SECONDS.MIN_SPO2;
    const bpReady = spo2Ready && observedSeconds >= WINDOW_SECONDS.MIN_BP;
    const respReady = hrReady && observedSeconds >= WINDOW_SECONDS.MIN_RESP;
    const arrhythmiaReady = hrReady && observedSeconds >= WINDOW_SECONDS.MIN_ARRHYTHMIA;

    if (sqiMedian < 30) reasons.push("Calidad de señal insuficiente (SQI mediano bajo)");
    if (validContactRatio < 0.75) reasons.push("Contacto de dedo inestable durante la sesión");
    if (fpsMedian < 24) reasons.push("Rendimiento del dispositivo bajo (FPS < 24)");
    if (motionP95 > 0.4) reasons.push("Exceso de movimiento detectado");
    if (clippingRatio > 0.15) reasons.push("Saturación de sensor detectada (clipping)");

    const accepted = reasons.length === 0 && (hrReady || spo2Ready);

    return {
      accepted,
      vitalReadiness: {
        hr: hrReady,
        spo2: spo2Ready,
        bp: bpReady,
        respiration: respReady,
        arrhythmia: arrhythmiaReady
      },
      rejectionReasons: reasons,
      qualitySummary: {
        sqiMedian,
        piMedian,
        fpsMedian,
        jitterMedian,
        motionP95,
        clippingRatio,
        validContactRatio,
        observedSeconds
      }
    };
  }

  private static emptySummary(): QualitySummary {
    return { sqiMedian: 0, piMedian: 0, fpsMedian: 0, jitterMedian: 0, motionP95: 0, clippingRatio: 0, validContactRatio: 0, observedSeconds: 0 };
  }
}
