/**
 * NEXUS SESSION ENGINE — Motor de la sesión dual cara+dedo
 * ========================================================
 * Módulo puro (sin React, sin cámara, sin estado global) que recibe las
 * muestras de DOS sitios con su reloj real (ms, misma línea de tiempo que
 * performance.now()) y decide CUÁNDO y CÓMO se evalúa el pipeline NEXUS
 * (capítulo 12 de docs/nexus-vitals-blueprint.md):
 *
 *   1) Acumula buffers por sitio con poda acotada.
 *   2) En cada evaluación (cadencia fija) recorta la ventana común de
 *      NEXUS_WINDOW_SECONDS, la re-muestrea a cadencia uniforme con la
 *      utilidad compartida del repositorio (resampleToUniformTimeline) y
 *      llama a `deriveCrossSiteObservation` — la ÚNICA ruta oficial del τ.
 *   3) Publica un snapshot con estado, τ y coherencia; la degradación es
 *      elegante y con motivo: nada se disimula, nada se inventa.
 *
 * Reutiliza el pipeline ya provenido en F0-F1 (no duplica DSP) y la
 * alineación canónica de `shared/dsp` (no duplica remuestreo).
 */

import { resampleToUniformTimeline } from '@/modules/signal-processing/shared/dsp';
import {
  deriveCrossSiteObservation,
  UNCALIBRATED_PTT_MODEL,
  type NexusBpObservation,
  type PttPersonalModel,
} from './nexusFusionCore';
import type { NexusCoherenceLevel } from './nexusCoherence';

/** Duración de la ventana común evaluada (s). 8 s ≈ 8–10 latidos a 60–75 bpm. */
export const NEXUS_WINDOW_SECONDS = 8;
/** Cadencia uniforme de la ventana alineada (Hz) — banda de pulso ≤ 4.5 Hz. */
export const NEXUS_TARGET_FS = 30;
/** Separación mínima entre evaluaciones completas del pipeline (ms). */
export const NEXUS_EVAL_INTERVAL_MS = 1500;
/** Silencio máximo del sitio antes de declararlo mudo (ms). */
export const NEXUS_SITE_SILENCE_MS = 1200;
/** Poda de los buffers (ms) — contra fuga de memoria en sesiones largas. */
export const NEXUS_BUFFER_MAX_MS = 20000;
/** Proporción mínima de llenado de la ventana por sitio (0–1). */
const NEXUS_MIN_FILL_RATIO = 0.6;
/** Fracción mínima de solapamiento real entre sitios (0–1) para evaluar. */
const NEXUS_MIN_OVERLAP_RATIO = 0.8;

export type NexusSessionStatus =
  /** Sesión no armada (sin feed distal activo). */
  | 'INACTIVE'
  /** Feed distal activo pero el sitio proximal no está capturado (motiv del puente). */
  | 'WAITING_PROXIMAL_CAPTURE'
  /** Dual activo; la ventana común aún no llena el mínimo fisiológico. */
  | 'WARMING_UP'
  /** Última evaluación emitió observación válida de tránsito. */
  | 'ACTIVE_NEXUS'
  /** Dual activo sin evidencia de tránsito (contacto/rostro/ruido). */
  | 'DEGRADED_NO_EVIDENCE'
  /** La coherencia multisitio condenó la ventana (INCOMPATIBLE). */
  | 'DEGRADED_INCOMPATIBLE';

/** Muestra del sitio distal (dedo, canal filtrado del pipeline existente). */
export interface NexusDistalSample {
  tsMs: number;
  value: number;
  /** true si el dedo está presente con contacto aprovechable. */
  contactOk: boolean;
}

/** Muestra del sitio proximal (cara, extractor facial en hilo principal). */
export interface NexusProximalSample {
  tsMs: number;
  value: number;
  /** true si el rostro está encuadrado en esta muestra. */
  faceSeen: boolean;
}

export interface NexusSessionSnapshot {
  status: NexusSessionStatus;
  /** Motivo técnico del estado (cadena estable; p. ej. 'CONTACTO_DISTAL_PERDIDO'). */
  reason: string;
  tauMs: number | null;
  coherenceLevel: NexusCoherenceLevel | null;
  coherenceScore: number | null;
  /** Observación lista para el motor de fusión (solo en ACTIVE_NEXUS). */
  observation: NexusBpObservation | null;
  /** Solapamiento real de la última ventana evaluada (s; 0 si no se evaluó). */
  dualWindowSeconds: number;
}

/** Snapshot inicial de sesión (nada se inventa). */
export function createIdleNexusSnapshot(): NexusSessionSnapshot {
  return {
    status: 'INACTIVE',
    reason: 'SESION_INACTIVA',
    tauMs: null,
    coherenceLevel: null,
    coherenceScore: null,
    observation: null,
    dualWindowSeconds: 0,
  };
}

