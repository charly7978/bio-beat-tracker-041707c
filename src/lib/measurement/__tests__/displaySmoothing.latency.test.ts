import { describe, expect, it } from 'vitest';
import { VitalDisplayFilter } from '../displaySmoothing';
import type { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';
import type { VitalMeasurement, MeasurementStatus } from '@/types/measurements';

// ─── Helpers ──────────────────────────────────────────────────────────────

function vital(
  hr: number | null,
  spo2: number | null,
  sys: number | null,
  dia: number | null,
  hrStatus: MeasurementStatus = 'VALID',
  spo2Status: MeasurementStatus = 'VALID',
  bpStatus: MeasurementStatus = 'VALID',
): VitalSignsResult {
  const mk = <T>(value: T | null, status: MeasurementStatus): VitalMeasurement<T> => ({
    name: 'test',
    value,
    unit: '',
    timestamp: 0,
    confidence: 0.9,
    status,
    reason: '',
    signalQuality: { sqi: 80, perfusionIndex: 0.01, snr: null, periodicity: null, motionScore: null, saturationRatio: 0, frameDropRatio: 0, fpsEffective: 30, timestampJitterMs: 0 },
    diagnostics: {},
  });
  return {
    heartRate: mk(hr, hrStatus),
    spo2: mk(spo2, spo2Status),
    bloodPressure: mk(sys !== null && dia !== null ? { systolic: sys, diastolic: dia } : null, bpStatus),
    respiration: mk(null, 'LOW_SIGNAL_QUALITY'),
    arrhythmia: mk({ count: 0, status: '' }, 'LOW_SIGNAL_QUALITY'),
    signalQuality: 80,
    isCalibrating: false,
    calibrationProgress: 0,
  };
}

// ─── 1. Settling Latency (A/B) ────────────────────────────────────────────

describe('VitalDisplayFilter – settling latency', () => {
  it('HR converge a nuevo valor estable en ≤ 10 frames (alpha=0.3)', () => {
    const f = new VitalDisplayFilter();
    // Warm-up a 72
    for (let i = 0; i < 20; i++) f.update(vital(72, null, null, null));
    // Salto a 90
    let frames = 0;
    let cur = 0;
    for (let i = 0; i < 30; i++) {
      const r = f.update(vital(90, null, null, null));
      cur = r.heartRate.value!;
      if (Math.abs(cur - 90) <= 1) { frames = i + 1; break; }
    }
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThanOrEqual(10);
  });

  it('SpO2 converge a nuevo valor estable en ≤ 10 frames', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(null, 97, null, null));
    let frames = 0;
    for (let i = 0; i < 30; i++) {
      const r = f.update(vital(null, 94, null, null));
      if (Math.abs(r.spo2.value! - 94) <= 1) { frames = i + 1; break; }
    }
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThanOrEqual(10);
  });

  it('BP converge a nuevo valor estable en ≤ 12 frames', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(null, null, 120, 80));
    let frames = 0;
    for (let i = 0; i < 40; i++) {
      const r = f.update(vital(null, null, 135, 88));
      const v = r.bloodPressure.value!;
      if (Math.abs(v.systolic - 135) <= 2 && Math.abs(v.diastolic - 88) <= 2) { frames = i + 1; break; }
    }
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThanOrEqual(12);
  });

  it('salto de zona clínica (HR normal → taquicardia) es instantáneo (zone crossing)', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(72, null, null, null));
    // 72 es NORMAL, 130 es TAQUICARDIA → zone crossing → instantáneo
    const r = f.update(vital(130, null, null, null));
    expect(r.heartRate.value).toBe(130);
  });

  it('salto de zona clínica (SpO2 normoxia → hipoxemia) es instantáneo', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(null, 97, null, null));
    // 97 = NORMOXIA, 88 = HIPOXEMIA MOD → zone crossing
    const r = f.update(vital(null, 88, null, null));
    expect(r.spo2.value).toBe(88);
  });

  it('salto de zona clínica (BP normal → hipertensión) es instantáneo', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(null, null, 118, 76));
    // 118/76 = NORMAL, 145/92 = HIPERTENSIÓN
    const r = f.update(vital(null, null, 145, 92));
    expect(r.bloodPressure.value).toEqual({ systolic: 145, diastolic: 92 });
  });

  it('valor withheld (LOW_SIGNAL_QUALITY) resetea el filtro a 0', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(72, null, null, null));
    const r = f.update(vital(72, null, null, null, 'LOW_SIGNAL_QUALITY'));
    expect(r.heartRate.value).toBe(0);
  });

  it('valor NO_VALID_SIGNAL resetea el filtro a 0', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(null, 97, null, null));
    const r = f.update(vital(null, 97, null, null, 'VALID', 'NO_VALID_SIGNAL'));
    expect(r.spo2.value).toBe(0);
  });
});

