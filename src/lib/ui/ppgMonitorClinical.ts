/**
 * Etiquetas de presentación del pulso óptico; no acreditan diagnósticos ECG.
 */
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { isPhysiologicalRR, calculateHRV } from '@/utils/physio';

export type ClinicalLevel = 'normal' | 'warn' | 'danger' | 'dim';

export interface ClinicalLabel {
  text: string;
  level: ClinicalLevel;
}

const HR = VITAL_THRESHOLDS.HR;
const SPO2 = VITAL_THRESHOLDS.SPO2;

export function hrZoneLabel(bpm: number): ClinicalLabel {
  if (bpm <= 0) return { text: '—', level: 'dim' };
  if (bpm < 50) return { text: 'PULSO MUY BAJO', level: 'danger' };
  if (bpm < 60) return { text: 'PULSO BAJO', level: 'warn' };
  if (bpm <= 100) return { text: 'PULSO 60–100', level: 'normal' };
  if (bpm <= 120) return { text: 'PULSO 101–120', level: 'warn' };
  if (bpm <= 150) return { text: 'PULSO 121–150', level: 'danger' };
  return { text: 'PULSO >150', level: 'danger' };
}

export function spo2ZoneLabel(spo2: number): ClinicalLabel {
  if (spo2 <= 0) return { text: '—', level: 'dim' };
  if (spo2 >= 95) return { text: 'EST. ≥95%', level: 'normal' };
  if (spo2 >= 90) return { text: 'EST. 90–94%', level: 'warn' };
  if (spo2 >= 85) return { text: 'EST. 85–89%', level: 'danger' };
  return { text: 'EST. <85%', level: 'danger' };
}

export function bpZoneLabel(sys: number, dia: number): ClinicalLabel {
  if (sys <= 0 || dia <= 0) return { text: '—', level: 'dim' };
  if (sys >= 140 || dia >= 90) return { text: 'EST. ≥140/90', level: 'danger' };
  if (sys >= 130 || dia >= 80) return { text: 'EST. ≥130/80', level: 'warn' };
  if (sys < 90 || dia < 60) return { text: 'EST. <90/60', level: 'warn' };
  return { text: 'EST. EN RANGO', level: 'normal' };
}

export function formatContactState(state?: string): string {
  switch (state) {
    case 'STABLE_CONTACT':
      return 'CONTACTO ESTABLE';
    case 'UNSTABLE_CONTACT':
      return 'CONTACTO INESTABLE';
    case 'NO_CONTACT':
      return 'SIN CONTACTO';
    default:
      return state?.replace(/_/g, ' ') ?? '—';
  }
}

export function formatAcquisitionStatus(status?: string): string {
  if (!status) return '—';
  return status.replace(/_/g, ' ');
}

export function formatArrhythmiaStatus(status?: string, count = 0): string {
  if (!status || status === 'NORMAL' || status === 'SINUS_RHYTHM') {
    return count > 0 ? `PULSO · ${count} eventos marcados` : 'SIN EVENTOS MARCADOS';
  }
  return `${status.replace(/_/g, ' ')}${count > 0 ? ` · ${count}` : ''}`;
}

export function levelColor(level: ClinicalLevel): string {
  switch (level) {
    case 'normal':
      return '#22c55e';
    case 'warn':
      return '#f59e0b';
    case 'danger':
      return '#ef4444';
    default:
      return 'rgba(148, 163, 184, 0.75)';
  }
}

export function isHrInRange(bpm: number): boolean {
  return bpm >= HR.MIN && bpm <= HR.MAX;
}

export function isSpo2InRange(spo2: number): boolean {
  return spo2 >= SPO2.MIN_VALID && spo2 <= SPO2.MAX_VALID;
}

export interface RhythmPanelInfo {
  title: string;
  detail: string;
  guidance: string;
  level: ClinicalLevel;
  irregularityPct: number | null;
}

export function buildRhythmPanel(
  arrhythmiaStatus: string | undefined,
  count: number,
  rrIntervals: number[],
  hrv?: { sdnn: number; rmssd: number },
): RhythmPanelInfo {
  const hrvMetrics = calculateHRV(rrIntervals);
  const irr = hrvMetrics.cv > 0 ? Math.round(hrvMetrics.cv * 100) : null;
  // Calibrando o aprendiendo el ritmo (warm-up): el panel no alerta.
  const calibrating =
    arrhythmiaStatus?.includes('CALIBRANDO') || arrhythmiaStatus?.includes('APRENDIENDO');
  // VEREDICTO ÚNICO = ArrhythmiaProcessor. El panel SOLO refleja su frase exacta
  // 'ARRITMIA DETECTADA' (que pasa por warm-up, deadband y confirmación temporal).
  // NO se detecta por CV-RR aquí (eso saltaba TODO el pipeline → falsos positivos).
  // El CV-RR (irr) queda solo como referencia informativa.
  const detected = !calibrating && !!arrhythmiaStatus?.includes('ARRITMIA DETECTADA');

  const hrvLine =
    hrv && hrv.sdnn > 0
      ? `SDNN ${hrv.sdnn} ms · RMSSD ${hrv.rmssd > 0 ? hrv.rmssd : '—'} ms`
      : '';

  if (detected) {
    return {
      title: 'IRREGULARIDAD DEL PULSO',
      detail: [
        count > 0 ? `${count} latido(s) marcado(s)` : null,
        irr !== null ? `CV-IBI ${irr}%` : null,
        hrvLine || null,
      ]
        .filter(Boolean)
        .join(' · '),
      guidance:
        'Intervalos marcados por el detector. La PPG no confirma una arritmia; requiere evaluación con ECG.',
      level: 'danger',
      irregularityPct: irr,
    };
  }

  if (calibrating || rrIntervals.filter(isPhysiologicalRR).length < 3) {
    return {
      title: 'ESPERANDO INTERVALOS',
      detail: 'Aún sin intervalos suficientes',
      guidance: 'Mantén un apoyo suave mientras se reúne señal válida.',
      level: 'dim',
      irregularityPct: null,
    };
  }

  if (irr !== null && irr >= 12) {
    return {
      title: 'PULSO CON VARIACIÓN',
      detail: `CV-IBI ${irr}% · ${hrvLine || 'variabilidad observada'}`,
      guidance: 'Variación de intervalos ópticos; no identifica el origen del ritmo.',
      level: 'warn',
      irregularityPct: irr,
    };
  }

  return {
    title: 'INTERVALOS DEL PULSO ESTABLES',
    detail: [irr !== null ? `CV-IBI ${irr}%` : null, hrvLine || null].filter(Boolean).join(' · ') || 'Intervalos estables',
    guidance: 'Periodos ópticos estables en esta ventana; no equivale a ritmo sinusal.',
    level: 'normal',
    irregularityPct: irr,
  };
}

export function ibiSegmentLabel(ibiMs: number, meanIbiMs?: number): ClinicalLabel {
  if (!isPhysiologicalRR(ibiMs)) return { text: '—', level: 'dim' };
  const ms = Math.round(ibiMs);
  if (!meanIbiMs || !isPhysiologicalRR(meanIbiMs)) {
    return { text: `${ms} ms`, level: 'normal' };
  }
  const diffPct = (Math.abs(ibiMs - meanIbiMs) / meanIbiMs) * 100;
  if (diffPct >= 25) return { text: `${ms} ms IRREG`, level: 'danger' };
  if (diffPct >= 15) return { text: `${ms} ms VAR`, level: 'warn' };
  return { text: `${ms} ms`, level: 'normal' };
}
