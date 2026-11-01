import { describe, it, expect } from 'vitest';
import {
  fitPttPersonalModel,
  computeNexusBlandAltman,
  NEXUS_CALIBRATION_MIN_PAIRS,
  NEXUS_RIDGE_FRACTION,
  type NexusCalibrationPair,
} from '../nexusCalibrationFit';
import { UNCALIBRATED_PTT_MODEL, pttModelToPressures } from '../nexusFusionCore';

function pairsFromModel(params: {
  k: number;
  c: number;
  tauList: number[];
  sbpJitter?: number[];
}): NexusCalibrationPair[] {
  return params.tauList.map((tauMs, i) => ({
    timestampMs: 1_700_000_000_000 + i * 60_000,
    tauMs,
    sbpMmHg: params.k * (tauMs / 1000) ** -2 + params.c + (params.sbpJitter?.[i] ?? 0),
    dbpMmHg: 2.2 * (tauMs / 1000) ** -2 + 25,
  }));
}

describe('nexusCalibrationFit — ajuste personal PTT↔PA (OLS + blend ridge)', () => {
  it('recupera la relación analítica con precisión mecánica (prior = modelo del test)', () => {
    // Generamos pares EXACTOS de y = 4.2/τ² + 25 con 3 τ espaciados. Con prior
    // idéntico al generador, OLS recupera (4.2, 25) y el blend no altera nada.
    const pairs = pairsFromModel({ k: 4.2, c: 25, tauList: [110, 150, 210] });
    const fit = fitPttPersonalModel(pairs, { ridgeFraction: 0.2, prior: UNCALIBRATED_PTT_MODEL });

    expect(fit.status).toBe('FIT');
    expect(fit.model).not.toBeNull();
    expect(fit.model?.calibrated).toBe(true);
    expect(Math.abs(fit.model!.kSbpMmHgS2 - 4.2)).toBeLessThan(1e-9);
    expect(Math.abs(fit.model!.cSbpMmHg - 25)).toBeLessThan(1e-9);
    // Alta correlación planaria en caso exacto.
    expect(Math.abs(fit.fitSummary!.rSbp)).toBeGreaterThan(0.99);
    // Bland–Altman sobre datos exactos: sesgo 0 y σ 0.
    expect(Math.abs(fit.altman!.sbp.biasMmHg)).toBeLessThan(1e-9);
    expect(fit.altman!.sbp.sdMmHg).toBeLessThan(1e-9);
  });

  it('blend ridge numerado: k final = λ·prior + (1−λ)·OLS con valores exactos', () => {
    const kTrue = 6.0;
    const cTrue = 10;
    const pairs = pairsFromModel({ k: kTrue, c: cTrue, tauList: [120, 160, 230] });
    const fit = fitPttPersonalModel(pairs, { ridgeFraction: 0.2, prior: UNCALIBRATED_PTT_MODEL });
    expect(fit.status).toBe('FIT');
    // OLS sobre 3 puntos colineales exactos recupera (6, 10); blend con prior
    // (4.2, 25): k = 0.2·4.2 + 0.8·6 = 5.64 ; c = 0.2·25 + 0.8·10 = 13.
    expect(Math.abs(fit.model!.kSbpMmHgS2 - 5.64)).toBeLessThan(1e-9);
    expect(Math.abs(fit.model!.cSbpMmHg - 13)).toBeLessThan(1e-9);
  });

  it('con ruido moderado el ajuste converge con residuos declarados', () => {
    const pairs = pairsFromModel({
      k: 5.0,
      c: 18,
      tauList: [110, 130, 150, 180, 220, 260],
      sbpJitter: [1.2, -0.8, 2.1, -1.5, 0.9, -0.4],
    });
    const fit = fitPttPersonalModel(pairs);
    expect(fit.status).toBe('FIT');
    expect(fit.model!.kSbpMmHgS2).toBeGreaterThan(4); // cerca del 5.0 verdadero
    expect(fit.model!.kSbpMmHgS2).toBeLessThan(6);
    // Regresión con fracción default NEXUS_RIDGE_FRACTION hacia el prior.
    expect(fit.model!.kSbpMmHgS2).toBeLessThan(5.0); // el prior tira hacia 4.2
    expect(fit.fitSummary!.residualStdSbpMmHg).toBeGreaterThan(0);
    expect(fit.fitSummary!.rSbp).toBeGreaterThan(0.9);
  });

  it('con <min pares → INSUFFICIENT_PAIRS sin modelo y sin fabricación', () => {
    expect(NEXUS_CALIBRATION_MIN_PAIRS).toBe(3);
    const two = pairsFromModel({ k: 4.2, c: 25, tauList: [110, 150] }).slice(0, 2);
    const fit = fitPttPersonalModel(two);
    expect(fit.status).toBe('INSUFFICIENT_PAIRS');
    expect(fit.model).toBeNull();
    expect(fit.fitSummary).toBeNull();
    expect(fit.altman).toBeNull();
  });

  it('τ repetidos (varianza degenerada) → UNSTABLE_MODEL', () => {
    const flat: NexusCalibrationPair[] = [1, 2, 3].map((i) => ({
      timestampMs: i,
      tauMs: 180,
      sbpMmHg: 120 + i,
      dbpMmHg: 78 + i,
    }));
    expect(fitPttPersonalModel(flat).status).toBe('UNSTABLE_MODEL');
  });

  it('relación anti-física (τ↑ ⇒ PA↑): rechazo por física vascular', () => {
    // PA que SUBE cuando τ sube: física vascular invertida → pendiente ≤0 en x=1/τ².
    const inverted = [110, 150, 210].map((tauMs, i) => ({
      timestampMs: i,
      tauMs,
      sbpMmHg: 115 + (tauMs - 110) * 0.35,
      dbpMmHg: 70 + (tauMs - 110) * 0.2,
    }));
    expect(fitPttPersonalModel(inverted).status).toBe('UNSTABLE_MODEL');
  });

  it('τ fuera del dominio del mapeador (3000 ms) se descarta antes del conteo', () => {
    const pairs = [
      { timestampMs: 1, tauMs: 3000, sbpMmHg: 120, dbpMmHg: 60 },
      { timestampMs: 2, tauMs: 120, sbpMmHg: 60, dbpMmHg: 70 },
      ...pairsFromModel({ k: 4.2, c: 25, tauList: [110, 150, 210] }),
    ];
    const fit = fitPttPersonalModel(pairs);
    expect(fit.status).toBe('FIT'); // con los 2 inválidos descartados quedan los 3 válidos
    expect(fit.altman!.sbp.n).toBe(3);
  });

  it('Bland–Altman con números cerrados: d̄, σ, LoA y percentiles exactos', () => {
    // Modelo EXPLÍCITO (el prior público) con pares cuyo sbp tiene deltas
    // deterministas respecto del mapa: diferencias = predicción − referencia
    // = [0, +2, −2] ⇒ d̄=0, σ²=(0+4+4)/2=4 ⇒ σ=2, LoA = ±3.92,
    // p5 = −2, p95 = 0 (robustPercentile de [−2, 0, 2] n=3).
    const diffs = [0, 2, -2];
    const taus = [110, 150, 210];
    const pairs: NexusCalibrationPair[] = taus.map((tauMs, i) => {
      const { sbp, dbp } = pttModelToPressures(tauMs, UNCALIBRATED_PTT_MODEL);
      return {
        timestampMs: i,
        tauMs,
        sbpMmHg: sbp - diffs[i],
        dbpMmHg: dbp,
      };
    });
    const altman = computeNexusBlandAltman(pairs, UNCALIBRATED_PTT_MODEL);
    expect(altman).not.toBeNull();
    const ch = altman!.sbp;
    expect(Math.abs(ch.biasMmHg - 0)).toBeLessThan(1e-9);
    expect(Math.abs(ch.sdMmHg - 2)).toBeLessThan(1e-9);
    expect(Math.abs(ch.loaLowMmHg - (0 - 1.96 * 2))).toBeLessThan(1e-9);
    expect(Math.abs(ch.loaHighMmHg - (0 + 1.96 * 2))).toBeLessThan(1e-9);
    expect(ch.p5MmHg).toBeCloseTo(-2, 9);
    expect(ch.p95MmHg).toBeCloseTo(0, 9);
    expect(ch.direction).toBe('PREDICTED_MINUS_REFERENCE');
    // Canal DBP construido exacto: sesgo 0 y σ 0.
    expect(Math.abs(altman!.dbp.biasMmHg)).toBeLessThan(1e-9);
    expect(altman!.dbp.sdMmHg).toBeLessThan(1e-9);
    // Completa el contrato: el ajuste interno y esta función pública usan la
    // misma estatística (el altman del FIT coincide con el modelo FIT).
    const fit = fitPttPersonalModel(pairs);
    expect(fit.status).toBe('FIT');
    const again = computeNexusBlandAltman(pairs, fit.model!);
    expect(again!.sbp.biasMmHg).toBeCloseTo(fit.altman!.sbp.biasMmHg, 12);
    expect(again!.sbp.sdMmHg).toBeCloseTo(fit.altman!.sbp.sdMmHg, 12);
  });

  it('computeNexusBlandAltman sin pares válidos → null (nada se inventa)', () => {
    expect(computeNexusBlandAltman([], UNCALIBRATED_PTT_MODEL)).toBeNull();
  });

  it('fracción de ridge por defecto y prior público son los del blueprint', () => {
    expect(NEXUS_RIDGE_FRACTION).toBe(0.2);
    const fitDefault = fitPttPersonalModel(pairsFromModel({ k: 6, c: 10, tauList: [120, 160, 230] }));
    // misma cuenta que el test numerado pero SIN options explícitas
    expect(Math.abs(fitDefault.model!.kSbpMmHgS2 - 5.64)).toBeLessThan(1e-9);
  });
});
