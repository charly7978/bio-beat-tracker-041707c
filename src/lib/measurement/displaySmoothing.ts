/**
 * Suavizado adaptativo para displays en vivo (BPM, SpO2, PA).
 * Alphas bajos: responde sin congelar el número en pantalla.
 */
import { clamp } from '@/utils/math';
import type { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';
import { bpZoneLabel, hrZoneLabel, spo2ZoneLabel } from '@/lib/ui/ppgMonitorClinical';

/** Pesos de suavizado por vital (solo UI, no afecta guardado clínico). */
export const DISPLAY_SMOOTH_ALPHAS = {
  hr: 0.3,
  spo2: 0.3,
  bp: 0.3,
} as const;

export function smoothDisplayValue(
  prev: number,
  next: number,
  alpha: number = DISPLAY_SMOOTH_ALPHAS.hr,
): number {
  if (!Number.isFinite(next) || next <= 0) return 0;
  if (!Number.isFinite(prev) || prev <= 0) return next;
  return prev + (next - prev) * clamp(alpha, 0, 1);
}

export function smoothDisplayPair(
  prev: { systolic: number; diastolic: number },
  next: { systolic: number; diastolic: number },
  alpha: number = DISPLAY_SMOOTH_ALPHAS.bp,
): { systolic: number; diastolic: number } {
  return {
    systolic: smoothDisplayValue(prev.systolic, next.systolic, alpha),
    diastolic: smoothDisplayValue(prev.diastolic, next.diastolic, alpha),
  };
}

/** Mismo algoritmo para el canvas (PPGSignalMeter). */
export function lerpDisplayValue(
  cur: number,
  tgt: number,
  base: number,
): number {
  if (tgt <= 0) return smoothDisplayValue(cur, 0, base);
  if (cur <= 0) return tgt;
  return smoothDisplayValue(cur, tgt, base);
}

type DisplayField = 'heartRate' | 'spo2' | 'bloodPressure';
const ALL_FIELDS: readonly DisplayField[] = ['heartRate', 'spo2', 'bloodPressure'];
const WITHHELD = new Set(['LOW_SIGNAL_QUALITY', 'NO_VALID_SIGNAL', 'INSUFFICIENT_WINDOW', 'INVALID']);

/** One EMA per modality, advanced only by new accepted input, not render ticks. */
export class VitalDisplayFilter {
  private hr = 0;
  private spo2 = 0;
  private sys = 0;
  private dia = 0;

  reset(fields: readonly DisplayField[] = ALL_FIELDS): void {
    if (fields.includes('heartRate')) this.hr = 0;
    if (fields.includes('spo2')) this.spo2 = 0;
    if (fields.includes('bloodPressure')) this.sys = this.dia = 0;
  }

  update(raw: VitalSignsResult, fields: readonly DisplayField[] = ALL_FIELDS): VitalSignsResult {
    const shown = { ...raw };
    if (fields.includes('heartRate')) {
      const next = raw.heartRate.value;
      const valid = next !== null && Number.isFinite(next) && next > 0 && !WITHHELD.has(raw.heartRate.status);
      this.hr = valid
        ? hrZoneLabel(this.hr).text !== hrZoneLabel(next).text ? next : smoothDisplayValue(this.hr, next)
        : 0;
      shown.heartRate = { ...raw.heartRate, value: next === null ? null : valid ? Math.round(this.hr) : 0 };
    }
    if (fields.includes('spo2')) {
      const next = raw.spo2.value;
      const valid = next !== null && Number.isFinite(next) && next > 0 && !WITHHELD.has(raw.spo2.status);
      this.spo2 = valid
        ? spo2ZoneLabel(this.spo2).text !== spo2ZoneLabel(next).text ? next : smoothDisplayValue(this.spo2, next)
        : 0;
      shown.spo2 = { ...raw.spo2, value: next === null ? null : valid ? Math.round(this.spo2) : 0 };
    }
    if (fields.includes('bloodPressure')) {
      const next = raw.bloodPressure.value;
      const valid = next !== null && Number.isFinite(next.systolic) && Number.isFinite(next.diastolic)
        && next.systolic > 0 && next.diastolic > 0 && !WITHHELD.has(raw.bloodPressure.status);
      if (valid) {
        const crossing = bpZoneLabel(this.sys, this.dia).text !== bpZoneLabel(next.systolic, next.diastolic).text;
        this.sys = crossing ? next.systolic : smoothDisplayValue(this.sys, next.systolic);
        this.dia = crossing ? next.diastolic : smoothDisplayValue(this.dia, next.diastolic);
      } else {
        this.sys = this.dia = 0;
      }
      shown.bloodPressure = { ...raw.bloodPressure, value: next === null ? null : {
        systolic: Math.round(this.sys), diastolic: Math.round(this.dia),
      } };
    }
    return shown;
  }
}
