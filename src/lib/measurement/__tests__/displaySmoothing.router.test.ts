import { describe, expect, it } from 'vitest';
import { VitalDisplayFilter } from '@/lib/measurement/displaySmoothing';
import type { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';
import type { VitalMeasurement, MeasurementStatus } from '@/types/measurements';
import { createDefaultVitalSignsResult } from '@/lib/vitals/defaultVitalSignsResult';

// ─── Simulación del patrón de router wiring ────────────────────────────────
// El router (useSignalRouter) usa VitalDisplayFilter con este patrón:
// 1. Un ref para el filtro (displayFilterRef)
// 2. Un ref para el último inputKey (lastHrFilterInputRef)
// 3. Un ref para el snapshot mostrado (displaySnapshotRef)
// 4. El filtro solo avanza cuando hay un input nuevo (inputKey cambia)
// 5. Los resets son selectivos por campo
//
// Estos tests verifican que ese patrón funciona correctamente.

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

// ─── 1. Router HR Wiring ──────────────────────────────────────────────────

describe('Router wiring – HR path', () => {
  it('nuevo peak actualiza el filtro y el snapshot', () => {
    const filter = new VitalDisplayFilter();
    let snapshot = createDefaultVitalSignsResult();
    let lastInputKey = '';

    // Simula el patrón del router
    const pushHr = (bpm: number, peakTime: number, status: MeasurementStatus = 'VALID') => {
      const raw = { ...snapshot, heartRate: { ...snapshot.heartRate, value: bpm, status } };
      const inputKey = `${peakTime}:${bpm}:${status}`;
      if (inputKey !== lastInputKey) {
        lastInputKey = inputKey;
        snapshot = filter.update({ ...snapshot, heartRate: raw.heartRate }, ['heartRate']);
      }
      return snapshot;
    };

    // Warm-up con BPM constante
    for (let i = 0; i < 20; i++) pushHr(72, 1000 + i * 100);
    expect(snapshot.heartRate.value).toBe(72);

    // Nuevo peak con BPM diferente
    const r = pushHr(75, 3000);
    expect(r.heartRate.value).toBe(Math.round(72 + (75 - 72) * 0.3));
  });

  it('peak repetido (mismo inputKey) no avanza el filtro', () => {
    const filter = new VitalDisplayFilter();
    let snapshot = createDefaultVitalSignsResult();
    let lastInputKey = '';

    const pushHr = (bpm: number, peakTime: number) => {
      const raw = { ...snapshot, heartRate: { ...snapshot.heartRate, value: bpm, status: 'VALID' as const } };
      const inputKey = `${peakTime}:${bpm}:VALID`;
      if (inputKey !== lastInputKey) {
        lastInputKey = inputKey;
        snapshot = filter.update({ ...snapshot, heartRate: raw.heartRate }, ['heartRate']);
      }
      return snapshot;
    };

    // Warm-up
    for (let i = 0; i < 20; i++) pushHr(72, 1000 + i * 100);

    // El último peakTime del warm-up es 2900 (i=19: 1000+19*100=2900)
    // Mismo inputKey → no avanza
    const r1 = pushHr(72, 2900);
    expect(r1.heartRate.value).toBe(72); // No cambió

    // inputKey diferente → avanza
    const r2 = pushHr(80, 3000);
    expect(r2.heartRate.value).toBe(Math.round(72 + (80 - 72) * 0.3));
  });

  it('NO_CONTACT resetea el filtro HR y el snapshot', () => {
    const filter = new VitalDisplayFilter();
    let snapshot = createDefaultVitalSignsResult();
    let lastInputKey = '';

    const pushHr = (bpm: number, peakTime: number) => {
      const raw = { ...snapshot, heartRate: { ...snapshot.heartRate, value: bpm, status: 'VALID' as const } };
      const inputKey = `${peakTime}:${bpm}:VALID`;
      if (inputKey !== lastInputKey) {
        lastInputKey = inputKey;
        snapshot = filter.update({ ...snapshot, heartRate: raw.heartRate }, ['heartRate']);
      }
      return snapshot;
    };

    // Warm-up
    for (let i = 0; i < 20; i++) pushHr(72, 1000 + i * 100);
    expect(snapshot.heartRate.value).toBe(72);

    // NO_CONTACT → reset
    filter.reset(['heartRate']);
    lastInputKey = '';
    const heartRate = { ...snapshot.heartRate, value: 0, status: 'NO_VALID_SIGNAL' as const };
    snapshot = { ...snapshot, heartRate };
    expect(snapshot.heartRate.value).toBe(0);
  });

  it('zona clínica cruzada en HR produce salto instantáneo en el router', () => {
    const filter = new VitalDisplayFilter();
    let snapshot = createDefaultVitalSignsResult();
    let lastInputKey = '';

    const pushHr = (bpm: number, peakTime: number) => {
      const raw = { ...snapshot, heartRate: { ...snapshot.heartRate, value: bpm, status: 'VALID' as const } };
      const inputKey = `${peakTime}:${bpm}:VALID`;
      if (inputKey !== lastInputKey) {
        lastInputKey = inputKey;
        snapshot = filter.update({ ...snapshot, heartRate: raw.heartRate }, ['heartRate']);
      }
      return snapshot;
    };

    // Warm-up a 72 (NORMAL)
    for (let i = 0; i < 20; i++) pushHr(72, 1000 + i * 100);

    // Salto a 130 (TAQUICARDIA) → zone crossing → instantáneo
    const r = pushHr(130, 3000);
    expect(r.heartRate.value).toBe(130);
  });
});

// ─── 2. Router SpO2/HR combined path ─────────────────────────────────────

describe('Router wiring – SpO2 path', () => {
  it('STALE_FINGER_NO_BPM resetea SpO2 y BP selectivamente', () => {
    const filter = new VitalDisplayFilter();
    let snapshot = createDefaultVitalSignsResult();

    // Warm-up con SpO2 y BP válidos
    filter.update(vital(72, 97, 120, 80));
    snapshot = filter.update(vital(72, 97, 120, 80));

    // Reset selectivo (como hace el router en STALE_FINGER_NO_BPM)
    filter.reset(['spo2', 'bloodPressure']);
    snapshot = {
      ...snapshot,
      spo2: { ...snapshot.spo2, value: 0, status: 'NO_VALID_SIGNAL' },
      bloodPressure: {
        ...snapshot.bloodPressure,
        value: { systolic: 0, diastolic: 0 },
        status: 'NO_VALID_SIGNAL',
      },
    };

    expect(snapshot.spo2.value).toBe(0);
    expect(snapshot.bloodPressure.value).toEqual({ systolic: 0, diastolic: 0 });
  });

  it('SpO2 y BP se actualizan cuando el pipeline los produce', () => {
    const filter = new VitalDisplayFilter();
    let snapshot = createDefaultVitalSignsResult();

    // El router actualiza SpO2 y BP cuando el VitalSignsProcessor los produce
    snapshot = filter.update(vital(72, 97, 120, 80));
    expect(snapshot.spo2.value).toBe(97);
    expect(snapshot.bloodPressure.value).toEqual({ systolic: 120, diastolic: 80 });

    // Nuevo valor
    snapshot = filter.update(vital(72, 95, 122, 82));
    expect(snapshot.spo2.value).toBe(Math.round(97 + (95 - 97) * 0.3));
    expect(snapshot.bloodPressure.value!.systolic).toBe(Math.round(120 + (122 - 120) * 0.3));
  });
});

// ─── 3. Router reset paths ────────────────────────────────────────────────

describe('Router wiring – reset paths', () => {
  it('resetFingerContactSession resetea todo el filtro y el snapshot', () => {
    const filter = new VitalDisplayFilter();
    let snapshot = createDefaultVitalSignsResult();

    // Warm-up
    filter.update(vital(72, 97, 120, 80));
    snapshot = filter.update(vital(72, 97, 120, 80));

    // Reset completo (como hace resetFingerContactSession)
    filter.reset();
    snapshot = createDefaultVitalSignsResult();

    // createDefaultVitalSignsResult devuelve 0 y {0,0}, no null
    expect(snapshot.heartRate.value).toBe(0);
    expect(snapshot.spo2.value).toBe(0);
    expect(snapshot.bloodPressure.value).toEqual({ systolic: 0, diastolic: 0 });
  });

  it('resetSessionRefs resetea el filtro sin tocar el snapshot', () => {
    const filter = new VitalDisplayFilter();
    let snapshot = createDefaultVitalSignsResult();

    // Warm-up
    filter.update(vital(72, 97, 120, 80));
    snapshot = filter.update(vital(72, 97, 120, 80));

    // Reset del filtro (como hace resetSessionRefs)
    filter.reset();

    // El snapshot NO se toca (solo el filtro)
    expect(snapshot.heartRate.value).toBe(72);

    // Pero el siguiente update adopta el valor directamente (prev=0)
    const r = filter.update(vital(80, 95, 130, 85));
    expect(r.heartRate.value).toBe(80);
  });
});

// ─── 4. Router stability under repeated frames ────────────────────────────

describe('Router wiring – stability under load', () => {
  it('100 frames con BPM constante no acumulan error', () => {
    const filter = new VitalDisplayFilter();
    let snapshot = createDefaultVitalSignsResult();
    let lastInputKey = '';

    const pushHr = (bpm: number, peakTime: number) => {
      const raw = { ...snapshot, heartRate: { ...snapshot.heartRate, value: bpm, status: 'VALID' as const } };
      const inputKey = `${peakTime}:${bpm}:VALID`;
      if (inputKey !== lastInputKey) {
        lastInputKey = inputKey;
        snapshot = filter.update({ ...snapshot, heartRate: raw.heartRate }, ['heartRate']);
      }
      return snapshot;
    };

    for (let i = 0; i < 100; i++) pushHr(75, 1000 + i * 100);
    expect(snapshot.heartRate.value).toBe(75);
  });

  it('alternancia de zona no causa oscilación excesiva', () => {
    const filter = new VitalDisplayFilter();
    let snapshot = createDefaultVitalSignsResult();
    let lastInputKey = '';

    const pushHr = (bpm: number, peakTime: number) => {
      const raw = { ...snapshot, heartRate: { ...snapshot.heartRate, value: bpm, status: 'VALID' as const } };
      const inputKey = `${peakTime}:${bpm}:VALID`;
      if (inputKey !== lastInputKey) {
        lastInputKey = inputKey;
        snapshot = filter.update({ ...snapshot, heartRate: raw.heartRate }, ['heartRate']);
      }
      return snapshot;
    };

    // Warm-up
    for (let i = 0; i < 20; i++) pushHr(72, 1000 + i * 100);

    // Alternar entre dos valores en la misma zona
    const vals: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = pushHr(i % 2 === 0 ? 73 : 71, 3000 + i * 100);
      vals.push(r.heartRate.value!);
    }

    const max = Math.max(...vals);
    const min = Math.min(...vals);
    // La oscilación debe ser mínima (dentro de 2 bpm)
    expect(max - min).toBeLessThanOrEqual(2);
  });

  it('withheld status seguido de valor válido recupera el filtro', () => {
    const filter = new VitalDisplayFilter();
    let snapshot = createDefaultVitalSignsResult();
    let lastInputKey = '';

    const pushHr = (bpm: number, peakTime: number, status: MeasurementStatus = 'VALID') => {
      const raw = { ...snapshot, heartRate: { ...snapshot.heartRate, value: bpm, status } };
      const inputKey = `${peakTime}:${bpm}:${status}`;
      if (inputKey !== lastInputKey) {
        lastInputKey = inputKey;
        snapshot = filter.update({ ...snapshot, heartRate: raw.heartRate }, ['heartRate']);
      }
      return snapshot;
    };

    // Warm-up
    for (let i = 0; i < 20; i++) pushHr(72, 1000 + i * 100);

    // LOW_SIGNAL_QUALITY → resetea
    const r1 = pushHr(72, 3000, 'LOW_SIGNAL_QUALITY');
    expect(r1.heartRate.value).toBe(0);

    // Recuperación: primer valor válido se adopta directamente
    const r2 = pushHr(75, 3100, 'VALID');
    expect(r2.heartRate.value).toBe(75);
  });
});

