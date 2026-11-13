import { beforeEach, describe, expect, it } from 'vitest';
import {
  computePlacementEvidence,
  resetPlacementEvidence,
  type EvidenceInput,
} from '../fingerPlacementEvidence';

/** Estado de referencia: lente sellada, pulso pleno, centrado y quieto. */
const GOOD: EvidenceInput = {
  sealRatio: 0.62,
  perfusedFraction: 0.7,
  centroidX: 0.5,
  centroidY: 0.5,
  motionScore: 0.05,
  perfusionIndex: 0.004,
  dcLevel: 150,
  roiRedCv: 0.05,
};

function feed(count: number, overrides: Partial<EvidenceInput> = {}) {
  const input = { ...GOOD, ...overrides };
  let out = computePlacementEvidence(input);
  for (let i = 1; i < count; i++) out = computePlacementEvidence(input);
  return out;
}

/** Preciona de más: sellado alto, DC disparado y AC colapsada. */
const PRESSING_HARD: Partial<EvidenceInput> = {
  sealRatio: 0.9,
  perfusedFraction: 0.7,
  perfusionIndex: 0.0005,
  dcLevel: 215,
  roiRedCv: 0.006,
};

/** Apoyo insuficiente: la yema no cubre la lente. */
const PRESSING_SOFT: Partial<EvidenceInput> = {
  sealRatio: 0.16,
  perfusedFraction: 0.2,
  perfusionIndex: 0.0008,
  dcLevel: 60,
  roiRedCv: 0.02,
};