interface DistalEntry {
  tsMs: number;
  value: number;
  contactOk: boolean;
}

interface ProximalEntry {
  tsMs: number;
  value: number;
  faceSeen: boolean;
}

export interface NexusSessionEngineOptions {
  /** Modelo personal PTT↔PA; por defecto el prior sin calibrar. */
  personalModel?: PttPersonalModel;
}

/**
 * Motor de la sesión dual. Una instancia por sesión de medición NEXUS.
 * El feed distal llega desde el callback caliente del router (canal filtrado
 * del worker); el feed proximal llega del extractor facial delillo principal.
 */
export class NexusSessionEngine {
  private active = false;
  private proximalAvailable = false;
  private lastEvaluateAtMs: number | null = null;
  private pendingProximalReason: string = 'SIN_INTENTO_DE_CAPTURA';

  private distal: DistalEntry[] = [];
  private proximal: ProximalEntry[] = [];

  private readonly personalModel: PttPersonalModel;

  constructor(options: NexusSessionEngineOptions = {}) {
    this.personalModel = options.personalModel ?? UNCALIBRATED_PTT_MODEL;
  }

  /**
   * Activa el motor. Ahora el feed distal pasa a procesar (el modo dedo sigue
   * siendo dueño de su pipeline; el motor es un observador honesto).
   */
  activate(): void {
    this.active = true;
    this.distal = [];
    this.proximal = [];
    this.lastEvaluateAtMs = null;
    this.pendingProximalReason = 'SIN_INTENTO_DE_CAPTURA';
    this.proximalAvailable = false;
  }

  /** Anotación de la negociación de captura del sitio proximal (bridge). */
  setProximalCapture(level: 'L0' | 'L2', streamOpen: boolean, reason: string): void {
    this.proximalAvailable = level === 'L2' && streamOpen;
    this.pendingProximalReason = reason;
    if (!this.proximalAvailable) {
      this.proximal = [];
    }
  }

  /** Desactiva por completo y limpia buffers (estado INACTIVE). */
  deactivate(): void {
    this.active = false;
    this.setProximalCapture('L0', false, 'SESION_DETENIDA');
    this.distal = [];
    this.proximal = [];
    this.lastEvaluateAtMs = null;
    this.lastSnapshot = null;
  }

  pushDistal(sample: NexusDistalSample): void {
    if (!this.active || !Number.isFinite(sample.tsMs) || !Number.isFinite(sample.value)) return;
    this.distal.push({ tsMs: sample.tsMs, value: sample.value, contactOk: sample.contactOk });
    this.prune(sample.tsMs, this.distal, NEXUS_BUFFER_MAX_MS);
  }

  pushProximal(sample: NexusProximalSample): void {
    if (!this.active || !Number.isFinite(sample.tsMs) || !Number.isFinite(sample.value)) return;
    this.proximal.push({ tsMs: sample.tsMs, value: sample.value, faceSeen: sample.faceSeen });
    this.prune(sample.tsMs, this.proximal, NEXUS_BUFFER_MAX_MS);
  }

  /** Poda por antigüedad (O(n) ocasional; buffers acotados). */
  private prune(nowMs: number, buffer: Array<{ tsMs: number }>, maxMs: number): void {
    const cut = nowMs - maxMs;
    let firstAlive = 0;
    while (firstAlive < buffer.length && (buffer[firstAlive] as { tsMs: number }).tsMs < cut) {
      firstAlive += 1;
    }
    if (firstAlive > 0) buffer.splice(0, firstAlive);
  }

  /**
   * Evaluación con cadencia. Llamar en el callback caliente (distal) y en el
   * loop facial (proximal): el motor respeta NEXUS_EVAL_INTERVAL_MS por sí
   * mismo, así que llamarlo con frecuencia no duplica trabajo pesado. La
   * primera llamada del ciclo evalúa de inmediato; dentro del intervalo
   * corre vigente el último snapshot (sin re-trabajo).
   */
  maybeEvaluate(nowMs: number): NexusSessionSnapshot {
    if (!this.active) return createIdleNexusSnapshot();

    const inCadence =
      this.lastSnapshot !== null &&
      this.lastEvaluateAtMs !== null &&
      nowMs - this.lastEvaluateAtMs < NEXUS_EVAL_INTERVAL_MS;
    if (inCadence) return this.lastSnapshot as NexusSessionSnapshot;

    const snap = this.evaluateNow(nowMs);
    this.lastEvaluateAtMs = nowMs;
    this.lastSnapshot = snap;
    return snap;
  }

  /** Último snapshot publicado (o el inicial). Útil tras cadencia interrumpida. */
  snapshot(): NexusSessionSnapshot {
    return this.lastSnapshot ?? createIdleNexusSnapshot();
  }

  private lastSnapshot: NexusSessionSnapshot | null = null;