// ─── 2. Precision ──────────────────────────────────────────────────────────

describe('VitalDisplayFilter – precision', () => {
  it('HR se redondea al entero más cercano', () => {
    const f = new VitalDisplayFilter();
    // Warm-up a 72
    for (let i = 0; i < 20; i++) f.update(vital(72, null, null, null));
    // Saltos pequeños dentro de la misma zona para verificar redondeo
    const r = f.update(vital(73, null, null, null));
    expect(r.heartRate.value).toBe(Math.round(72 + (73 - 72) * 0.3));
  });

  it('SpO2 se redondea al entero más cercano', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(null, 97, null, null));
    const r = f.update(vital(null, 96, null, null));
    expect(r.spo2.value).toBe(Math.round(97 + (96 - 97) * 0.3));
  });

  it('BP se redondea al entero más cercano', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(null, null, 120, 80));
    const r = f.update(vital(null, null, 121, 81));
    expect(r.bloodPressure.value!.systolic).toBe(Math.round(120 + (121 - 120) * 0.3));
    expect(r.bloodPressure.value!.diastolic).toBe(Math.round(80 + (81 - 80) * 0.3));
  });

  it('primer valor válido (prev=0) se adopta directamente sin EMA', () => {
    const f = new VitalDisplayFilter();
    const r = f.update(vital(80, null, null, null));
    expect(r.heartRate.value).toBe(80);
  });

  it('primer valor válido de SpO2 se adopta directamente', () => {
    const f = new VitalDisplayFilter();
    const r = f.update(vital(null, 98, null, null));
    expect(r.spo2.value).toBe(98);
  });

  it('primer valor válido de BP se adopta directamente', () => {
    const f = new VitalDisplayFilter();
    const r = f.update(vital(null, null, 125, 82));
    expect(r.bloodPressure.value).toEqual({ systolic: 125, diastolic: 82 });
  });

  it('null input devuelve null (no hay valor que mostrar)', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(72, null, null, null));
    const r = f.update(vital(null, null, null, null));
    // null → el filtro devuelve null (no hay valor válido)
    expect(r.heartRate.value).toBeNull();
  });
});

// ─── 3. Resets ────────────────────────────────────────────────────────────