describe('fingerPlacementEvidence — evidencia física de colocación', () => {
  beforeEach(() => {
    resetPlacementEvidence();
  });

  it('sellado alto + pulso pleno → IDEAL con guía de mantener', () => {
    const evidence = feed(45);
    expect(evidence.pressure).toBe('IDEAL');
    expect(evidence.failing).toHaveLength(0);
    expect(evidence.guidance.action).toBe('HOLD');
    expect(evidence.pressureScore).toBeGreaterThan(0.4);
    expect(evidence.pressureScore).toBeLessThan(0.6);
    expect(evidence.placement).toBe('CENTERED');
  });

  it('sellado bajo → LIGHT y guía de presionar más', () => {
    const evidence = feed(45, PRESSING_SOFT);
    expect(evidence.pressure).toBe('LIGHT');
    expect(evidence.guidance.action).toBe('PRESS_MORE');
    expect(evidence.failing[0]).toMatch(/cubre la lente/i);
    expect(evidence.pressureScore).toBeLessThan(0.45);
  });

  it('presión excesiva → HEAVY, blanqueo alto y guía de soltar', () => {
    feed(45);
    const evidence = feed(30, PRESSING_HARD);
    expect(evidence.pressure).toBe('HEAVY');
    expect(evidence.guidance.action).toBe('RELEASE');
    expect(evidence.blanching).toBeGreaterThan(0.5);
    expect(evidence.failing[0]).toMatch(/suelta/i);
    expect(evidence.failing.join(' ')).not.toMatch(/presiona un poco más/i);
    expect(evidence.pressureScore).toBeGreaterThan(0.7);
  });

  it('sin dedo el score cae a neutro y no afirma presión', () => {
    const evidence = feed(30, {
      sealRatio: 0.03,
      perfusedFraction: 0,
      perfusionIndex: 0,
      dcLevel: 0,
      roiRedCv: 0,
    });

    expect(evidence.placement).toBe('NO_FINGER');
    expect(evidence.coverage).toBeLessThan(0.12);
    expect(evidence.failing.join(' ')).toMatch(/no evaluable|recoloca|apoya el dedo/i);
    expect(evidence.guidance.action).toBe('REPOSITION');
    expect(evidence.pressureScore).toBe(0.5);
  });

  it('el score de colocación y el veredicto de presión son coherentes', () => {
    const good = feed(45);
    const heavy = (() => {
      resetPlacementEvidence();
      feed(45);
      return feed(30, PRESSING_HARD);
    })();

    // Un dedo bien colocado nunca puntúa por debajo de uno que colapsa el lecho.
    expect(heavy.score).toBeLessThan(good.score);
  });

  it('petición de más presión cuando el pulso es débil sin evidencia de colapso', () => {
    // Primero se establece un máximo de referencia con pulso pleno; después el
    // pulso cae sin que el DC suba. Eso es "apoya mejor", no "suelta".
    feed(45);
    const evidence = feed(30, {
      sealRatio: 0.62,
      perfusedFraction: 0.6,
      perfusionIndex: 0.001,
      dcLevel: 110,
      roiRedCv: 0.05,
    });

    expect(evidence.pressure).toBe('LIGHT');
    expect(evidence.failing.join(' ')).toMatch(/presiona (más|un poco más)/i);
    expect(evidence.blanching).toBeLessThan(0.5);
    expect(evidence.failing.join(' ')).not.toMatch(/suelta un poco/i);
  });

  it('arranque en frío con pulso débil no se afirma como óptimo', () => {
    // Sin máximo de referencia el pulso no es comparable: la pulsatilidad
    // normalizada (0.25) nunca debe compararse contra el PI absoluto (0.0022),
    // porque eso hacía que cualquier pulso débil se declarara IDEAL.
    const evidence = feed(45, {
      sealRatio: 0.62,
      perfusedFraction: 0.6,
      perfusionIndex: 0.001,
      dcLevel: 110,
      roiRedCv: 0.05,
    });

    expect(evidence.pressure).not.toBe('IDEAL');
    expect(evidence.guidance.action).not.toBe('HOLD');
  });

  it('mantener quietud tras un dedo bien colocado y luego corregir', () => {
    feed(45);
    const moving = feed(6, {
      ...PRESSING_HARD,
      motionScore: 0.9,
    });
    expect(moving.failing.join(' ')).toMatch(/quieto/i);

    resetPlacementEvidence();
    feed(45);
    const pressing = feed(30, PRESSING_HARD);
    expect(pressing.pressure).toBe('HEAVY');

    const fixed = feed(20, GOOD);
    expect(fixed.pressure).toBe('IDEAL');
    expect(fixed.failing).toHaveLength(0);
  });

  it('traslado lateral: avisa de centrado sin perder el veredicto de presión', () => {
    const evidence = feed(45, {
      centroidX: 0.05,
      centroidY: 0.05,
    });

    expect(evidence.placement).not.toBe('CENTERED');
    expect(evidence.failing.join(' ')).toMatch(/centra la yema/i);
  });

  it('sellar con el flash saturando ya no se lee como presión baja', () => {
    // El bug real: la cobertura venía de la máscara AC/DC, que colapsa cuando el
    // rojo satura. Ahora el sellado es por tejido e informa cobertura alta.
    const evidence = feed(45, {
      sealRatio: 0.78,
      perfusedFraction: 0.55,
      perfusionIndex: 0.0035,
      dcLevel: 240,
      roiRedCv: 0.045,
      motionScore: 0.05,
    });

    expect(evidence.seal).toBeGreaterThan(0.6);
    expect(evidence.pressure).not.toBe('LIGHT');
    expect(evidence.failing.join(' ')).not.toMatch(/cubre la lente/i);
  });

  it('resetPlacementEvidence devuelve el estado a cero', () => {
    feed(45, PRESSING_HARD);
    resetPlacementEvidence();
    const evidence = feed(1);

    expect(evidence.pressure).toBe('NONE');
    expect(evidence.pressureScore).toBe(0.5);
    expect(evidence.placement).toBe('NO_FINGER');
  });

  it('la guía nunca contradice el veredicto', () => {
    const cases: Array<[string, Partial<EvidenceInput>, string]> = [
      ['IDEAL', {}, 'HOLD'],
      ['LIGHT', PRESSING_SOFT, 'PRESS_MORE'],
      ['HEAVY', PRESSING_HARD, 'RELEASE'],
    ];

    for (const [expectedPressure, overrides, expectedAction] of cases) {
      resetPlacementEvidence();
      feed(45);
      const evidence = feed(30, overrides);
      expect(evidence.pressure).toBe(expectedPressure);
      expect(evidence.guidance.action).toBe(expectedAction);
    }
  });
});