  private build(
    status: NexusSessionStatus,
    reason: string,
    extra?: Partial<NexusSessionSnapshot>,
  ): NexusSessionSnapshot {
    return {
      status,
      reason,
      tauMs: extra?.tauMs ?? null,
      coherenceLevel: extra?.coherenceLevel ?? null,
      coherenceScore: extra?.coherenceScore ?? null,
      observation: extra?.observation ?? null,
      dualWindowSeconds: extra?.dualWindowSeconds ?? 0,
    };
  }

  private evaluateNow(nowMs: number): NexusSessionSnapshot {
    if (!this.proximalAvailable) {
      return this.build('WAITING_PROXIMAL_CAPTURE', this.pendingProximalReason);
    }

    const windowMs = NEXUS_WINDOW_SECONDS * 1000;
    const cut = nowMs - windowMs;

    const lastDistal = this.distal.length > 0 ? this.distal[this.distal.length - 1] : null;
    if (!lastDistal || nowMs - lastDistal.tsMs > NEXUS_SITE_SILENCE_MS) {
      return this.build('DEGRADED_NO_EVIDENCE', 'SITIO_DISTAL_MUDO');
    }
    if (!lastDistal.contactOk) {
      return this.build('DEGRADED_NO_EVIDENCE', 'CONTACTO_DISTAL_PERDIDO');
    }

    const lastProximal = this.proximal.length > 0 ? this.proximal[this.proximal.length - 1] : null;
    if (!lastProximal || nowMs - lastProximal.tsMs > NEXUS_SITE_SILENCE_MS) {
      return this.build('DEGRADED_NO_EVIDENCE', 'SITIO_PROXIMAL_MUDO');
    }
    if (!lastProximal.faceSeen) {
      return this.build('DEGRADED_NO_EVIDENCE', 'ROSTRO_PROXIMAL_AUSENTE');
    }

    const distWin = this.distal.filter((s) => s.tsMs >= cut);
    const proxWin = this.proximal.filter((s) => s.tsMs >= cut);

    const fillTarget = Math.ceil(NEXUS_MIN_FILL_RATIO * NEXUS_WINDOW_SECONDS * NEXUS_TARGET_FS);
    if (distWin.length < fillTarget || proxWin.length < fillTarget) {
      return this.build('WARMING_UP', 'VENTANA_COMUN_INCOMPLETA');
    }

    // Ventana común REAL de ambos sitios y solapamiento mínimo honesto.
    const t0 = Math.max(distWin[0].tsMs, proxWin[0].tsMs);
    const t1 = Math.min(distWin[distWin.length - 1].tsMs, proxWin[proxWin.length - 1].tsMs);
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) {
      return this.build('WARMING_UP', 'VENTANA_COMUN_INCOMPLETA');
    }
    const overlapMs = t1 - t0;
    if (overlapMs < NEXUS_MIN_OVERLAP_RATIO * windowMs) {
      return this.build('WARMING_UP', 'VENTANA_COMUN_INCOMPLETA');
    }

    // Alineación canónica compartida: mismo rango temporal y mismo target →
    // ambas series comparten línea de tiempo exacta (resample de shared/dsp).
    const distSub = distWin.filter((s) => s.tsMs >= t0 && s.tsMs <= t1);
    const proxSub = proxWin.filter((s) => s.tsMs >= t0 && s.tsMs <= t1);
    const targetCount = Math.round(NEXUS_WINDOW_SECONDS * NEXUS_TARGET_FS);
    const distAligned = resampleToUniformTimeline(distSub.map((s) => s.value), distSub.map((s) => s.tsMs), targetCount);
    const proxAligned = resampleToUniformTimeline(proxSub.map((s) => s.value), proxSub.map((s) => s.tsMs), targetCount);

    const pipeline = deriveCrossSiteObservation({
      proximal: proxAligned.y,
      distal: distAligned.y,
      sampleRateHz: proxAligned.fs,
      timestampMs: nowMs,
      personalModel: this.personalModel,
    });

    const dualWindowSeconds = overlapMs / 1000;

    if (pipeline.observation !== null) {
      return this.build('ACTIVE_NEXUS', pipeline.timing.reason, {
        tauMs: pipeline.timing.tauMs,
        coherenceLevel: pipeline.coherence.level,
        coherenceScore: pipeline.coherence.score,
        observation: pipeline.observation,
        dualWindowSeconds,
      });
    }

    if (pipeline.coherence.level === 'INCOMPATIBLE') {
      return this.build('DEGRADED_INCOMPATIBLE', 'COHERENCIA_INCOMPATIBLE', { dualWindowSeconds });
    }

    // Sin τ (estimador rechazó la ventana): el motivo técnico del estimador
    // es el producto honesto — se publica tal cual al usuario.
    const reasonTiming = pipeline.timing.reason || 'NO_TIMING_EVIDENCE';
    return this.build('DEGRADED_NO_EVIDENCE', reasonTiming, { dualWindowSeconds });
  }
}
