import { describe, it, expect, beforeEach } from 'vitest';
import {
  CalibrationManager,
  NEXUS_CALIBRATION_PAIRS_KEY,
} from '../CalibrationManager';
import { fitPttPersonalModel, type NexusCalibrationPair } from '@/lib/vitals/nexusCalibrationFit';
import { UNCALIBRATED_PTT_MODEL } from '@/lib/vitals/nexusFusionCore';

/** Fabrica pares analíticos sobre SBP = k/τ² + c para el fit (fina jeringa). */
function analyticPairs(): NexusCalibrationPair[] {
  const taus = [120, 150, 200];
  return taus.map((tauMs, i) => {
    const x = (tauMs / 1000) ** -2;
    return { timestampMs: 1000 * i, tauMs, sbpMmHg: 6 * x + 10, dbpMmHg: 3 * x + 8 };
  });
}

describe('CalibrationManager — modelo NEXUS_PTT y pares de calibración (F3)', () => {
  beforeEach(() => {
    // jsdom: localStorage disponible. Estado limpio y determinista por test.
    CalibrationManager.getInstance().reset();
  });

  it('sin calibración: pares vacíos y modelo NEXUS null (cae al prior público)', () => {
    const mgr = CalibrationManager.getInstance();
    expect(mgr.getNexusCalibrationPairs()).toEqual([]);
    expect(mgr.getActiveNexusPttModel()).toBeNull();
    expect(mgr.getNexusPttCalibrationInfo().available).toBe(false);
  });

  it('registro de pares: sello temporal, orden y recorte a 50', () => {
    const mgr = CalibrationManager.getInstance();
    const a = mgr.addNexusCalibrationPair({ tauMs: 140, sbpMmHg: 122, dbpMmHg: 80 });
    expect(a).not.toBeNull();
    expect(a!.timestampMs).toBeGreaterThan(0);
    const b = mgr.addNexusCalibrationPair({ tauMs: 160, sbpMmHg: 118, dbpMmHg: 78, quality0to100: 90 });
    const list = mgr.getNexusCalibrationPairs();
    expect(list).toHaveLength(2);
    expect(list[1].tauMs).toBe(b!.tauMs);
    expect(list[1].quality0to100).toBe(90);
    // Recorte: con >50 pares conserva el final (los más recientes).
    for (let i = 0; i < 55; i++) {
      mgr.addNexusCalibrationPair({ tauMs: 150 + i, sbpMmHg: 120, dbpMmHg: 80 });
    }
    expect(mgr.getNexusCalibrationPairs().length).toBe(50);
    mgr.clearNexusCalibrationPairs();
    expect(mgr.getNexusCalibrationPairs()).toEqual([]);
  });

  it('pares corruptos en localStorage se descartan sin romper el flujo', () => {
    localStorage.setItem(NEXUS_CALIBRATION_PAIRS_KEY, '{"no":"es-array"}');
    const mgr = CalibrationManager.getInstance();
    expect(mgr.getNexusCalibrationPairs()).toEqual([]);
    localStorage.setItem(
      NEXUS_CALIBRATION_PAIRS_KEY,
      JSON.stringify([
        { timestampMs: 1, tauMs: 150, sbpMmHg: 120, dbpMmHg: 80 },
        { lixo: true },
        null,
        'texto',
        ['no', 'es', 'objeto'],
        { timestampMs: 2, tauMs: 160, sbpMmHg: 119, dbpMmHg: 79 },
        { timestampMs: 3, tauMs: 'nulo', sbpMmHg: 118, dbpMmHg: 78 },
      ]),
    );
    const list = mgr.getNexusCalibrationPairs();
    expect(list).toHaveLength(2);
    expect(list[0].tauMs).toBe(150);
    expect(list[1].tauMs).toBe(160);
    mgr.clearNexusCalibrationPairs();
  });

  it('recordNexusPttModel con fit FIT: proclama modelo vigente 28 días con altman de referencia', () => {
    const mgr = CalibrationManager.getInstance();
    for (const p of analyticPairs()) mgr.addNexusCalibrationPair(p);
    const fit = fitPttPersonalModel(mgr.getNexusCalibrationPairs());
    expect(fit.status).toBe('FIT');
    const now = Date.now();
    const profile = mgr.recordNexusPttModel(fit);
    expect(profile).not.toBeNull();
    // Vigencia de 28 días ± un segundo de ejecución.
    expect(profile!.expiresAt - now).toBeGreaterThan(28 * 24 * 3600_000 - 1000);
    expect(profile!.expiresAt - now).toBeLessThan(28 * 24 * 3600_000 + 1000);
    expect(profile!.method).toBe('NEXUS_PTT_DUAL_CAMERA');
    expect(profile!.referenceValues.pairsCount).toBe(3);
    expect(profile!.referenceValues.loaLowSbpMmHg).toBeLessThanOrEqual(profile!.referenceValues.loaHighSbpMmHg);
    const model = mgr.getActiveNexusPttModel();
    expect(model).not.toBeNull();
    expect(model!.calibrated).toBe(true);
    expect(model!.kSbpMmHgS2).toBeCloseTo(fit.model!.kSbpMmHgS2, 12);
    expect(mgr.getCalibrationInfo('NEXUS_PTT').available).toBe(true);
    expect(mgr.getCalibrationInfo('NEXUS_PTT').required).toBe(false);
  });

  it('recordNexusPttModel rechaza resultado sin FIT (nada se proclama)', () => {
    const mgr = CalibrationManager.getInstance();
    const bad = fitPttPersonalModel([{ timestampMs: 1, tauMs: 150, sbpMmHg: 120, dbpMmHg: 80 }]);
    expect(bad.status).toBe('INSUFFICIENT_PAIRS');
    expect(mgr.recordNexusPttModel(bad)).toBeNull();
    expect(mgr.getActiveNexusPttModel()).toBeNull();
  });

  it('modelo vencido no se entrega (vigencia honesta, no se disimula)', () => {
    const mgr = CalibrationManager.getInstance();
    const fit = fitPttPersonalModel(analyticPairs(), { prior: UNCALIBRATED_PTT_MODEL });
    const profile = mgr.recordNexusPttModel(fit)!;
    // Se vence manualmente (simular paso del tiempo sobre el perfil proclamado).
    mgr.addProfile({ ...profile, expiresAt: Date.now() - 1 });
    expect(mgr.getActiveNexusPttModel()).toBeNull();
    expect(mgr.getCalibrationInfo('NEXUS_PTT').expired).toBe(true);
    expect(mgr.getCalibrationInfo('NEXUS_PTT').available).toBe(false);
  });

  it('revokeNexusPttModel elimina SOLO el modelo NEXUS y deja intactos los demás perfiles', () => {
    const mgr = CalibrationManager.getInstance();
    // Un perfil BP de brazalete preexistente.
    mgr.addProfile({
      id: 'bp_cuff_1',
      type: 'BP',
      deviceId: 'cuff_ref',
      modelName: 'cuff',
      coefficients: { sbpOffset: 3 },
      referenceValues: {},
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 24 * 3600_000,
      method: 'CUFF',
    });
    const fit = fitPttPersonalModel(analyticPairs());
    mgr.recordNexusPttModel(fit);
    expect(mgr.getActiveNexusPttModel()).not.toBeNull();

    mgr.revokeNexusPttModel();
    expect(mgr.getActiveNexusPttModel()).toBeNull();
    // El perfil de brazalete sobrevive y sigue resolviendo offsets.
    expect(mgr.getActiveBpOffsets()).toEqual({ sbpOffset: 3, dbpOffset: 0 });
  });

  it('reset() limpia también los pares NEXUS', () => {
    const mgr = CalibrationManager.getInstance();
    mgr.addNexusCalibrationPair({ tauMs: 150, sbpMmHg: 120, dbpMmHg: 80 });
    expect(mgr.getNexusCalibrationPairs()).toHaveLength(1);
    mgr.reset();
    expect(mgr.getNexusCalibrationPairs()).toEqual([]);
  });
});