describe('VitalDisplayFilter – resets', () => {
  it('reset() sin argumentos resetea todos los campos', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(72, 97, 120, 80));
    f.reset();
    const r = f.update(vital(90, 94, 135, 88));
    // Después de reset, el primer valor se adopta directamente (prev=0)
    expect(r.heartRate.value).toBe(90);
    expect(r.spo2.value).toBe(94);
    expect(r.bloodPressure.value).toEqual({ systolic: 135, diastolic: 88 });
  });

  it('reset([heartRate]) resetea solo HR', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(72, 97, 120, 80));
    f.reset(['heartRate']);
    const r = f.update(vital(90, 96, 121, 81));
    // HR: prev=0 → adopta 90 directamente
    expect(r.heartRate.value).toBe(90);
    // SpO2: prev=97 → EMA → round(97 + (96-97)*0.3) = round(96.7) = 97
    expect(r.spo2.value).toBe(97);
    // BP: prev=120/80 → EMA
    expect(r.bloodPressure.value!.systolic).toBe(Math.round(120 + (121 - 120) * 0.3));
    expect(r.bloodPressure.value!.diastolic).toBe(Math.round(80 + (81 - 80) * 0.3));
  });

  it('reset([spo2]) resetea solo SpO2', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(72, 97, 120, 80));
    f.reset(['spo2']);
    const r = f.update(vital(73, 95, 121, 81));
    expect(r.heartRate.value).toBe(Math.round(72 + (73 - 72) * 0.3));
    expect(r.spo2.value).toBe(95); // prev=0 → directo
    expect(r.bloodPressure.value!.systolic).toBe(Math.round(120 + (121 - 120) * 0.3));
  });

  it('reset([bloodPressure]) resetea solo BP', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(72, 97, 120, 80));
    f.reset(['bloodPressure']);
    const r = f.update(vital(73, 96, 130, 85));
    expect(r.heartRate.value).toBe(Math.round(72 + (73 - 72) * 0.3));
    expect(r.spo2.value).toBe(Math.round(97 + (96 - 97) * 0.3));
    expect(r.bloodPressure.value).toEqual({ systolic: 130, diastolic: 85 }); // prev=0 → directo
  });

  it('reset selectivo no afecta campos no incluidos', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(72, 97, 120, 80));
    f.reset(['heartRate']);
    // SpO2 y BP siguen en 97 y 120/80 (el EMA continúa desde ese estado)
    const r = f.update(vital(72, 97, 120, 80));
    // HR: prev=0 → adopta 72
    expect(r.heartRate.value).toBe(72);
    // SpO2: prev=97, next=97 → 97
    expect(r.spo2.value).toBe(97);
    // BP: prev=120/80, next=120/80 → 120/80
    expect(r.bloodPressure.value).toEqual({ systolic: 120, diastolic: 80 });
  });

  it('withheld status resetea el campo específico sin afectar otros', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(72, 97, 120, 80));
    // HR withheld, pero SpO2 y BP válidos
    const r = f.update(vital(72, 96, 121, 81, 'LOW_SIGNAL_QUALITY'));
    expect(r.heartRate.value).toBe(0);
    expect(r.spo2.value).toBe(Math.round(97 + (96 - 97) * 0.3));
    expect(r.bloodPressure.value!.systolic).toBe(Math.round(120 + (121 - 120) * 0.3));
  });
});

// ─── 4. Clinical Boundaries ────────────────────────────────────────────────

describe('VitalDisplayFilter – clinical boundaries', () => {
  it('HR cruza de BRADICARDIA a NORMAL instantáneamente (zone crossing)', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(45, null, null, null));
    const r = f.update(vital(65, null, null, null));
    expect(r.heartRate.value).toBe(65);
  });

  it('HR cruza de NORMAL a TAQUICARDIA instantáneamente', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(80, null, null, null));
    const r = f.update(vital(130, null, null, null));
    expect(r.heartRate.value).toBe(130);
  });

  it('SpO2 cruza de HIPOXEMIA a NORMOXIA instantáneamente', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(null, 88, null, null));
    const r = f.update(vital(null, 96, null, null));
    expect(r.spo2.value).toBe(96);
  });

  it('BP cruza de HIPOTENSIÓN a NORMAL instantáneamente', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(null, null, 85, 55));
    const r = f.update(vital(null, null, 115, 75));
    expect(r.bloodPressure.value).toEqual({ systolic: 115, diastolic: 75 });
  });

  it('BP cruza de NORMAL a HIPERTENSIÓN instantáneamente', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(null, null, 118, 76));
    const r = f.update(vital(null, null, 142, 92));
    expect(r.bloodPressure.value).toEqual({ systolic: 142, diastolic: 92 });
  });

  it('cambio dentro de la misma zona usa EMA (no instantáneo)', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(72, null, null, null));
    // 72→80 ambos NORMAL
    const r = f.update(vital(80, null, null, null));
    expect(r.heartRate.value).toBe(Math.round(72 + (80 - 72) * 0.3));
    expect(r.heartRate.value).not.toBe(80);
  });

  it('SpO2 cambio dentro de NORMOXIA usa EMA', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(null, 96, null, null));
    const r = f.update(vital(null, 98, null, null));
    expect(r.spo2.value).toBe(Math.round(96 + (98 - 96) * 0.3));
  });

  it('BP cambio dentro de NORMAL usa EMA', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(null, null, 118, 76));
    const r = f.update(vital(null, null, 122, 78));
    expect(r.bloodPressure.value!.systolic).toBe(Math.round(118 + (122 - 118) * 0.3));
    expect(r.bloodPressure.value!.diastolic).toBe(Math.round(76 + (78 - 76) * 0.3));
  });

  it('INSUFFICIENT_WINDOW resetea SpO2 a 0', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(null, 97, null, null));
    const r = f.update(vital(null, 97, null, null, 'VALID', 'INSUFFICIENT_WINDOW'));
    expect(r.spo2.value).toBe(0);
  });

  it('INVALID resetea BP a {0,0}', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(null, null, 120, 80));
    const r = f.update(vital(null, null, 120, 80, 'VALID', 'VALID', 'INVALID'));
    // BP inválido → devuelve { systolic: 0, diastolic: 0 }
    expect(r.bloodPressure.value).toEqual({ systolic: 0, diastolic: 0 });
  });

  it('HR con valor 0 y status VALID no actualiza el filtro', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(72, null, null, null));
    const r = f.update(vital(0, null, null, null));
    expect(r.heartRate.value).toBe(0);
  });

  it('SpO2 fuera de rango (>100) es aceptado por el filtro (validación es responsabilidad del estimador)', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(null, 97, null, null));
    const r = f.update(vital(null, 105, null, null));
    // El filtro no valida rangos fisiológicos; acepta 105 como valor numérico válido
    // La validación de rango (75-100) es responsabilidad del SpO2Calculator
    expect(r.spo2.value).toBe(99); // EMA: 97 + (105-97)*0.3 = 97+2.4 = 99.4 → round = 99
  });

  it('BP con solo systolic (diastolic=0) resetea a {0,0}', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(null, null, 120, 80));
    const r = f.update(vital(null, null, 120, 0));
    // BP inválido (diastolic=0) → devuelve { systolic: 0, diastolic: 0 }
    expect(r.bloodPressure.value).toEqual({ systolic: 0, diastolic: 0 });
  });
});