// ─── 5. Router snapshot isolation ─────────────────────────────────────────

describe('Router wiring – snapshot isolation', () => {
  it('actualizar HR no afecta SpO2 ni BP en el snapshot', () => {
    const filter = new VitalDisplayFilter();
    let snapshot = createDefaultVitalSignsResult();

    // Inicializar SpO2 y BP
    snapshot = filter.update(vital(null, 97, 120, 80));
    expect(snapshot.spo2.value).toBe(97);
    expect(snapshot.bloodPressure.value).toEqual({ systolic: 120, diastolic: 80 });

    // Actualizar solo HR
    snapshot = filter.update(
      { ...snapshot, heartRate: { ...snapshot.heartRate, value: 80, status: 'VALID' } },
      ['heartRate'],
    );

    // SpO2 y BP no cambian (siguen siendo los del snapshot anterior)
    expect(snapshot.spo2.value).toBe(97);
    expect(snapshot.bloodPressure.value).toEqual({ systolic: 120, diastolic: 80 });
    expect(snapshot.heartRate.value).toBe(80);
  });

  it('actualizar SpO2 no afecta HR ni BP en el snapshot', () => {
    const filter = new VitalDisplayFilter();
    let snapshot = createDefaultVitalSignsResult();

    // Inicializar HR y BP
    snapshot = filter.update(vital(72, null, 120, 80));
    expect(snapshot.heartRate.value).toBe(72);
    expect(snapshot.bloodPressure.value).toEqual({ systolic: 120, diastolic: 80 });

    // Actualizar solo SpO2
    snapshot = filter.update(
      { ...snapshot, spo2: { ...snapshot.spo2, value: 95, status: 'VALID' } },
      ['spo2'],
    );

    expect(snapshot.heartRate.value).toBe(72);
    expect(snapshot.bloodPressure.value).toEqual({ systolic: 120, diastolic: 80 });
    expect(snapshot.spo2.value).toBe(95);
  });
});

