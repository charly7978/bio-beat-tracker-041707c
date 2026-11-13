import { beforeEach, describe, expect, it } from 'vitest';
import {
  computePlacementEvidence,
  resetPlacementEvidence,
  type FingerPlacementEvidence,
} from '../fingerPlacementEvidence';

interface FrameOptions {
  coverage?: number;
  perfusionIndex?: number;
  dcLevel?: number;
  roiRedCv?: number;
  centroidX?: number;
  centroidY?: number;
  motionScore?: number;
}

const HEALTHY: FrameOptions = {
  coverage: 0.9,
  perfusionIndex: 0.004,
  dcLevel: 150,
  roiRedCv: 0.05,
  centroidX: 0.5,
  centroidY: 0.5,
  motionScore: 0.05,
};

function feed(frames: number, options: FrameOptions = {}): FingerPlacementEvidence {
  const frame = { ...HEALTHY, ...options };
  let evidence: FingerPlacementEvidence | null = null;
  for (let i = 0; i < frames; i++) {
    evidence = computePlacementEvidence({
      coverageRatio: frame.coverage ?? 0.9,
      centroidX: frame.centroidX ?? 0.5,
      centroidY: frame.centroidY ?? 0.5,
      motionScore: frame.motionScore ?? 0.05,
      perfusionIndex: frame.perfusionIndex ?? 0.004,
      dcLevel: frame.dcLevel ?? 150,
      roiRedCv: frame.roiRedCv ?? 0.05,
    });
  }
  if (!evidence) throw new Error('feed requires at least one frame');
  return evidence;
}

