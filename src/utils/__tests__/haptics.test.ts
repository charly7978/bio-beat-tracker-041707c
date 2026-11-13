import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  native: false,
  vibrate: vi.fn(),
  impact: vi.fn(async () => undefined),
  notification: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => mocks.native },
}));

vi.mock('@capacitor/haptics', () => ({
  Haptics: {
    impact: (options: unknown) => mocks.impact(options),
    notification: (options: unknown) => mocks.notification(options),
  },
  ImpactStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationType: { Warning: 'warning', Success: 'success' },
}));

import { pressureHapticCue, triggerPressureHaptic } from '../haptics';

describe('pressureHapticCue — háptico graduado por grado transmural', () => {
  it('LIGHT: doble toque y severidad proporcional a la distancia al óptimo', () => {
    const mild = pressureHapticCue('LIGHT', 0.4);
    expect(mild.severity).toBeCloseTo(0.2, 5);
    expect(mild.webPattern).toHaveLength(4);
    expect(mild.webPattern[0]).toBe(0);
    // El segundo pulso es igual al primero: es la firma "repetición".
    expect(mild.webPattern[3]).toBe(mild.webPattern[1]);
    expect(mild.nativeRepeats).toBe(2);

    const strong = pressureHapticCue('LIGHT', 0.1);
    expect(strong.severity).toBeCloseTo(0.8, 5);
    expect(strong.webPattern[1]).toBeGreaterThan(mild.webPattern[1] as number);
    // Severidad alta → 3 repeticiones nativas.
    expect(strong.nativeRepeats).toBe(3);
  });

  it('HEAVY: patrón largo-corto-largo, imposible de confundir con "presiona más"', () => {
    const mild = pressureHapticCue('HEAVY', 0.6);
    expect(mild.severity).toBeCloseTo(0.2, 5);
    expect(mild.webPattern).toHaveLength(6);
    expect(mild.nativeRepeats).toBe(2);

    const severe = pressureHapticCue('HEAVY', 0.95);
    expect(severe.severity).toBeCloseTo(0.9, 5);
    // Los pulsos largos (1º y 3º) son iguales entre sí y mayores que el corto.
    const [, long1, , short, , long2] = severe.webPattern as number[];
    expect(long1).toBe(long2);
    expect(short).toBeLessThan(long1);
    expect(long1).toBeGreaterThan(0);
    expect(severe.nativeRepeats).toBeGreaterThan(mild.nativeRepeats);
  });

  it('IDEAL: confirmación mínima de un pulso', () => {
    const cue = pressureHapticCue('IDEAL', 0.5);
    expect(cue.severity).toBe(0);
    expect(cue.webPattern).toEqual([0, 12]);
    expect(cue.nativeRepeats).toBe(1);
  });

  it('un grado inválido cae al óptimo en lugar de NaN', () => {
    const cue = pressureHapticCue('IDEAL', Number.NaN);
    expect(cue.severity).toBe(0);
    expect(cue.webPattern).toEqual([0, 12]);
  });
});

describe('triggerPressureHaptic — emisión web/nativa', () => {
  beforeEach(() => {
    mocks.native = false;
    mocks.vibrate.mockReset();
    mocks.impact.mockReset();
    mocks.impact.mockImplementation(async () => undefined);
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      writable: true,
      value: mocks.vibrate,
    });
  });

  it('en web usa micro-vibraciones de navigator.vibrate con el patrón del grado', async () => {
    await triggerPressureHaptic('HEAVY', 0.95);

    expect(mocks.vibrate).toHaveBeenCalledTimes(1);
    const pattern = mocks.vibrate.mock.calls[0][0] as number[];
    expect(pattern).toHaveLength(6);
    expect(pattern[0]).toBe(0);
    expect(mocks.impact).not.toHaveBeenCalled();
  });

  it('en nativo repite el impacto según la severidad', async () => {
    mocks.native = true;
    await triggerPressureHaptic('HEAVY', 0.95);

    expect(mocks.impact).toHaveBeenCalledTimes(3);
    expect(mocks.impact).toHaveBeenCalledWith({ style: 'heavy' });
    expect(mocks.vibrate).not.toHaveBeenCalled();
  });

  it('si el motor nativo falla, cae a navigator.vibrate', async () => {
    mocks.native = true;
    mocks.impact.mockRejectedValueOnce(new Error('haptics unavailable'));

    await triggerPressureHaptic('LIGHT', 0.2);

    expect(mocks.vibrate).toHaveBeenCalledTimes(1);
    const pattern = mocks.vibrate.mock.calls[0][0] as number[];
    expect(pattern).toHaveLength(4);
    expect(pattern[0]).toBe(0);
  });
});