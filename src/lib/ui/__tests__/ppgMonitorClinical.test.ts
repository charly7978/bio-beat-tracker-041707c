import { describe, expect, it } from 'vitest';
import {
  buildRhythmPanel,
  formatContactState,
  ibiSegmentLabel,
  levelColor,
} from '../ppgMonitorClinical';

describe('ppgMonitorClinical', () => {
  it('formatea contacto y colores', () => {
    expect(formatContactState('STABLE_CONTACT')).toBe('CONTACTO ESTABLE');
    expect(levelColor('danger')).toBe('#ef4444');
  });

  it('detecta irregularidad RR y arritmia en panel', () => {
    expect(ibiSegmentLabel(1050, 800).level).toBe('danger');
    const panel = buildRhythmPanel('ARRITMIA DETECTADA', 2, [800, 620, 910], { sdnn: 85, rmssd: 42 });
    expect(panel.level).toBe('danger');
    expect(panel.title).toContain('ARRITMIA');
    expect(panel.irregularityPct).toBeGreaterThan(0);
  });
});
