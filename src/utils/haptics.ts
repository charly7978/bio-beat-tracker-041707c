import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import type { PressureVerdict } from '@/lib/finger/fingerPlacementEvidence';
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

/**
 * Bucle cerrado de presión (modelo transmural):
 *  - LIGHT : toque firme para pedir más apoyo (la señal es débil).
 *  - IDEAL : confirmación sutil de presión óptima.
 *  - HEAVY : advertencia de colapso capilar; liberar restaura la AC.
 *
 * La cadencia y el anti-rebote viven en `useSignalRouter`; aquí solo se
 * traduce el veredicto único a un patrón distinguible.
 */
export async function triggerPressureHaptic(
  verdict: Exclude<PressureVerdict, 'NONE'>,
): Promise<void> {
  if (verdict === 'HEAVY') {
    return fireHaptic(
      'pressure high',
      () => Haptics.impact({ style: ImpactStyle.Heavy }),
      [180, 90, 180, 90, 180],
    );
  }
  if (verdict === 'LIGHT') {
    return fireHaptic(
      'pressure low',
      () => Haptics.impact({ style: ImpactStyle.Medium }),
      [60, 60, 60],
    );
  }
  return fireHaptic(
    'pressure optimal',
    () => Haptics.selectionChanged(),
    15,
  );
}
