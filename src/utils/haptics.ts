import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import type { PressureVerdict } from '@/lib/finger/fingerPlacementEvidence';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { logWarn } from './logger';

const HAPTICS_SCOPE = 'Haptics';

type HapticFallback = number | number[];

/**
 * Único camino de emisión háptica: Capacitor Haptics (nativo) y, si falla,
 * `navigator.vibrate` en web. Centralizar el fallback evita repetir el mismo
 * try/catch en cada disparador.
 */
async function fireHaptic(
  label: string,
  primary: () => Promise<void>,
  fallbackPattern: HapticFallback,
): Promise<void> {
  try {
    await primary();
  } catch {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(fallbackPattern);
      }
    } catch {
      logWarn(HAPTICS_SCOPE, `Vibrate fallback failed for ${label}`);
    }
  }
}

/**
 * Activa una vibración háptica muy corta y sutil.
 * Diseñada específicamente para simular un latido de corazón individual.
 */
export async function triggerHeartbeatHaptic(): Promise<void> {
  return fireHaptic(
    'heartbeat',
    () => Haptics.impact({ style: ImpactStyle.Light }),
    45,
  );
}

/**
 * Activa una vibración háptica fuerte de advertencia.
 * Diseñada para alertar sobre la detección de una arritmia cardíaca.
 */
export async function triggerArrhythmiaHaptic(): Promise<void> {
  return fireHaptic(
    'arrhythmia',
    () => Haptics.notification({ type: NotificationType.Warning }),
    [150, 100, 150],
  );
}

/**
 * Activa una vibración para indicar el fin de la calibración de señal.
 */
export async function triggerCalibrationCompleteHaptic(): Promise<void> {
  return fireHaptic(
    'calibration',
    () => Haptics.impact({ style: ImpactStyle.Medium }),
    100,
  );
}

/**
 * Activa una vibración para indicar el inicio de la sesión de monitoreo.
 */
export async function triggerSessionStartHaptic(): Promise<void> {
  return fireHaptic(
    'session start',
    () => Haptics.impact({ style: ImpactStyle.Medium }),
    200,
  );
}

/**
 * Activa una vibración especial para indicar que la sesión de monitoreo finalizó correctamente.
 */
export async function triggerSessionEndHaptic(): Promise<void> {
  return fireHaptic(
    'session end',
    () => Haptics.notification({ type: NotificationType.Success }),
    [100, 50, 100, 50, 200],
  );
}

export interface PressureHapticCue {
  verdict: Exclude<PressureVerdict, 'NONE'>;
  /** Severidad [0..1] derivada del grado continuo (no del veredicto). */
  severity: number;
  /** Patrón de micro-vibraciones para `navigator.vibrate` (ms). */
  webPattern: number[];
  /** Estilo del impacto nativo. */
  nativeStyle: ImpactStyle;
  /** Repeticiones del impacto nativo (la severidad escala el número). */
  nativeRepeats: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Traduce el veredicto + el grado continuo del modelo transmural a un patrón
 * háptico graduado. La severidad es la distancia al óptimo (0.5), de modo que
 * un "apoya un poco más" y un "apoya mucho más" se sienten distintos.
 *
 * La cadencia (settle + cooldown + repetición) vive en `useSignalRouter`; aquí
 * solo se define la forma del aviso, igual que el resto de patrones.
 */
export function pressureHapticCue(
  verdict: Exclude<PressureVerdict, 'NONE'>,
  pressureScore: number,
): PressureHapticCue {
  const score = Number.isFinite(pressureScore) ? clamp01(pressureScore) : 0.5;
  const severe = VITAL_THRESHOLDS.PRESSURE.HAPTIC_SEVERE_FRACTION;

  if (verdict === 'LIGHT') {
    const severity = clamp01((0.5 - score) / 0.5);
    // Doble toque: se distingue del "mantén" sin necesidad de mirar la pantalla.
    const pulse = Math.round(28 + 30 * severity);
    return {
      verdict,
      severity,
      webPattern: [0, pulse, 90, pulse],
      nativeStyle: ImpactStyle.Medium,
      nativeRepeats: severity >= severe ? 3 : 2,
    };
  }

  if (verdict === 'HEAVY') {
    const severity = clamp01((score - 0.5) / 0.5);
    // Patrón largo-corto-largo: imposible de confundir con el latido ni con el
    // "presiona más". Escala en duración y en número de repeticiones.
    const pulse = Math.round(55 + 65 * severity);
    return {
      verdict,
      severity,
      webPattern: [0, pulse, 70, Math.round(pulse * 0.45), 70, pulse],
      nativeStyle: ImpactStyle.Heavy,
      nativeRepeats: severity >= severe ? 3 : 2,
    };
  }

  return {
    verdict: 'IDEAL',
    severity: 0,
    webPattern: [0, 12],
    nativeStyle: ImpactStyle.Light,
    nativeRepeats: 1,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Bucle cerrado de presión (modelo transmural):
 *  - LIGHT : toque firme para pedir más apoyo (la señal es débil).
 *  - IDEAL : confirmación sutil de presión óptima.
 *  - HEAVY : advertencia de colapso capilar; liberar restaura la AC.
 *
 * En web se usan micro-vibraciones de `navigator.vibrate` (patrón graduado por
 * severidad); en el dispositivo se usa el motor háptico nativo con repeticiones
 * proporcionales a la severidad.
 */
export async function triggerPressureHaptic(
  verdict: Exclude<PressureVerdict, 'NONE'>,
  pressureScore: number,
): Promise<void> {
  const cue = pressureHapticCue(verdict, pressureScore);

  if (!Capacitor.isNativePlatform()) {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(cue.webPattern);
      } catch {
        logWarn(HAPTICS_SCOPE, 'Pressure vibrate failed');
      }
    }
    return;
  }

  for (let i = 0; i < cue.nativeRepeats; i++) {
    try {
      await Haptics.impact({ style: cue.nativeStyle });
    } catch {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(cue.webPattern);
      }
      return;
    }
    if (i < cue.nativeRepeats - 1) await delay(55);
  }
}