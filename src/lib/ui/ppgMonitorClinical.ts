/**
 * Etiquetas y umbrales de rango para el monitor PPG (solo presentación).
 *
 * Pulso (HR): temporización de latidos medida → descriptores de zona estándar.
 * SpO2/PA: ESTIMACIONES experimentales de cámara → etiquetas de RANGO neutras
 * (nunca diagnósticas: sin NORMOXIA/HIPOXEMIA/HIPERTENSIÓN). El sufijo EXP.
 * recuerda el origen en cada superficie que las use.
 */
import { isPhysiologicalRR, calculateHRV } from '@/utils/physio';

export type ClinicalLevel = 'normal' | 'warn' | 'danger' | 'dim';

export interface ClinicalLabel {
  text: string;
  level: ClinicalLevel;
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
      title: 'ARRITMIA / RITMO IRREGULAR',
      detail: [
        count > 0 ? `${count} latido(s) marcado(s)` : null,
        irr !== null ? `CV-RR ${irr}% (referencia alerta ≥20%)` : null,
        hrvLine || null,
      ]
        .filter(Boolean)
        .join(' · '),
      guidance:
        'Segmentos en rojo = intervalos anómalos. Confirmar con ECG de 12 derivaciones si persiste.',
      level: 'danger',
      irregularityPct: irr,
    };
  }

  if (irr !== null && irr >= 12) {
    return {
      title: 'RITMO SINUSAL CON VARIACIÓN',
      detail: `CV-RR ${irr}% · ${hrvLine || 'variabilidad fisiológica'}`,
      guidance: 'Vigilar tendencia; aún sin criterio de arritmia sostenida.',
      level: 'warn',
      irregularityPct: irr,
    };
  }

  return {
    title: 'RITMO SINUSAL REGULAR',
    detail: [irr !== null ? `CV-RR ${irr}%` : null, hrvLine || null].filter(Boolean).join(' · ') || 'Intervalos estables',
    guidance: 'Morfología PPG coherente con pulso periódico.',
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