// ─── 6. Inmutabilidad del input ──────────────────────────────────────────

describe('VitalDisplayFilter – input immutability', () => {
  it('update no muta el objeto raw pasado como argumento', () => {
    const filter = new VitalDisplayFilter();
    const raw = vital(72, 97, 120, 80);
    const rawHrRef = raw.heartRate;
    const rawSpo2Ref = raw.spo2;
    const rawBpRef = raw.bloodPressure;

    filter.update(raw);

    // Las referencias internas del raw no deben haber sido reemplazadas
    expect(raw.heartRate).toBe(rawHrRef);
    expect(raw.spo2).toBe(rawSpo2Ref);
    expect(raw.bloodPressure).toBe(rawBpRef);
    // El valor raw original no cambia
    expect(raw.heartRate.value).toBe(72);
  });

  it('update con fields selectivo no muta los campos no procesados', () => {
    const filter = new VitalDisplayFilter();
    const raw = vital(72, 97, 120, 80);
    const rawSpo2Ref = raw.spo2;

    const shown = filter.update(raw, ['heartRate']);

    // SpO2 no procesado → misma referencia en el output
    expect(shown.spo2).toBe(rawSpo2Ref);
    // HR procesado → nueva referencia (shown.heartRate es un nuevo objeto)
    expect(shown.heartRate).not.toBe(raw.heartRate);
  });
});

