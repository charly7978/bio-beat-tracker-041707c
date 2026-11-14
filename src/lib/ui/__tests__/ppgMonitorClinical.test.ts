import { describe, expect, it } from 'vitest';
import {
  bpZoneLabel,
  buildRhythmPanel,
  formatContactState,
  hrZoneLabel,
  ibiSegmentLabel,
  levelColor,
  spo2ZoneLabel,
} from '../ppgMonitorClinical';

describe('ppgMonitorClinical', () => {
  it('describe el rango del pulso sin afirmar un origen sinusal', () => {
    expect(hrZoneLabel(55).text).toBe('PULSO BAJO');
    expect(hrZoneLabel(72).level).toBe('normal');
    expect(hrZoneLabel(130).text).toBe('PULSO 121–150');
  });

  it('identifica rangos experimentales de SpO2 y PA', () => {
    expect(spo2ZoneLabel(96).text).toBe('EST. ≥95%');
    expect(bpZoneLabel(118, 76).text).toBe('EST. EN RANGO');
    expect(bpZoneLabel(145, 92).text).toBe('EST. ≥140/90');
  });

  it('formatea contacto y colores', () => {
    expect(formatContactState('STABLE_CONTACT')).toBe('CONTACTO ESTABLE');
    expect(levelColor('danger')).toBe('#ef4444');
  });

  it('detecta irregularidad RR y arritmia en panel', () => {
    expect(ibiSegmentLabel(1050, 800).level).toBe('danger');
    const panel = buildRhythmPanel('ARRITMIA DETECTADA', 2, [800, 620, 910], { sdnn: 85, rmssd: 42 });
    expect(panel.level).toBe('danger');
    expect(panel.title).toBe('IRREGULARIDAD DEL PULSO');
    expect(panel.guidance).toContain('no confirma');
    expect(panel.irregularityPct).toBeGreaterThan(0);
  });
  it('no declara regularidad antes de disponer de intervalos válidos', () => {
    const panel = buildRhythmPanel(undefined, 0, []);
    expect(panel.title).toBe('ESPERANDO INTERVALOS');
    expect(panel.level).toBe('dim');
    expect(panel.irregularityPct).toBeNull();
    expect(buildRhythmPanel('APRENDIENDO', 0, [800, 805, 795]).level).toBe('dim');
  });

  it('describe intervalos estables sin afirmar ritmo sinusal', () => {
    const panel = buildRhythmPanel(undefined, 0, [800, 805, 795, 802]);
    expect(panel.title).toBe('INTERVALOS DEL PULSO ESTABLES');
    expect(panel.guidance).toContain('no equivale a ritmo sinusal');
  });
});
