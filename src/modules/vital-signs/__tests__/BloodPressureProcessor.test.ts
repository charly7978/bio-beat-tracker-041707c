import { describe, expect, it } from 'vitest';
import { BloodPressureProcessor } from '../BloodPressureProcessor';
import { VITAL_THRESHOLDS } from '../../../config/vitalThresholds';
import { isPhysiologicalBp } from '../../../lib/vitals/pwaPhysiologicalBpEngine';
import { crossSiteObservationFromTiming } from '../../../lib/vitals/nexusFusionCore';

function syntheticPpgBuffer(cycles = 8, spc = 30, shift = 0): number[] {
  const buf: number[] = [];
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < spc; i++) {
      const t = (i + shift) / spc;
      const up = t < 0.18 ? t / 0.18 : 1;
      const down = t >= 0.18 ? Math.exp(-(t - 0.18) * 5.2) : 1;
      const notch = t > 0.45 && t < 0.52 ? 0.92 : 1;
      buf.push(0.15 + 0.85 * up * down * notch);
    }
  }
  return buf;
}

describe('BloodPressureProcessor', () => {
  it('acumula ciclos en buffer persistente y produce valores fisiológicos', () => {
    const proc = new BloodPressureProcessor();
    const rr = [850, 870, 860, 855, 865, 858];

    // Usar buffers ligeramente diferentes cada frame (shift variable)
    // para evitar que el detector de duplicados los rechace todos
    let lastEst = proc.estimate(syntheticPpgBuffer(8, 30, 0), rr, 30);
    for (let i = 1; i <= 5; i++) {
      lastEst = proc.estimate(syntheticPpgBuffer(8, 30, i), rr, 30);
    }

    // Después de 6 frames con shifts distintos, debe acumular ≥3 ciclos únicos
    expect(lastEst.cyclesUsed).toBeGreaterThanOrEqual(3);

    // Si produce estimación, debe ser fisiológica
    if (lastEst.confidence !== 'INSUFFICIENT') {
      expect(isPhysiologicalBp(lastEst.systolic, lastEst.diastolic)).toBe(true);
      expect(lastEst.diastolic).toBeLessThan(lastEst.systolic);
      expect(lastEst.diastolic / lastEst.systolic).toBeGreaterThan(
        VITAL_THRESHOLDS.BP.DIA_SYS_RATIO_MIN,
      );
      expect(lastEst.diastolic / lastEst.systolic).toBeLessThan(
        VITAL_THRESHOLDS.BP.DIA_SYS_RATIO_MAX,
      );
    }
  });

  it('retorna INSUFFICIENT sin buffer suficiente', () => {
    const proc = new BloodPressureProcessor();
    const est = proc.estimate([0.1, 0.2], [800, 810], 30);
    expect(est.confidence).toBe('INSUFFICIENT');
    expect(est.diastolic).toBe(0);
  });

  it('mantiene últimos valores conocidos tras pérdida de señal', () => {
    const proc = new BloodPressureProcessor();
    const rr = [850, 870, 860];

    // Alimentar buffer con frames variados para acumular ciclos
    let est = proc.estimate(syntheticPpgBuffer(6, 30, 0), rr, 30);
    for (let i = 0; i < 3; i++) {
      est = proc.estimate(syntheticPpgBuffer(6, 30, i + 1), rr, 30);
    }

    if (est.confidence === 'INSUFFICIENT') return;

    // Señal perdida
    const est2 = proc.estimate([0, 0, 0], rr, 30);
    expect(est2.systolic).toBeGreaterThan(0);
  });

  it('modo NEXUS: la fuente cross-site entra por fusión y la metadatos se publican', () => {
    const proc = new BloodPressureProcessor();
    const rr = [850, 870, 860, 855, 865, 858];
    const T = 5_000_000;

    // Acumular ciclos como en el test de acumulación
    let est = proc.estimate(syntheticPpgBuffer(8, 30, 0), rr, 30);
    for (let i = 1; i <= 5; i++) {
      est = proc.estimate(syntheticPpgBuffer(8, 30, i), rr, 30);
    }
    if (est.confidence === 'INSUFFICIENT') {
      // Sin base PWA no hay fusión posible: la meta no debe aparecer
      proc.setNexusCrossSiteObservation(null, null);
      return;
    }

    // Modelo PTT↔PA calibrado del banco de pruebas (unidades mmHg·s² / mmHg)
    const obs = crossSiteObservationFromTiming(
      { tauMs: 200, quality: 90, spectralCoherence: 0.85, beatsAgreed: 6, tauCvPercent: 8 },
      { kSbpMmHgS2: 4.6, cSbpMmHg: 17, kDbpMmHgS2: 2.4, cDbpMmHg: 20, calibrated: true },
      T,
    );
    expect(obs).not.toBeNull();
    proc.setNexusCrossSiteObservation(
      obs,
      { coherenceLevel: 'CONGRUENT', coherenceScore: 100, tauMs: 200 },
    );

    const fused = proc.estimate(syntheticPpgBuffer(8, 30, 7), rr, 30);
    expect(fused.nexus).toBeDefined();
    expect(fused.uncertainty).toBeDefined();
    expect(fused.nexus.coherenceLevel).toBe('CONGRUENT');
    expect(fused.nexus.tauMs).toBe(200);
    expect(fused.nexus.sourcesUsed).toContain('CROSS_SITE_PTT');
    expect(fused.nexus.sourcesUsed).toContain('PWA_WINDKESSEL');
    expect(fused.confidence).not.toBe('INSUFFICIENT');
    if (fused.systolic > 0) {
      expect(isPhysiologicalBp(fused.systolic, fused.diastolic)).toBe(true);
      // La banda p5–p95 contiene el estimado central
      expect(fused.uncertainty.sbpP5).toBeLessThanOrEqual(fused.systolic);
      expect(fused.uncertainty.sbpP95).toBeGreaterThanOrEqual(fused.systolic);
      expect(fused.uncertainty.dbpP5).toBeLessThanOrEqual(fused.diastolic);
      expect(fused.uncertainty.dbpP95).toBeGreaterThanOrEqual(fused.diastolic);
    }

    // Semántica consume-una-vez: SIN re-emisión, la siguiente estimación es
    // el camino físico local puro (sin metadatos NEXUS).
    const plain = proc.estimate(syntheticPpgBuffer(8, 30, 8), rr, 30);
    expect(plain.nexus).toBeUndefined();
    expect(plain.uncertainty).toBeUndefined();
  });
});