// ─── 5. Field Isolation ────────────────────────────────────────────────────

describe('VitalDisplayFilter – field isolation', () => {
  it('update con fields=[heartRate] no modifica SpO2 ni BP', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(72, 97, 120, 80));
    const r = f.update(vital(80, 95, 130, 85), ['heartRate']);
    expect(r.heartRate.value).toBe(Math.round(72 + (80 - 72) * 0.3));
    // SpO2 y BP no se tocan → devuelven el valor raw del input
    expect(r.spo2.value).toBe(95);
    expect(r.bloodPressure.value).toEqual({ systolic: 130, diastolic: 85 });
  });

  it('update con fields=[spo2] no modifica HR ni BP', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(72, 97, 120, 80));
    const r = f.update(vital(80, 95, 130, 85), ['spo2']);
    expect(r.heartRate.value).toBe(80);
    expect(r.spo2.value).toBe(Math.round(97 + (95 - 97) * 0.3));
    expect(r.bloodPressure.value).toEqual({ systolic: 130, diastolic: 85 });
  });

  it('update con fields=[bloodPressure] no modifica HR ni SpO2', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(72, 97, 120, 80));
    const r = f.update(vital(80, 95, 130, 85), ['bloodPressure']);
    expect(r.heartRate.value).toBe(80);
    expect(r.spo2.value).toBe(95);
    expect(r.bloodPressure.value!.systolic).toBe(Math.round(120 + (130 - 120) * 0.3));
    expect(r.bloodPressure.value!.diastolic).toBe(Math.round(80 + (85 - 80) * 0.3));
  });
});

// ─── 6. Stability / No Oscillation ────────────────────────────────────────

describe('VitalDisplayFilter – stability', () => {
  it('valor constante converge exactamente al valor (sin oscilación residual)', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 50; i++) f.update(vital(75, null, null, null));
    const r = f.update(vital(75, null, null, null));
    expect(r.heartRate.value).toBe(75);
  });

  it('SpO2 constante converge exactamente', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 50; i++) f.update(vital(null, 96, null, null));
    const r = f.update(vital(null, 96, null, null));
    expect(r.spo2.value).toBe(96);
  });

  it('BP constante converge exactamente', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 50; i++) f.update(vital(null, null, 118, 76));
    const r = f.update(vital(null, null, 118, 76));
    expect(r.bloodPressure.value).toEqual({ systolic: 118, diastolic: 76 });
  });

  it('oscilación pequeña no crece (filtro estable)', () => {
    const f = new VitalDisplayFilter();
    for (let i = 0; i < 20; i++) f.update(vital(72, null, null, null));
    const vals: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = f.update(vital(i % 2 === 0 ? 73 : 71, null, null, null));
      vals.push(r.heartRate.value!);
    }
    // No debe haber oscilación creciente
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    expect(max - min).toBeLessThanOrEqual(2);
  });
});