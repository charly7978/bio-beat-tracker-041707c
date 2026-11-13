import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTransmuralState,
  observeTransmuralPressure,
  resetTransmuralState,
  type TransmuralModelState,
  type TransmuralReading,
} from '../transmuralPressureModel';

interface FrameOptions {
  coverage?: number;
  perfusionIndex?: number;
  dcLevel?: number;
  roiRedCv?: number;
  motionScore?: number;
}

const HEALTHY: Required<FrameOptions> = {
  coverage: 0.9,
  perfusionIndex: 0.004,
  dcLevel: 150,
  roiRedCv: 0.05,
  motionScore: 0.05,
};

function feed(
  state: TransmuralModelState,
  frames: number,
  options: FrameOptions = {},
): TransmuralReading {
  const frame = { ...HEALTHY, ...options };
  let reading: TransmuralReading | null = null;
  for (let i = 0; i < frames; i++) {
    reading = observeTransmuralPressure(state, {
      coverageRatio: frame.coverage,
      motionScore: frame.motionScore,
      perfusionIndex: frame.perfusionIndex,
      dcLevel: frame.dcLevel,
      roiRedCv: frame.roiRedCv,
    });
  }
  if (!reading) throw new Error('feed requires at least one frame');
  return reading;
}

describe('transmuralPressureModel — fisiología de presión transmural', () => {
  let state: TransmuralModelState;

  beforeEach(() => {
    state = createTransmuralState();
  });

  it('produce un grado continuo ordenado: LIGHT < IDEAL < HEAVY', () => {
    const ideal = feed(state, 45);
    expect(ideal.state).toBe('IDEAL');
    expect(ideal.fraction).toBeGreaterThan(0.4);
    expect(ideal.fraction).toBeLessThan(0.6);

    resetTransmuralState(state);
    const light = feed(state, 40, {
      coverage: 0.3,
      perfusionIndex: 0.0008,
      dcLevel: 60,
      roiRedCv: 0.02,
    });
    expect(light.state).toBe('LIGHT');
    expect(light.fraction).toBeLessThan(0.4);

    resetTransmuralState(state);
    feed(state, 45);
    const heavy = feed(state, 20, {
      coverage: 0.92,
      perfusionIndex: 0.0005,
      dcLevel: 210,
      roiRedCv: 0.006,
    });
    expect(heavy.state).toBe('HEAVY');
    expect(heavy.fraction).toBeGreaterThan(0.7);
    expect(light.fraction).toBeLessThan(ideal.fraction);
    expect(ideal.fraction).toBeLessThan(heavy.fraction);
  });

  it('detecta isquemia por presión (blanching) con DC alto y AC colapsada', () => {
    feed(state, 45);
    const reading = feed(state, 20, {
      coverage: 0.92,
      perfusionIndex: 0.0005,
      dcLevel: 210,
      roiRedCv: 0.006,
    });

    expect(reading.state).toBe('HEAVY');
    expect(reading.blanching).toBeGreaterThan(0.5);
    expect(reading.perfusionRatio).toBeLessThan(0.2);
    expect(reading.forceProxy).toBeGreaterThan(0.5);
    expect(reading.reason).toBe('OVER');
  });

  it('no confunde baja perfusión con presión excesiva: DC bajo → LIGHT', () => {
    feed(state, 45);
    const reading = feed(state, 25, {
      coverage: 0.9,
      perfusionIndex: 0.001,
      dcLevel: 110,
      roiRedCv: 0.05,
    });

    expect(reading.state).toBe('LIGHT');
    expect(reading.blanching).toBeLessThan(0.5);
    expect(reading.reason).toBe('UNDER');
  });

  it('no afirma presión sin un PI de referencia (NONE, no inventa)', () => {
    const reading = feed(state, 50, {
      coverage: 0.9,
      perfusionIndex: 0.0005,
      dcLevel: 200,
      roiRedCv: 0.004,
    });

    expect(reading.state).toBe('NONE');
    expect(reading.hasReference).toBe(false);
    expect(reading.reason).toBe('NO_REFERENCE');
    expect(reading.fraction).toBe(0.5);
  });

  it('marca cobertura insuficiente como acoplamiento pobre (LIGHT)', () => {
    const reading = feed(state, 40, {
      coverage: 0.3,
      perfusionIndex: 0.0008,
      dcLevel: 60,
      roiRedCv: 0.02,
    });

    expect(reading.state).toBe('LIGHT');
    expect(reading.coupling).toBeLessThan(0.6);
    expect(reading.reason).toBe('UNDER');
  });

  it('exige histéresis para entrar y salir de HEAVY', () => {
    feed(state, 45);
    const almost = feed(state, 5, {
      coverage: 0.92,
      perfusionIndex: 0.0005,
      dcLevel: 210,
      roiRedCv: 0.006,
    });
    expect(almost.state).toBe('IDEAL');

    const confirmed = feed(state, 6, {
      coverage: 0.92,
      perfusionIndex: 0.0005,
      dcLevel: 210,
      roiRedCv: 0.006,
    });
    expect(confirmed.state).toBe('HEAVY');

    const stillHeavy = feed(state, 11, HEALTHY);
    expect(stillHeavy.state).toBe('HEAVY');

    const recovered = feed(state, 25, HEALTHY);
    expect(recovered.state).toBe('IDEAL');
    expect(recovered.reason).toBe('OPTIMAL');
  });

  it('el grado crece de forma monótona al aumentar el DC (eje de fuerza)', () => {
    feed(state, 45);
    const fractions: number[] = [];
    const steps = [
      { dcLevel: 170, perfusionIndex: 0.003, roiRedCv: 0.04 },
      { dcLevel: 190, perfusionIndex: 0.0015, roiRedCv: 0.02 },
      { dcLevel: 210, perfusionIndex: 0.0006, roiRedCv: 0.008 },
    ];
    for (const step of steps) {
      const reading = feed(state, 14, step);
      fractions.push(reading.fraction);
    }
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1] - 0.001);
    }
    expect(fractions[fractions.length - 1]).toBeGreaterThan(fractions[0]);
  });

  it('sin baseline de DC no amplifica ruido ni declara colapso', () => {
    feed(state, 45);
    const reading = feed(state, 20, {
      coverage: 0.9,
      perfusionIndex: 0.0005,
      dcLevel: 2,
      roiRedCv: 0.001,
    });

    expect(reading.forceProxy).toBe(0);
    expect(reading.state).not.toBe('HEAVY');
  });

  it('con dcMin=0 el proxy de fuerza no amplifica el ruido del sensor', () => {
    feed(state, 20, {
      coverage: 0.9,
      perfusionIndex: 0,
      dcLevel: 0,
      roiRedCv: 0,
    });
    const reading = feed(state, 5, {
      coverage: 0.9,
      perfusionIndex: 0,
      dcLevel: 1,
      roiRedCv: 0,
    });

    expect(reading.forceProxy).toBe(0);
    expect(reading.dcTrend).toBe(0);
    expect(Number.isFinite(reading.fraction)).toBe(true);
  });

  it('HEAVY con movimiento conserva el eje OVER y el grado confirmado', () => {
    feed(state, 45);
    feed(state, 20, {
      coverage: 0.92,
      perfusionIndex: 0.0005,
      dcLevel: 210,
      roiRedCv: 0.006,
    });
    const moving = feed(state, 6, {
      coverage: 0.92,
      perfusionIndex: 0.0005,
      dcLevel: 210,
      roiRedCv: 0.006,
      motionScore: 0.9,
    });

    expect(moving.state).toBe('HEAVY');
    expect(moving.axis).toBe('OVER');
    expect(moving.reason).toBe('MOTION');
    expect(moving.fraction).toBeGreaterThan(0.7);
  });

  it('el movimiento congela el grado en lugar de inventar un cambio', () => {
    const baseline = feed(state, 45);
    const moving = feed(state, 6, {
      coverage: 0.92,
      perfusionIndex: 0.0005,
      dcLevel: 210,
      roiRedCv: 0.006,
      motionScore: 0.9,
    });

    expect(moving.reason).toBe('MOTION');
    expect(moving.state).toBe('IDEAL');
    expect(moving.fraction).toBeCloseTo(baseline.fraction, 5);
  });

  it('resetTransmuralState limpia el episodio (pico, baseline y grado)', () => {
    feed(state, 45);
    resetTransmuralState(state);

    const reading = feed(state, 1, {
      coverage: 0.9,
      perfusionIndex: 0,
      dcLevel: 0,
      roiRedCv: 0,
    });

    expect(reading.state).toBe('NONE');
    expect(reading.fraction).toBe(0.5);
    expect(reading.forceProxy).toBe(0);
    expect(reading.hasReference).toBe(false);
  });

  it('congela el aprendizaje del pico durante el movimiento', () => {
    feed(state, 45);
    const moving = feed(state, 20, {
      coverage: 0.92,
      perfusionIndex: 0.0005,
      dcLevel: 210,
      roiRedCv: 0.006,
      motionScore: 0.9,
    });
    expect(moving.state).toBe('IDEAL');
    expect(moving.reason).toBe('MOTION');
  });
});