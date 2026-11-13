/**
 * PRESSURE COACH — Guía de presión al usuario.
 *
 * Es la parte más importante del bucle cerrado y la que faltaba: el modelo ya
 * calculaba un veredicto, pero la única frase que llegaba al usuario era un
 * texto de 9 px pintado dentro del canvas, debajo de la onda. Aquí la guía se
 * muestra como una tarjeta fija, grande y legible sobre el video.
 *
 * No decide nada: consume `placementEvidence.guidance`, la MISMA decisión que
 * alimenta el háptico y el gauge del canvas. Así el texto, el color y la
 * vibración no pueden contradecirse.
 */
import React from 'react';
import type { FingerPlacementEvidence } from '@/lib/finger/fingerPlacementEvidence';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

interface PressureCoachProps {
  evidence?: FingerPlacementEvidence;
  isMonitoring: boolean;
  /** Estado de rechazo del frame. Si hay rechazo, la presión no es evaluable. */
  status?: string;
}

interface Accent {
  border: string;
  bg: string;
  text: string;
  bar: string;
  glow: string;
}

const ACCENTS: Record<string, Accent> = {
  RELEASE: {
    border: 'border-red-500/60',
    bg: 'bg-red-950/80',
    text: 'text-red-300',
    bar: 'bg-red-500',
    glow: 'shadow-[0_0_24px_-6px_rgba(239,68,68,0.7)]',
  },
  PRESS_MORE: {
    border: 'border-amber-500/60',
    bg: 'bg-amber-950/80',
    text: 'text-amber-300',
    bar: 'bg-amber-500',
    glow: 'shadow-[0_0_24px_-6px_rgba(245,158,11,0.7)]',
  },
  HOLD: {
    border: 'border-emerald-500/60',
    bg: 'bg-emerald-950/80',
    text: 'text-emerald-300',
    bar: 'bg-emerald-500',
    glow: 'shadow-[0_0_24px_-6px_rgba(34,197,94,0.7)]',
  },
  REPOSITION: {
    border: 'border-sky-500/60',
    bg: 'bg-sky-950/80',
    text: 'text-sky-300',
    bar: 'bg-sky-500',
    glow: 'shadow-[0_0_24px_-6px_rgba(56,189,248,0.7)]',
  },
  WAIT: {
    border: 'border-slate-600/60',
    bg: 'bg-slate-950/85',
    text: 'text-slate-300',
    bar: 'bg-slate-400',
    glow: '',
  },
};

const FALLBACK: Accent = ACCENTS.WAIT;

/**
 * Solo se muestra cuando hay algo útil que decir: el modelo da una guía con
 * confianza suficiente. Con `NONE` de confianza baja no se afirma nada (la
 * filosofía del repo es "no reading" antes que una lectura inventada).
 */
/**
 * Estados de rechazo del frame en los que la presión NO es evaluable. Mostrar
 * "presión óptima · mantén" con la imagen saturada o subexpuesta sería otra vez
 * "decir cualquier cosa": el modelo no puede ver el lecho capilar.
 */
const TECHNICAL_NOTICE: Record<string, { headline: string; detail: string; accent: string }> = {
  SATURATED: {
    headline: 'DEMOSTRE LA IMAGEN · APAGA EL FLASH',
    detail: 'El sensor está saturado y no puede leer el pulso. Reduce el brillo o aleja el dedo del flash.',
    accent: 'sky',
  },
  UNDEREXPOSED: {
    headline: 'HAY POCA LUZ',
    detail: 'El sensor no recibe suficiente señal. Acerca el dedo a la lente o activa el flash.',
    accent: 'sky',
  },
  LOW_FPS: {
    headline: 'LA CÁMARA VA LENTA',
    detail: 'Los fotogramas llegan con retraso. Cierra otras apps o baja la resolución.',
    accent: 'slate',
  },
  MOTION_ARTIFACT: {
    headline: 'NO TE MUEVAS',
    detail: 'El movimiento impide medir. Sostén el dedo quieto sobre la lente.',
    accent: 'slate',
  },
};

export function PressureCoach({ evidence, isMonitoring, status }: PressureCoachProps) {
  if (!isMonitoring || !evidence) return null;

  // Rechazo de captura: la presión no es evaluable. Se sustituye la guía de
  // presión por el aviso técnico que sí corresponde, en lugar de afirmar nada.
  const notice = status ? TECHNICAL_NOTICE[status] : undefined;
  if (notice) {
    const accent = ACCENTS[notice.accent] ?? FALLBACK;
    return (
      <div
        className="pointer-events-none absolute left-2 right-2 z-20"
        style={{ top: 'calc(150px + env(safe-area-inset-top, 0px))' }}
      >
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={`rounded-xl border ${accent.border} ${accent.bg} px-3 py-2 backdrop-blur-md`}
        >
          <p className={`text-[12px] font-bold leading-tight tracking-wide ${accent.text}`}>
            {notice.headline}
          </p>
          <p className="mt-0.5 text-[10px] leading-snug text-zinc-300">{notice.detail}</p>
        </div>
      </div>
    );
  }

  const guidance = evidence.guidance;
  if (!guidance) return null;

  // Solo se descarta la espera de confianza baja (ruido). Las acciones que
  // DICEN algo (apoya el dedo, presiona más, suelta, mantén) se muestran
  // siempre: filtrarlas por confianza ocultaba justo "APOYA EL DEDO EN LA
  // LENTE", que es la instrucción más necesaria cuando no hay contacto.
  const minConfidence = VITAL_THRESHOLDS.PRESSURE.GUIDANCE_MIN_CONFIDENCE;
  if (guidance.action === 'WAIT' && guidance.confidence < minConfidence) return null;

  const accent = ACCENTS[guidance.action] ?? FALLBACK;
  const progressPct = Math.round(Math.max(0, Math.min(1, guidance.progress)) * 100);
  const isCritical = guidance.action === 'RELEASE';

  return (
    <div
      className="pointer-events-none absolute left-2 right-2 z-20"
      // Debajo de la cabecera (36 px) y de la barra de métricas (hasta ~108 px).
      style={{ top: 'calc(150px + env(safe-area-inset-top, 0px))' }}
    >
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={`rounded-xl border ${accent.border} ${accent.bg} ${accent.glow} px-3 py-2 backdrop-blur-md transition-colors duration-200`}
      >
        <div className="flex items-start gap-2">
          <span
            aria-hidden="true"
            className={`mt-0.5 inline-block h-2 w-2 flex-none rounded-full ${accent.bar} ${
              isCritical ? 'animate-pulse' : ''
            }`}
          />
          <div className="min-w-0 flex-1">
            <p className={`text-[12px] font-bold leading-tight tracking-wide ${accent.text}`}>
              {guidance.headline}
            </p>
            <p className="mt-0.5 text-[10px] leading-snug text-zinc-300">
              {guidance.detail}
            </p>

            <div className="mt-1.5 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/60">
                <div
                  className={`h-full rounded-full ${accent.bar} transition-[width] duration-150 ease-out`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="w-8 flex-none text-right text-[9px] font-bold tabular-nums text-zinc-400">
                {progressPct}%
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default PressureCoach;