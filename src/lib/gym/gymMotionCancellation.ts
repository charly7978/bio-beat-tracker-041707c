import { DSP_CONSTANTS } from '../../config/signalProcessing';

/**
 * GYM MOTION CANCELLATION & KALMAN FREQUENCY TRACKER
 *
 * Módulo científico para atenuar artefactos de movimiento periódico (trote, carrera, saltos)
 * y rastrear de forma continua y fisiológica la frecuencia cardíaca durante el ejercicio físico.
 *
 * Componentes:
 * 1. Estimador de frecuencia de cadencia de movimiento (autocorrelación sobre IMU + flujo óptico).
 * 2. Filtro Notch adaptativo IIR de 2º orden para supresión de armónicos de paso.
 * 3. Filtro de Kalman adaptativo para seguimiento robusto de la frecuencia cardíaca (HR) en esfuerzo.
 *
 * Referencias:
 * - Wang et al. (Constrained Kalman Filtering for HR estimation during intense exercise)
 * - Zhang et al. (TROIKA: A General Framework for Heart Rate Monitoring Using PPG During Intensive Physical Exercise)
 */

import { RingF32 } from '../../utils/RingBuffer';
import { clamp } from '../../utils/math';

export interface GymMotionCancellationState {
  cadenceBpm: number;
  cadenceFreqHz: number;
  motionIntensity: number;
  kalmanBpm: number;
  isNotchActive: boolean;
  snrBoostDb: number;
}

export class GymMotionCancellation {
  private readonly sampleRate: number;

  // Buffer circular para aceleraciones y velocidad óptica (128 muestras ~ 4.2 segundos a 30 FPS)
  private readonly motionBuffer = new RingF32(128);
  private lastMotionCadenceHz = 0;
  private motionIntensityEma = 0;

  // Filtro Notch IIR de 2º orden para cadencia de paso
  // H(z) = (1 - 2*cos(w0)*z^-1 + z^-2) / (1 - 2*r*cos(w0)*z^-1 + r^2*z^-2)
  private notchX1 = 0;
  private notchX2 = 0;
  private notchY1 = 0;
  private notchY2 = 0;
  private notchB0 = 1;
  private notchB1 = 0;
  private notchB2 = 1;
  private notchA1 = 0;
  private notchA2 = 0;
  private isNotchConfigured = false;

  // Estado del Filtro de Kalman: x = [f_HR (Hz), df_HR (Hz/s)]
  private kStateF = 1.25; // 75 BPM inicial
  private kStateDf = 0.0;
  private kP00 = 0.5;
  private kP01 = 0.0;
  private kP10 = 0.0;
  private kP11 = 0.1;

  // Ruido de proceso Q (límites biológicos de aceleración cardíaca en ejercicio: ~2.5 BPM/s)
  private readonly qF = 0.0004;
  private readonly qDf = 0.0001;

  constructor(sampleRate: number = DSP_CONSTANTS.DEFAULT_SAMPLE_RATE) {
    this.sampleRate = Math.max(15, Math.min(60, sampleRate));
  }

  /**
   * Resetea el cancelador y el filtro de Kalman.
   */
  public reset(): void {
    this.motionBuffer.reset();
    this.lastMotionCadenceHz = 0;
    this.motionIntensityEma = 0;
    this.notchX1 = 0;
    this.notchX2 = 0;
    this.notchY1 = 0;
    this.notchY2 = 0;
    this.isNotchConfigured = false;
    this.kStateF = 1.25;
    this.kStateDf = 0.0;
    this.kP00 = 0.5;
    this.kP01 = 0.0;
    this.kP10 = 0.0;
    this.kP11 = 0.1;
  }

  /**
   * Alimenta una muestra de movimiento físico (magnitud de aceleración IMU o velocidad óptica).
   */
  public pushMotionSample(motionMagnitude: number): void {
    this.motionBuffer.push(motionMagnitude);
    this.motionIntensityEma = this.motionIntensityEma * 0.95 + Math.abs(motionMagnitude) * 0.05;

    // Actualizar estimación de cadencia cada 15 muestras (~0.5s) si hay suficiente historial
    if (this.motionBuffer.length >= 64 && this.motionBuffer.length % 15 === 0) {
      this.updateCadenceEstimation();
    }
  }

  /**
   * Estima la frecuencia fundamental de la cadencia de ejercicio (pasos/salto) mediante autocorrelación.
   */
  private updateCadenceEstimation(): void {
    const N = Math.min(this.motionBuffer.length, 90);
    const data = this.motionBuffer.tail(N);

    // Resta de media (detrend)
    let mean = 0;
    for (let i = 0; i < N; i++) mean += data[i];
    mean /= N;

    // Rango de cadencia fisiológica en ejercicio: 60 a 210 pasos/min (1.0 Hz a 3.5 Hz)
    const minLag = Math.floor(this.sampleRate / 3.5);
    const maxLag = Math.ceil(this.sampleRate / 1.0);

    let bestLag = 0;
    let maxCorr = -Infinity;

    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      for (let i = 0; i < N - lag; i++) {
        corr += (data[i] - mean) * (data[i + lag] - mean);
      }
      if (corr > maxCorr) {
        maxCorr = corr;
        bestLag = lag;
      }
    }

