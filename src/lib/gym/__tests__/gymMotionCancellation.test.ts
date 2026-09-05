import { describe, it, expect, beforeEach } from 'vitest';
import { GymMotionCancellation } from '../gymMotionCancellation';

describe('GymMotionCancellation', () => {
  let canceller: GymMotionCancellation;

  beforeEach(() => {
    canceller = new GymMotionCancellation(30);
  });

  it('inicializa con estado seguro por defecto', () => {
    const state = canceller.getState();
    expect(state.kalmanBpm).toBeCloseTo(75, 1);
    expect(state.isNotchActive).toBe(false);
    expect(state.cadenceBpm).toBe(0);
  });

  it('detecta cadencia de movimiento a partir de flujo optico e IMU', () => {
    // Generar 100 muestras de movimiento ritmico a ~2.5 Hz (150 pasos/minuto)
    const freqCadence = 2.5;
    const fs = 30;

    for (let i = 0; i < 90; i++) {
      const t = i / fs;
      const motionSignal = Math.sin(2 * Math.PI * freqCadence * t) * 5.0;
      canceller.pushMotionSample(Math.abs(motionSignal));
    }

    const state = canceller.getState();
    expect(state.motionIntensity).toBeGreaterThan(0.5);
    expect(state.cadenceBpm).toBeGreaterThan(120);
    expect(state.cadenceBpm).toBeLessThan(180);
    expect(state.isNotchActive).toBe(true);
  });

  it('el filtro notch atenua la frecuencia de cadencia de paso', () => {
    const fs = 30;
    const cadenceHz = 2.4;

    // Entrenar referencia de movimiento para activar notch en ~2.4 Hz
    for (let i = 0; i < 90; i++) {
      const t = i / fs;
      const motion = Math.sin(2 * Math.PI * cadenceHz * t) * 6;
      canceller.pushMotionSample(Math.abs(motion));
    }

    // Filtrar una onda senoidal exactamente en la frecuencia de cadencia
    let inputEnergy = 0;
    let outputEnergy = 0;

    for (let i = 0; i < 60; i++) {
      const t = i / fs;
      const ppgNoise = Math.sin(2 * Math.PI * cadenceHz * t) * 10;
      const filtered = canceller.filterPPGSignal(ppgNoise);

      if (i > 20) {
        inputEnergy += ppgNoise * ppgNoise;
        outputEnergy += filtered * filtered;
      }
    }

    // La energia de salida en la banda de cadencia debe estar reducida por el notch
    expect(outputEnergy).toBeLessThan(inputEnergy * 0.85);
  });

  it('el filtro de Kalman converge suavemente a la frecuencia cardiaca de ejercicio', () => {
    const targetBpm = 145;
    let estimatedBpm = 75;

    // 40 actualizaciones (aprox 40 cuadros ~ 1.3 seg a 30 FPS)
    for (let i = 0; i < 40; i++) {
      estimatedBpm = canceller.updateKalmanHR(targetBpm, 1 / 30, 85);
    }

    expect(estimatedBpm).toBeGreaterThan(120);
    expect(estimatedBpm).toBeLessThanOrEqual(150);
  });

  it('el filtro de Kalman resiste saltos espurios cuando la calidad de señal cae', () => {
    // Llevar Kalman a 130 BPM con buena calidad
    for (let i = 0; i < 30; i++) {
      canceller.updateKalmanHR(130, 1 / 30, 90);
    }

    const baseline = canceller.getState().kalmanBpm;

    // Intento de salto abrupto a 210 BPM con calidad muy baja (ruido de choque)
    const jumped = canceller.updateKalmanHR(210, 1 / 30, 15);

    // El filtro debe resistir el salto brusco
    expect(Math.abs(jumped - baseline)).toBeLessThan(15);
  });

  it('reset restaura el filtro de Kalman y el cancelador de movimiento', () => {
    canceller.pushMotionSample(10);
    canceller.updateKalmanHR(160, 1 / 30, 95);

    canceller.reset();

    const state = canceller.getState();
    expect(state.kalmanBpm).toBeCloseTo(75, 1);
    expect(state.cadenceBpm).toBe(0);
    expect(state.motionIntensity).toBe(0);
    expect(state.isNotchActive).toBe(false);
  });
});
