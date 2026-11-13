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
  WARM: {
    // Vasoconstricción: el dedo está frío o hay tono simpático. No es un problema
    // de presión, así que no se usa ámbar (que dice "aprieta").
    border: 'border-sky-500/60',
    bg: 'bg-sky-950/85',
    text: 'text-sky-300',
    bar: 'bg-sky-400',
    glow: 'shadow-[0_0_24px_-6px_rgba(56,189,248,0.6)]',
  },
  REPOSITION: {
    border: 'border-violet-500/60',
    bg: 'bg-violet-950/85',
    text: 'text-violet-300',
    bar: 'bg-violet-400',
    glow: 'shadow-[0_0_24px_-6px_rgba(167,139,250,0.6)]',
  },
  CENTER: {
    border: 'border-violet-500/60',
    bg: 'bg-violet-950/85',
    text: 'text-violet-300',
    bar: 'bg-violet-400',
    glow: 'shadow-[0_0_24px_-6px_rgba(167,139,250,0.6)]',
  },
  FIX_SATURATION: {
    border: 'border-rose-500/60',
    bg: 'bg-rose-950/85',
    text: 'text-rose-300',
    bar: 'bg-rose-400',
    glow: 'shadow-[0_0_24px_-6px_rgba(244,63,94,0.6)]',
  },
  FIX_LIGHT: {
    border: 'border-amber-500/60',
    bg: 'bg-amber-950/85',
    text: 'text-amber-300',
    bar: 'bg-amber-400',
    glow: 'shadow-[0_0_24px_-6px_rgba(245,158,11,0.6)]',
  },
  FIX_FPS: {
    border: 'border-slate-600/60',
    bg: 'bg-slate-950/85',
    text: 'text-slate-300',
    bar: 'bg-slate-400',
    glow: '',
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
export function PressureCoach({ evidence, isMonitoring }: PressureCoachProps) {
  if (!isMonitoring || !evidence) return null;

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

  // Aviso secundario: centrado, quietud o cobertura. El coach solo mostraba la
  // instrucción de PRESIÓN, así que "centra la yema" o "sostén el dedo quieto"
  // (que ya calcula el modelo en `failing`) no llegaban nunca al usuario en 2D.
  const secondary = (evidence.failing ?? []).find(
    (hint) => hint && !hint.toLowerCase().includes(guidance.headline.toLowerCase()),
  );

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

            {secondary ? (
              <p className={`mt-1 text-[10px] font-semibold leading-snug ${accent.text} opacity-90`}>
                → {secondary}
              </p>
            ) : null}

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