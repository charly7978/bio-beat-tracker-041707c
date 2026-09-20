/**
 * Suavizado EMA adaptativo y lógica de display hold para signos vitales.
 *
 * Extraído de VitalSignsProcessor para reducir su tamaño y permitir testeo
 * unitario del suavizado independientemente del pipeline completo.
 *
 * - EMA adaptativo con detección de outliers (cambios bruscos → alpha menor)
 *   — el cálculo de alpha vive en `adaptiveEma.ts` (fuente de verdad compartida
 *   con la capa UI en `src/lib/measurement/displaySmoothing.ts`).
 * - Display hold: mantiene el último valor válido cuando el gate baja
 *   temporalmente, evitando parpadeo en la UI.
 */

import {
  computeAdaptiveAlpha,
  clampAlpha,
  emaBlend,
  PROCESSOR_EMA_PARAMS,
  PROCESSOR_EMA_BASE,
} from '../../lib/measurement/adaptiveEma';

export class DisplaySmoothing {
  // Estado del display hold
  private holdSpO2 = 0;
  private holdSystolic = 0;
  private holdDiastolic = 0;
  private missedFrames = 0;
  private readonly DISPLAY_HOLD_MAX_FRAMES = 240;

  /**
   * Suavizado EMA adaptativo — cambios grandes trackean rápido, cambios
   * pequeños se suavizan (opuesto a la detección de outliers clásica que
   * frena ante cambios bruscos). Para signos vitales en cámara PPG los
   * cambios grandes suelen ser eventos reales (arritmia, desaturación) que
   * necesitan seguimiento rápido, mientras que el ruido de baja amplitud
   * debe ser suavizado.
   * - 'stable': para valores que cambian lentamente (SpO2, PA)
   * - 'dynamic': para valores más variables
   */
  smoothValue(current: number, newVal: number, type: 'stable' | 'dynamic' = 'stable'): number {
    if (current === 0 || isNaN(current) || !isFinite(current)) return newVal;
    if (isNaN(newVal) || !isFinite(newVal)) return current;

    const baseAlpha = type === 'stable' ? PROCESSOR_EMA_BASE.stable : PROCESSOR_EMA_BASE.dynamic;
    const relativeChange = Math.abs(newVal - current) / (Math.abs(current) + 0.01);

    const alpha = clampAlpha(
      computeAdaptiveAlpha(relativeChange, baseAlpha, PROCESSOR_EMA_PARAMS),
      0.05,
      0.5,
    );
    return emaBlend(current, newVal, alpha);
  }

  /**
   * Suavizado EMA adaptativo ponderado por confianza del frame.
   * weight en [0..1] penaliza o beneficia la velocidad de actualización.
   */
  smoothWeightedValue(
    current: number,
    newVal: number,
    weight: number,
    type: 'stable' | 'dynamic' = 'stable',
  ): number {
    if (current === 0 || isNaN(current) || !isFinite(current)) return newVal;
    if (isNaN(newVal) || !isFinite(newVal)) return current;

    const baseAlpha = type === 'stable' ? PROCESSOR_EMA_BASE.stable : PROCESSOR_EMA_BASE.dynamic;
    const relativeChange = Math.abs(newVal - current) / (Math.abs(current) + 0.01);

    const w = Math.max(0, Math.min(1, weight));
    const alpha = clampAlpha(
      computeAdaptiveAlpha(relativeChange, baseAlpha, PROCESSOR_EMA_PARAMS) * (0.15 + 0.85 * w),
      0.015,
      0.5,
    );
    return emaBlend(current, newVal, alpha);
  }

  /**
   * Actualiza el display hold de SpO2. Devuelve el valor a mostrar.
   * Congela el último valor válido cuando el gate baja temporalmente.
   */
  updateSpO2Hold(spo2Value: number, gateActive: boolean): number {
    if (gateActive && spo2Value >= 70 && spo2Value <= 100) {
      this.holdSpO2 = spo2Value;
      this.missedFrames = 0;
    } else if (this.holdSpO2 > 0) {
      this.missedFrames++;
      if (
        spo2Value > 0 &&
        Math.abs(spo2Value - this.holdSpO2) / Math.max(1, this.holdSpO2) > 0.015
      ) {
        this.holdSpO2 = spo2Value;
        this.missedFrames = 0;
      }
    }

    const holdActive = this.missedFrames < this.DISPLAY_HOLD_MAX_FRAMES;
    const shown = gateActive && spo2Value > 0
      ? spo2Value
      : holdActive && this.holdSpO2 > 0
        ? this.holdSpO2
        : 0;
    return shown >= 70 && shown <= 100 ? shown : 0;
  }

  /**
   * Actualiza el display hold de presión arterial. Devuelve {systolic, diastolic}.
   */
  updateBPHold(sysValue: number, diaValue: number, gateActive: boolean): { systolic: number; diastolic: number } {
    if (gateActive && sysValue > 0 && diaValue > 0) {
      this.holdSystolic = sysValue;
      this.holdDiastolic = diaValue;
      this.missedFrames = 0;
    } else if (this.holdSystolic > 0 && sysValue > 0) {
      const sysDrift = Math.abs(sysValue - this.holdSystolic) / Math.max(1, this.holdSystolic);
      const diaDrift = Math.abs(diaValue - this.holdDiastolic) / Math.max(1, this.holdDiastolic);
      if (sysDrift > 0.02 || diaDrift > 0.02) {
        this.holdSystolic = sysValue;
        this.holdDiastolic = diaValue;
        this.missedFrames = 0;
      }
    }

    const holdActive = this.missedFrames < this.DISPLAY_HOLD_MAX_FRAMES;
    return {
      systolic: gateActive && sysValue > 0 ? sysValue : (holdActive && this.holdSystolic > 0 ? this.holdSystolic : 0),
      diastolic: gateActive && diaValue > 0 ? diaValue : (holdActive && this.holdDiastolic > 0 ? this.holdDiastolic : 0),
    };
  }

  reset(): void {
    this.holdSpO2 = 0;
    this.holdSystolic = 0;
    this.holdDiastolic = 0;
    this.missedFrames = 0;
  }
}