describe('fingerPlacementEvidence — modelo de presión transmural', () => {
  beforeEach(() => {
    resetPlacementEvidence();
  });

  it('clasifica presión óptima con perfusión plena y cobertura buena', () => {
    const evidence = feed(45);

    expect(evidence.pressure).toBe('IDEAL');
    expect(evidence.pressureScore).toBeGreaterThan(0.4);
    expect(evidence.pressureScore).toBeLessThan(0.6);
    expect(evidence.failing).not.toContain('Presión excesiva: suelta un poco el dedo');
  });

  it('detecta colapso capilar (blanching) al caer la AC frente al mejor reciente', () => {
    feed(45);
    const evidence = feed(20, {
      coverage: 0.92,
      perfusionIndex: 0.0005,
      dcLevel: 210,
      roiRedCv: 0.006,
    });

    expect(evidence.pressure).toBe('HEAVY');
    expect(evidence.pressureScore).toBeGreaterThan(0.65);
    expect(evidence.failing[0]).toMatch(/suelta/i);
    expect(evidence.failing.join(' ')).not.toMatch(/presiona un poco más/i);
  });

  it('detecta colapso con PI RAW (sin saturación): 0.02 → 0.008', () => {
    // Pico alto que satura el PI normalizado: el colapso relativo debe medirse
    // en PI RAW para no perderse.
    feed(45, { perfusionIndex: 0.02, dcLevel: 160, roiRedCv: 0.08 });
    const evidence = feed(20, {
      coverage: 0.9,
      perfusionIndex: 0.008,
      dcLevel: 200,
      roiRedCv: 0.01,
    });

    expect(evidence.pressure).toBe('HEAVY');
    expect(evidence.pressureScore).toBeGreaterThan(0.5);
  });

  it('declara HEAVY en cobertura media (0.62–0.79) si hay colapso relativo', () => {
    feed(45);
    const evidence = feed(20, {
      coverage: 0.7,
      perfusionIndex: 0.0005,
      dcLevel: 200,
      roiRedCv: 0.006,
    });

    expect(evidence.pressure).toBe('HEAVY');
  });

  it('no inventa presión sin pico de referencia: NONE y guía neutra', () => {
    const evidence = feed(50, {
      coverage: 0.9,
      perfusionIndex: 0.0005,
      dcLevel: 200,
      roiRedCv: 0.004,
    });

    expect(evidence.pressure).toBe('NONE');
    expect(evidence.pressureScore).toBe(0.5);
    expect(evidence.failing.join(' ')).toMatch(/no evaluable|recoloca/i);
    expect(evidence.failing.join(' ')).not.toMatch(/suelta un poco/i);
  });

  it('clasifica presión baja cuando hay fuga de luz por cobertura insuficiente', () => {
    const evidence = feed(40, {
      coverage: 0.3,
      perfusionIndex: 0.0008,
      dcLevel: 60,
      roiRedCv: 0.02,
    });

    expect(evidence.pressure).toBe('LIGHT');
    expect(evidence.pressureScore).toBeLessThan(0.4);
    expect(evidence.failing[0]).toMatch(/cubre la lente/i);
  });

  it('no inventa presión sin dedo: NONE y placement NO_FINGER', () => {
    const evidence = feed(20, { coverage: 0.05, perfusionIndex: 0 });

    expect(evidence.pressure).toBe('NONE');
    expect(evidence.placement).toBe('NO_FINGER');
  });

  it('exige histéresis para entrar en HEAVY (no parpadea con los primeros frames)', () => {
    feed(45);
    const almost = feed(5, {
      coverage: 0.92,
      perfusionIndex: 0.0005,
      dcLevel: 210,
      roiRedCv: 0.006,
    });
    expect(almost.pressure).toBe('IDEAL');

    const confirmed = feed(20, {
      coverage: 0.92,
      perfusionIndex: 0.0005,
      dcLevel: 210,
      roiRedCv: 0.006,
    });
    expect(confirmed.pressure).toBe('HEAVY');
  });

  it('exige histéresis para salir de HEAVY y confirma la recuperación', () => {
    feed(45);
    feed(20, {
      coverage: 0.92,
      perfusionIndex: 0.0005,
      dcLevel: 210,
      roiRedCv: 0.006,
    });

    const stillHeavy = feed(11, HEALTHY);
    expect(stillHeavy.pressure).toBe('HEAVY');

    const recovered = feed(25, HEALTHY);
    expect(recovered.pressure).toBe('IDEAL');
  });

  it('mantiene HEAVY sostenido (pico congelado) durante 60+ frames', () => {
    feed(45);
    feed(20, {
      coverage: 0.92,
      perfusionIndex: 0.0005,
      dcLevel: 210,
      roiRedCv: 0.006,
    });

    const sustained = feed(60, {
      coverage: 0.92,
      perfusionIndex: 0.0005,
      dcLevel: 210,
      roiRedCv: 0.006,
    });
    expect(sustained.pressure).toBe('HEAVY');
    expect(sustained.pressureScore).toBeGreaterThan(0.6);
  });

  it('un frame de baja cobertura no resetea HEAVY (anti-parpadeo)', () => {
    feed(45);
    feed(20, {
      coverage: 0.92,
      perfusionIndex: 0.0005,
      dcLevel: 210,
      roiRedCv: 0.006,
    });

    const flicker = feed(1, { coverage: 0.05, perfusionIndex: 0 });
    expect(flicker.pressure).toBe('HEAVY');
  });

  it('coherencia score/veredicto: HEAVY>0.5, LIGHT<0.5, IDEAL~0.5', () => {
    const ideal = feed(45);
    expect(ideal.pressure).toBe('IDEAL');
    expect(ideal.pressureScore).toBeGreaterThan(0.4);
    expect(ideal.pressureScore).toBeLessThan(0.6);

    resetPlacementEvidence();
    feed(45);
    const heavy = feed(20, {
      coverage: 0.92,
      perfusionIndex: 0.0005,
      dcLevel: 210,
      roiRedCv: 0.006,
    });
    expect(heavy.pressure).toBe('HEAVY');
    expect(heavy.pressureScore).toBeGreaterThan(0.5);

    resetPlacementEvidence();
    const light = feed(40, {
      coverage: 0.3,
      perfusionIndex: 0.0008,
      dcLevel: 60,
      roiRedCv: 0.02,
    });
    expect(light.pressure).toBe('LIGHT');
    expect(light.pressureScore).toBeLessThan(0.5);
  });

  it('resetPlacementEvidence limpia el episodio y vuelve a NONE', () => {
    feed(45);
    resetPlacementEvidence();

    const evidence = feed(1);
    expect(evidence.pressure).toBe('NONE');
    expect(evidence.pressureScore).toBeCloseTo(0.5, 6);
  });
});
