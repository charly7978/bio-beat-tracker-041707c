import { describe, expect, it } from 'vitest';
import {
  MeasurementWindowValidator,
  WINDOW_SECONDS,
  type ValidationFrame,
} from '../MeasurementWindowValidator';

function goodFrame(fps = 30): ValidationFrame {
  return {
    sqi: 70,
    pi: 0.01,
    fps,
    jitter: 5,
    motion: 0.05,
    isClipping: false,
    hasContact: true,
  };
}

function frames(n: number, fps = 30): ValidationFrame[] {
  return Array.from({ length: n }, () => goodFrame(fps));
}

describe('MeasurementWindowValidator (ventanas temporales reales)', () => {
  it('acepta HR con 12 s de reloj y FPS suficiente (300 frames @25fps)', () => {
    // El reloj (12 s ≥ 10 s) manda sobre el conteo: a 25 fps el gate de
    // rendimiento (≥24) pasa y HR queda listo.
    const v = MeasurementWindowValidator.validate(frames(300, 25), 12);
    expect(v.accepted).toBe(true);
    expect(v.vitalReadiness.hr).toBe(true);
    expect(v.qualitySummary.observedSeconds).toBe(12);
  });

  it('rechaza por FPS bajo aunque la duración alcance (300 frames @15fps = 20 s)', () => {
    // La duración ya no se supone: 20 s reales, pero el gate de rendimiento
    // (<24 fps) rechaza con motivo explícito en vez de validar a ciegas.
    const v = MeasurementWindowValidator.validate(frames(300, 15), 20);
    expect(v.accepted).toBe(false);
    expect(v.rejectionReasons.join(' ')).toContain('FPS');
    expect(v.qualitySummary.observedSeconds).toBe(20);
  });

  it('rechaza por corta aunque haya muchos frames si el reloj dice <10 s', () => {
    // 600 frames en 5 s (120 fps o reloj corto): la duración real manda.
    const v = MeasurementWindowValidator.validate(frames(600, 120), 5);
    expect(v.accepted).toBe(false);
    expect(v.vitalReadiness.hr).toBe(false);
    expect(v.rejectionReasons[0]).toContain('5.0 s');
  });

  it('estima el tiempo como n/fps observado cuando no hay reloj de sesión', () => {
    // 300 frames @30fps sin elapsed ⇒ 10 s estimados ⇒ HR listo.
    const v = MeasurementWindowValidator.validate(frames(300, 30));
    expect(v.vitalReadiness.hr).toBe(true);
    expect(v.qualitySummary.observedSeconds).toBeCloseTo(10, 5);
  });

  it('escala BP/resp/arritmia por segundos observados, no por conteo', () => {
    const v15 = MeasurementWindowValidator.validate(frames(450, 30), 15);
    expect(v15.vitalReadiness.hr).toBe(true);
    expect(v15.vitalReadiness.bp).toBe(false);

    const v25 = MeasurementWindowValidator.validate(frames(750, 30), 25);
    expect(v25.vitalReadiness.bp).toBe(true);
    expect(v25.vitalReadiness.respiration).toBe(false);

    const v45 = MeasurementWindowValidator.validate(frames(1350, 30), 45);
    expect(v45.vitalReadiness.respiration).toBe(true);
    expect(v45.vitalReadiness.arrhythmia).toBe(true);
  });

  it('rechaza evidencia insuficiente (<30 frames) sin importar el reloj', () => {
    const v = MeasurementWindowValidator.validate(frames(10, 30), 60);
    expect(v.accepted).toBe(false);
    expect(v.vitalReadiness.hr).toBe(false);
  });

  it('rechaza SQI mediano bajo y contacto inestable', () => {
    const bad = frames(400, 30).map((f) => ({ ...f, sqi: 10, hasContact: false }));
    const v = MeasurementWindowValidator.validate(bad, 15);
    expect(v.accepted).toBe(false);
    expect(v.vitalReadiness.hr).toBe(false);
    expect(v.rejectionReasons.length).toBeGreaterThan(0);
  });

  it('expone los umbrales temporales como constante auditable', () => {
    expect(WINDOW_SECONDS.MIN_ANY).toBe(10);
    expect(WINDOW_SECONDS.MIN_BP).toBe(20);
    expect(WINDOW_SECONDS.MIN_RESP).toBe(30);
    expect(WINDOW_SECONDS.MIN_ARRHYTHMIA).toBe(40);
  });
});
