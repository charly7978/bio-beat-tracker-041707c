import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTransmuralState,
  observeTransmuralPressure,
  resetTransmuralState,
  type TransmuralModelState,
  type TransmuralReading,
} from '../transmuralPressureModel';

interface FrameOptions {
  sealRatio?: number;
  perfusedFraction?: number;
  perfusionIndex?: number;
  dcLevel?: number;
  roiRedCv?: number;
  motionScore?: number;
}

/** Estado de referencia: lente sellada, pulso pleno, dedo quieto. */
const HEALTHY: Required<FrameOptions> = {
  sealRatio: 0.62,
  perfusedFraction: 0.7,
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
      sealRatio: frame.sealRatio,
      perfusedFraction: frame.perfusedFraction,
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
      sealRatio: 0.16,
      perfusedFraction: 0.2,
      perfusionIndex: 0.0008,
      dcLevel: 60,
      roiRedCv: 0.02,
    });
    expect(light.state).toBe('LIGHT');
    expect(light.fraction).toBeLessThan(0.4);

    resetTransmuralState(state);
    feed(state, 45);
    const heavy = feed(state, 20, {
      sealRatio: 0.9,
      perfusedFraction: 0.7,
      perfusionIndex: 0.0005,
      dcLevel: 215,
      roiRedCv: 0.006,
    });
    expect(heavy.state).toBe('HEAVY');
    expect(heavy.fraction).toBeGreaterThan(0.7);
    expect(light.fraction).toBeLessThan(ideal.fraction);
    expect(ideal.fraction).toBeLessThan(heavy.fraction);
  });

  it('detecta isquemia por presión (blanqueo) con sellado alto, DC alto y AC colapsada', () => {
    feed(state, 45);
    const reading = feed(state, 20, {
      sealRatio: 0.9,
      perfusedFraction: 0.7,
      perfusionIndex: 0.0005,
      dcLevel: 215,
      roiRedCv: 0.006,
    });

    expect(reading.state).toBe('HEAVY');
    expect(reading.blanching).toBeGreaterThan(0.5);
    expect(reading.perfusionRatio).toBeLessThan(0.2);
    expect(reading.forceProxy).toBeGreaterThan(0.5);
    expect(reading.reason).toBe('OVER');
    expect(reading.guidance.action).toBe('RELEASE');
  });

  it('no confunde baja perfusión con presión excesiva: DC bajo → LIGHT', () => {
    feed(state, 45);
    const reading = feed(state, 25, {
      sealRatio: 0.62,
      perfusedFraction: 0.6,
      perfusionIndex: 0.001,
      dcLevel: 110,
      roiRedCv: 0.05,
    });

    expect(reading.state).toBe('LIGHT');
    expect(reading.blanching).toBeLessThan(0.5);
    expect(reading.reason).toBe('UNDER');
    expect(reading.guidance.action).toBe('PRESS_MORE');
  });

  it('ya no depende de la máscara AC/DC: un dedo saturado que cubre la lente lee sellado alto', () => {
    // El bug real: con el flash encendido el rojo satura y la máscara
    // fisiológica colapsa, así que "cobertura" parecía baja con el dedo
    // perfectamente apoyado. Ahora el sellado es por tejido e independiente.
    const reading = feed(state, 40, {
      sealRatio: 0.75,
      perfusedFraction: 0.5,
      perfusionIndex: 0.0035,
      dcLevel: 240,
      roiRedCv: 0.045,
      motionScore: 0.05,
    });

    expect(reading.seal).toBeGreaterThan(0.6);
    expect(reading.state).not.toBe('LIGHT');
    expect(reading.guidance.action).not.toBe('PRESS_MORE');
  });

  it('sellado bajo manda LIGHT aunque el pulso sea fuerte (dedo apoyado fuera de la lente)', () => {
    const reading = feed(state, 40, {
      sealRatio: 0.14,
      perfusedFraction: 0.1,
      perfusionIndex: 0.004,
      dcLevel: 120,
      roiRedCv: 0.05,
    });

    expect(reading.state).toBe('LIGHT');
    expect(reading.axis).toBe('UNDER');
    expect(reading.guidance.action).toBe('PRESS_MORE');
    expect(reading.guidance.headline).toMatch(/PRESIONA/i);
  });

  it('sin contacto no afirma presión: NONE y guía de reposicionar', () => {
    const reading = feed(state, 30, {
      sealRatio: 0.03,
      perfusedFraction: 0,
      perfusionIndex: 0,
      dcLevel: 0,
      roiRedCv: 0,
    });

    expect(reading.state).toBe('NONE');
    expect(reading.hasReference).toBe(false);
    expect(reading.reason).toBe('NO_CONTACT');
    expect(reading.fraction).toBe(0.5);
    expect(reading.guidance.action).toBe('REPOSITION');
  });

  it('el DC de referencia se ancla al sellar, no al mínimo del episodio', () => {
    // Pre-contacto oscuro (DC 8) seguido de sellado a DC 150: la fuerza debe
    // medirse contra 150, no contra 8. Con el mínimo global, cualquier dedo
    // parecía "presión alta" apenas apoyado.
    feed(state, 10, {
      sealRatio: 0.02,
      perfusedFraction: 0,
      perfusionIndex: 0,
      dcLevel: 8,
      roiRedCv: 0.002,
    });
    const sealed = feed(state, 40, {
      sealRatio: 0.62,
      perfusedFraction: 0.7,
      perfusionIndex: 0.004,
      dcLevel: 150,
      roiRedCv: 0.05,
    });

    expect(sealed.state).toBe('IDEAL');
    expect(sealed.forceProxy).toBeLessThan(0.4);
    expect(sealed.guidance.action).toBe('HOLD');
  });

  it('exige sellado suficiente para atribuir blanqueo (dedo frío no es isquemia)', () => {
    // Sellado parcial + AC baja + perfusión de tejido casi nula: no es colapso
    // por presión, es un dedo mal apoyado o frío. No debe declarar HEAVY.
    const reading = feed(state, 40, {
      sealRatio: 0.2,
      perfusedFraction: 0.05,
      perfusionIndex: 0.0006,
      dcLevel: 190,
      roiRedCv: 0.004,
    });

    expect(reading.blanching).toBeLessThan(0.55);
    expect(reading.state).not.toBe('HEAVY');
    expect(reading.guidance.action).not.toBe('RELEASE');
  });

  it('dedo frío con DC normal no se lee como blanqueo en el gauge', () => {
    // Con referencia establecida, AC baja y DC SIN subir: es baja perfusión por
    // frío, no isquemia. El índice de blanqueo debe quedar en cero.
    feed(state, 45);
    const reading = feed(state, 30, {
      sealRatio: 0.62,
      perfusedFraction: 0.05,
      perfusionIndex: 0.0006,
      dcLevel: 150,
      roiRedCv: 0.004,
    });

    expect(reading.blanching).toBe(0);
    expect(reading.state).toBe('LIGHT');
    expect(reading.guidance.action).toBe('PRESS_MORE');
  });

  it('isquemia extrema con cero perfusión se detecta igual (el DC delata la fuerza)', () => {
    // Caso límite que una compuerta por "fracción perfundida" apagaba: cuando el
    // colapso es total no queda ningún píxel perfundido, así que exigir perfusión
    // para diagnosticar blanqueo dejaba pasar justo la isquemia más severa.
    feed(state, 45);
    const reading = feed(state, 20, {
      sealRatio: 0.92,
      perfusedFraction: 0,
      perfusionIndex: 0.0002,
      dcLevel: 220,
      roiRedCv: 0.005,
    });

    expect(reading.blanching).toBeGreaterThan(0.5);
    expect(reading.state).toBe('HEAVY');
    expect(reading.guidance.action).toBe('RELEASE');
  });

  it('exige histéresis para entrar y salir de HEAVY', () => {
    feed(state, 45);
    // 4 frames de presión excesiva: la evidencia ya es clara, pero HEAVY aún no
    // está confirmado. Lo esencial es que NUNCA afirme "óptimo" en este punto.
    const almost = feed(state, 4, {
      sealRatio: 0.9,
      perfusedFraction: 0.7,
      perfusionIndex: 0.0005,
      dcLevel: 215,
      roiRedCv: 0.006,
    });
    expect(almost.state).not.toBe('HEAVY');
    expect(almost.reason).not.toBe('OPTIMAL');
    expect(almost.guidance.action).not.toBe('HOLD');

    const confirmed = feed(state, 10, {
      sealRatio: 0.9,
      perfusedFraction: 0.7,
      perfusionIndex: 0.0005,
      dcLevel: 215,
      roiRedCv: 0.006,
    });
    expect(confirmed.state).toBe('HEAVY');
    expect(confirmed.guidance.action).toBe('RELEASE');

    // Un parpadeo breve de señal buena NO debe borrar el colapso (anti-flicker).
    const afterBlip = feed(state, 2, HEALTHY);
    expect(afterBlip.state).toBe('HEAVY');
    expect(afterBlip.guidance.action).toBe('RELEASE');

    // Contacto sano SOSTENIDO sí debe recuperar: el usuario ya corrigió.
    const recovered = feed(state, 20, HEALTHY);
    expect(recovered.state).toBe('IDEAL');
    expect(recovered.reason).toBe('OPTIMAL');
    expect(recovered.guidance.action).toBe('HOLD');
  });

  it('la guía no cambia de texto mientras el veredicto se confirma', () => {
    // Defecto real observado: durante la histéresis de entrada la guía alternaba
    // "presiona más" → "mantén" → "suelta" en ~0,2 s sin que el estado real
    // hubiera cambiado. El texto debe seguir al veredicto asentado.
    feed(state, 45);
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const r = observeTransmuralPressure(state, {
        sealRatio: 0.9,
        perfusedFraction: 0.7,
        motionScore: 0.05,
        perfusionIndex: 0.0005,
        dcLevel: 215,
        roiRedCv: 0.006,
      });
      seen.add(r.guidance.headline);
    }
    // A lo sumo dos estados: "ajustando" y el veredicto final. Nunca tres.
    expect(seen.size).toBeLessThanOrEqual(2);
    expect(seen.has('PRESIÓN ÓPTIMA · MANTÉN')).toBe(false);
  });

  it('el grado crece de forma monótona al aumentar el DC (eje de fuerza)', () => {
    feed(state, 45);
    const fractions: number[] = [];
    const steps = [
      { dcLevel: 170, perfusionIndex: 0.003, roiRedCv: 0.04 },
      { dcLevel: 195, perfusionIndex: 0.0015, roiRedCv: 0.02 },
      { dcLevel: 220, perfusionIndex: 0.0006, roiRedCv: 0.008 },
    ];
    for (const step of steps) {
      const reading = feed(state, 14, {
        ...step,
        sealRatio: 0.7,
        perfusedFraction: 0.6,
      });
      fractions.push(reading.fraction);
    }
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1] - 0.001);
    }
    expect(fractions[fractions.length - 1]).toBeGreaterThan(fractions[0]);
  });

  it('sin línea base de DC no amplifica ruido ni declara colapso', () => {
    feed(state, 45);
    const reading = feed(state, 20, {
      sealRatio: 0.9,
      perfusedFraction: 0.7,
      perfusionIndex: 0.0005,
      dcLevel: 2,
      roiRedCv: 0.001,
    });

    expect(reading.forceProxy).toBe(0);
    expect(reading.state).not.toBe('HEAVY');
  });

  it('el movimiento congela el grado en lugar de inventar un cambio', () => {
    const baseline = feed(state, 45);
    const moving = feed(state, 6, {
      sealRatio: 0.9,
      perfusedFraction: 0.7,
      perfusionIndex: 0.0005,
      dcLevel: 215,
      roiRedCv: 0.006,
      motionScore: 0.9,
    });

    expect(moving.reason).toBe('MOTION');
    expect(moving.state).toBe('IDEAL');
    expect(moving.fraction).toBeCloseTo(baseline.fraction, 5);
    expect(moving.guidance.action).toBe('WAIT');
  });

  it('cada veredicto produce una acción distinta y coherente', () => {
    const actions = new Set<string>();
    actions.add(feed(state, 40).guidance.action);

    resetTransmuralState(state);
    actions.add(
      feed(state, 40, {
        sealRatio: 0.14,
        perfusedFraction: 0.1,
        perfusionIndex: 0.0008,
        dcLevel: 60,
        roiRedCv: 0.02,
      }).guidance.action,
    );

    resetTransmuralState(state);
    feed(state, 45);
    actions.add(
      feed(state, 20, {
        sealRatio: 0.9,
        perfusedFraction: 0.7,
        perfusionIndex: 0.0005,
        dcLevel: 215,
        roiRedCv: 0.006,
      }).guidance.action,
    );

    resetTransmuralState(state);
    actions.add(
      feed(state, 30, {
        sealRatio: 0.03,
        perfusedFraction: 0,
        perfusionIndex: 0,
        dcLevel: 0,
        roiRedCv: 0,
      }).guidance.action,
    );

    expect(actions).toEqual(new Set(['HOLD', 'PRESS_MORE', 'RELEASE', 'REPOSITION']));
  });

  it('la guía nunca contradice el veredicto', () => {
    feed(state, 45);
    const heavy = feed(state, 20, {
      sealRatio: 0.9,
      perfusedFraction: 0.7,
      perfusionIndex: 0.0005,
      dcLevel: 215,
      roiRedCv: 0.006,
    });
    expect(heavy.state).toBe('HEAVY');
    expect(heavy.guidance.action).toBe('RELEASE');
    expect(heavy.guidance.progress).toBeLessThan(0.6);

    resetTransmuralState(state);
    const ideal = feed(state, 45);
    expect(ideal.state).toBe('IDEAL');
    expect(ideal.guidance.action).toBe('HOLD');
    expect(ideal.guidance.progress).toBeGreaterThan(0.8);
  });

  it('resetTransmuralState limpia el episodio (pico, sellado y grado)', () => {
    feed(state, 45);
    resetTransmuralState(state);

    const reading = feed(state, 1, {
      sealRatio: 0,
      perfusedFraction: 0,
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
      sealRatio: 0.9,
      perfusedFraction: 0.7,
      perfusionIndex: 0.0005,
      dcLevel: 215,
      roiRedCv: 0.006,
      motionScore: 0.9,
    });
    expect(moving.state).toBe('IDEAL');
    expect(moving.reason).toBe('MOTION');
  });
});