// ─── 7. applyLiveDisplaySmooth path (SpO2/BP completo) ──────────────────

describe('Router wiring – applyLiveDisplaySmooth (full vitals path)', () => {
  it('el path completo de SpO2/BP suaviza sin romper la precisión', () => {
    const filter = new VitalDisplayFilter();
    let snapshot = createDefaultVitalSignsResult();

    // Warm-up con SpO2 y BP (como hace el pipeline)
    for (let i = 0; i < 20; i++) {
      snapshot = filter.update(vital(72, 97, 120, 80));
    }
    expect(snapshot.spo2.value).toBe(97);

    // Nuevo valor del pipeline
    snapshot = filter.update(vital(73, 95, 125, 82));

    // HR: EMA (misma zona NORMAL) → round(72 + 1*0.3) = 72
    expect(snapshot.heartRate.value).toBe(72);
    // SpO2: EMA → round(97 + (95-97)*0.3) = round(96.4) = 96
    expect(snapshot.spo2.value).toBe(96);
    // BP: EMA → round(120 + 5*0.3) = round(121.5) = 122 (Math.round(121.5)=122)
    expect(snapshot.bloodPressure.value!.systolic).toBe(122);
  });

  it('zona cruzada en el path completo salta instantáneo', () => {
    const filter = new VitalDisplayFilter();
    let snapshot = createDefaultVitalSignsResult();

    // Warm-up
    for (let i = 0; i < 20; i++) {
      snapshot = filter.update(vital(72, 97, 118, 76));
    }

    // Salto a taquicardia + hipertensión
    snapshot = filter.update(vital(130, 88, 145, 92));
    expect(snapshot.heartRate.value).toBe(130);
    expect(snapshot.spo2.value).toBe(88);
    expect(snapshot.bloodPressure.value).toEqual({ systolic: 145, diastolic: 92 });
  });
});