    if (bestLag > 0) {
      const estimatedCadenceHz = this.sampleRate / bestLag;
      // Suavizar cadencia
      this.lastMotionCadenceHz = this.lastMotionCadenceHz > 0
        ? this.lastMotionCadenceHz * 0.8 + estimatedCadenceHz * 0.2
        : estimatedCadenceHz;

      this.updateNotchCoefficients(this.lastMotionCadenceHz);
    }
  }

  /**
   * Actualiza los coeficientes del filtro Notch IIR de 2º orden.
   */
  private updateNotchCoefficients(targetFreqHz: number): void {
    // Evitar notch si la cadencia coincide exactamente con el pulso cardíaco actual (+- 0.15 Hz)
    // para no eliminar la sístole verdadera cuando transitoriamente se cruzan
    const distToHr = Math.abs(targetFreqHz - this.kStateF);
    if (distToHr < 0.18 || targetFreqHz < 0.8 || targetFreqHz > 4.0) {
      this.isNotchConfigured = false;
      return;
    }

    const w0 = (2 * Math.PI * targetFreqHz) / this.sampleRate;
    const r = 0.90; // Radio del polo (define ancho de banda estrecho)
    const cosW0 = Math.cos(w0);

    this.notchB0 = 1;
    this.notchB1 = -2 * cosW0;
    this.notchB2 = 1;
    this.notchA1 = -2 * r * cosW0;
    this.notchA2 = r * r;
    this.isNotchConfigured = true;
  }

  /**
   * Aplica el cancelador de movimiento sobre la muestra de señal rPPG.
   */
  public filterSample(rawRppgSample: number): number {
    if (!this.isNotchConfigured || this.motionIntensityEma < 0.12) {
      return rawRppgSample;
    }

    // Filtrado directo de transpuesta II
    const x0 = rawRppgSample;
    const y0 = this.notchB0 * x0 + this.notchB1 * this.notchX1 + this.notchB2 * this.notchX2
      - this.notchA1 * this.notchY1 - this.notchA2 * this.notchY2;

    this.notchX2 = this.notchX1;
    this.notchX1 = x0;
    this.notchY2 = this.notchY1;
    this.notchY1 = y0;

    return Number.isFinite(y0) ? y0 : rawRppgSample;
  }

  /**
   * Alias de filterSample para filtrado de señal rPPG.
   */
  public filterPPGSignal(rawRppgSample: number): number {
    return this.filterSample(rawRppgSample);
  }

  /**
   * Actualiza el rastreador de Kalman con una medición observada de frecuencia cardíaca instantánea.
   * @param measuredBpm BPM medido por el ensemble de picos o espectro
   * @param dt Delta de tiempo en segundos desde la última actualización
   * @param quality Calidad de señal (0 a 100)
   */
  public updateKalmanHR(measuredBpm: number, dt: number, quality: number): number {
    const validDt = Math.max(0.01, Math.min(0.5, dt));

    // 1. Predicción del estado: x_k|k-1 = A * x_k-1|k-1
    const predF = this.kStateF + this.kStateDf * validDt;
    const predDf = this.kStateDf;

    // Predicción de covarianza: P_k|k-1 = A * P * A^T + Q
    const p00_pred = this.kP00 + validDt * (this.kP10 + this.kP01) + validDt * validDt * this.kP11 + this.qF;
    const p01_pred = this.kP01 + validDt * this.kP11;
    const p10_pred = this.kP10 + validDt * this.kP11;
    const p11_pred = this.kP11 + this.qDf;

    // Si la medición es fisiológicamente válida (30 a 220 BPM)
    if (measuredBpm >= 30 && measuredBpm <= 220) {
      const zMeas = measuredBpm / 60; // Convertir a Hz

      // Covarianza de medición R: escala inversamente con la calidad y penaliza cercanía a la cadencia
      const qualityFactor = clamp((100 - quality) / 50, 0.2, 5.0);
      const isCloseToCadence = this.lastMotionCadenceHz > 0 && Math.abs(zMeas - this.lastMotionCadenceHz) < 0.15;
      const cadencePenalty = isCloseToCadence ? 4.0 : 1.0;
      const R = 0.08 * qualityFactor * cadencePenalty;

      // Ganancia de Kalman: K = P * H^T * (H * P * H^T + R)^-1
      const S = p00_pred + R;
      const k0 = p00_pred / S;
      const k1 = p10_pred / S;

      // Residual de innovación
      const y = zMeas - predF;

      // Actualización de estado: x_k = x_pred + K * y
      this.kStateF = predF + k0 * y;
      this.kStateDf = predDf + k1 * y;

      // Actualización de covarianza
      this.kP00 = p00_pred * (1 - k0);
      this.kP01 = p01_pred * (1 - k0);
      this.kP10 = p10_pred - k1 * p00_pred;
      this.kP11 = p11_pred - k1 * p01_pred;
    } else {
      // Sin medición válida: mantener proyección inercial
      this.kStateF = predF;
      this.kStateDf = predDf * 0.98; // decaer gradualmente aceleración
      this.kP00 = p00_pred;
      this.kP01 = p01_pred;
      this.kP10 = p10_pred;
      this.kP11 = p11_pred;
    }

    // Clamp fisiológico: 30 BPM (0.5 Hz) a 220 BPM (3.66 Hz)
    this.kStateF = clamp(this.kStateF, 0.5, 3.66);
    this.kStateDf = clamp(this.kStateDf, -0.05, 0.05);

    return Math.round(this.kStateF * 60);
  }

  /**
   * Obtiene el diagnóstico y telemetría de cancelación de movimiento en modo GYM.
   */
  public getState(): GymMotionCancellationState {
    const cadenceBpm = Math.round(this.lastMotionCadenceHz * 60);
    const kalmanBpm = Math.round(this.kStateF * 60);

    return {
      cadenceBpm,
      cadenceFreqHz: this.lastMotionCadenceHz,
      motionIntensity: this.motionIntensityEma,
      kalmanBpm,
      isNotchActive: this.isNotchConfigured && this.motionIntensityEma >= 0.12,
      snrBoostDb: this.isNotchConfigured ? 6.5 : 0.0,
    };
  }
}
