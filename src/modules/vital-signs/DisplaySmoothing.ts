/**
 * Lógica de display hold para signos vitales; no aplica suavizado numérico.
 *
 * Extraído de VitalSignsProcessor para reducir su tamaño y permitir testeo
 * unitario del suavizado independientemente del pipeline completo.
 *
 * - Display hold: mantiene el último valor válido cuando el gate baja
 *   temporalmente, evitando parpadeo en la UI.
 */

export class DisplaySmoothing {
  // Estado del display hold
  private holdSpO2 = 0;
  private holdSystolic = 0;
  private holdDiastolic = 0;
  private missedFrames = 0;
  private readonly DISPLAY_HOLD_MAX_FRAMES = 240;

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