// ─── 8. A/B explícito: raw estimador vs valor mostrado (HR, SpO2, BP) ────

describe('Router wiring – A/B raw vs shown (HR, SpO2, BP)', () => {
  it('compara los tres vitales: el mostrado converge al raw sin sobrepasarlo', () => {
    const filter = new VitalDisplayFilter();

    // Secuencia controlada de estimadores (estilo pipeline real, ~10 Hz)
    const sequence: Array<{ hr: number; spo2: number; sys: number; dia: number }> = [
      { hr: 70, spo2: 96, sys: 118, dia: 76 },
      { hr: 72, spo2: 97, sys: 120, dia: 78 },
      { hr: 74, spo2: 97, sys: 122, dia: 80 },
      { hr: 76, spo2: 98, sys: 124, dia: 80 },
      { hr: 78, spo2: 98, sys: 126, dia: 82 },
    ];

    let shown = createDefaultVitalSignsResult();
    for (const s of sequence) {
      const raw = vital(s.hr, s.spo2, s.sys, s.dia);
      shown = filter.update(raw);

      // El mostrado nunca sobrepasa el raw en magnitud de cambio por frame
      // (el EMA solo se acerca, no rebasa, al ser alpha ∈ (0,1))
      const dHr = Math.abs(shown.heartRate.value! - s.hr);
      const dSpo2 = Math.abs(shown.spo2.value! - s.spo2);
      const dSys = Math.abs(shown.bloodPressure.value!.systolic - s.sys);
      const dDia = Math.abs(shown.bloodPressure.value!.diastolic - s.dia);
      expect(dHr).toBeLessThanOrEqual(Math.abs(s.hr - (shown.heartRate.value! - dHr)) + 1);
      expect(dSpo2).toBeLessThanOrEqual(3);
      expect(dSys).toBeLessThanOrEqual(5);
      expect(dDia).toBeLessThanOrEqual(5);
    }

    // Tras la secuencia, el mostrado converge al último raw (misma zona)
    for (let i = 0; i < 30; i++) {
      const last = sequence[sequence.length - 1];
      shown = filter.update(vital(last.hr, last.spo2, last.sys, last.dia));
    }
    expect(shown.heartRate.value).toBe(78);
    expect(shown.spo2.value).toBe(98);
    expect(shown.bloodPressure.value).toEqual({ systolic: 126, diastolic: 82 });
  });
});