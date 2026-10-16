/**
 * SPLASH / BOOT SCREEN — Puerta de entrada a pantalla completa inmersiva.
 * Solo tras aceptar el descargo médico: el flujo legal es
 * disclaimer → splash → uso. Antes competían por el mismo espacio con
 * stacking contexts distintos (splash z-[100] vs contenedor z-10) y el
 * splash interceptaba el click del disclaimer.
 */
import { Heart, Activity } from 'lucide-react';
import type { MeasurementMode } from '@/types/signal';

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

interface SplashScreenProps {
  measurementMode: MeasurementMode;
  onSelectMode: (mode: MeasurementMode) => void;
  onStart: () => void;
}

export function SplashScreen({ measurementMode, onSelectMode, onStart }: SplashScreenProps) {
  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-gradient-to-b from-zinc-950 via-black to-zinc-950 animate-in fade-in duration-700">
      <div className="relative flex flex-col items-center max-w-xs text-center space-y-10 px-4">
        {/* Logo Pulsante / Anillos Biomédicos */}
        <div className="relative flex items-center justify-center">
          <div className="absolute inset-0 bg-emerald-500/20 blur-3xl rounded-full animate-ripple scale-150" />
          <div className="absolute w-32 h-32 rounded-full border border-emerald-500/20 animate-spin duration-1000" style={{ animationDuration: '8s' }} />
          <div className="relative w-24 h-24 rounded-full glass-card border border-emerald-500/40 flex items-center justify-center shadow-2xl shadow-emerald-950/60 glow-emerald">
            <Heart className="w-10 h-10 text-emerald-400 animate-cardiac drop-shadow-[0_0_12px_rgba(16,185,129,0.8)]" fill="currentColor" />
          </div>
        </div>

        <div className="space-y-3">
          <h1 className="text-white text-3xl font-extrabold tracking-[0.18em] font-heading bg-gradient-to-r from-white via-zinc-200 to-emerald-300 bg-clip-text text-transparent">
            BIO-BEAT
          </h1>
          <div className="flex items-center justify-center gap-2">
            <span className="h-[1px] w-6 bg-emerald-500/40" />
            <p className="text-emerald-400/80 text-[10px] font-bold tracking-[0.25em] uppercase font-mono">
              Monitor de Grado Clínico
            </p>
            <span className="h-[1px] w-6 bg-emerald-500/40" />
          </div>
        </div>

        {/* Selector de Modo Pre-Inicio */}
        <div className="flex items-center gap-1.5 p-1 bg-black/40 backdrop-blur-md rounded-2xl border border-white/10">
          <button
            type="button"
            onClick={() => onSelectMode('finger')}
            className={`px-3.5 py-1.5 rounded-xl text-[10px] font-mono font-bold tracking-wider transition-all duration-200 flex items-center gap-1.5 ${
              measurementMode === 'finger'
                ? 'bg-emerald-500 text-black shadow-lg shadow-emerald-500/30'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Heart className="w-3 h-3" />
            CLÍNICO (DEDO)
          </button>
          <button
            type="button"
            onClick={() => onSelectMode('gym')}
            className={`px-3.5 py-1.5 rounded-xl text-[10px] font-mono font-bold tracking-wider transition-all duration-200 flex items-center gap-1.5 ${
              measurementMode === 'gym'
                ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/30'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Activity className="w-3 h-3" />
            MODO GYM (FACIAL)
          </button>
        </div>

        <button
          onClick={onStart}
          className="group relative px-8 py-3.5 overflow-hidden rounded-2xl transition-all duration-300 active:scale-95 shadow-xl shadow-emerald-950/40"
        >
          <div className="absolute inset-0 bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-500 opacity-90 group-hover:opacity-100 transition-opacity" />
          <div className="absolute inset-0 border border-emerald-300/40 rounded-2xl" />
          <span className="relative text-white text-xs font-bold tracking-[0.2em] uppercase font-mono flex items-center gap-2">
            <Activity className="w-4 h-4 text-emerald-200" />
            INICIAR SISTEMA
          </span>
        </button>

        <div className="pt-6 grid grid-cols-2 gap-x-6 gap-y-4 opacity-90 animate-in slide-in-from-bottom-6 duration-700 delay-200 fill-mode-both">
          <div className="text-left space-y-1 glass-card p-2.5 rounded-xl border border-white/5">
            <p className="text-zinc-400 text-[8px] font-bold tracking-widest uppercase font-mono">Pipeline</p>
            <p className="text-emerald-300 text-[9px] font-mono leading-tight font-bold">ZERO-ALLOCATION<br />ULTRA LOW LATENCY</p>
          </div>
          <div className="text-left space-y-1 glass-card p-2.5 rounded-xl border border-white/5">
            <p className="text-zinc-400 text-[8px] font-bold tracking-widest uppercase font-mono">Engine</p>
            <p className="text-cyan-300 text-[9px] font-mono leading-tight font-bold">PPG-RG FIDELITY<br />PWA IMMERSIVE</p>
          </div>
          <div className="text-left space-y-1 glass-card p-2.5 rounded-xl border border-white/5">
            <p className="text-zinc-400 text-[8px] font-bold tracking-widest uppercase font-mono">Analytics</p>
            <p className="text-emerald-300 text-[9px] font-mono leading-tight font-bold">HRV CLINICAL<br />RMSSD / PNN50</p>
          </div>
          <div className="text-left space-y-1 glass-card p-2.5 rounded-xl border border-white/5">
            <p className="text-zinc-400 text-[8px] font-bold tracking-widest uppercase font-mono">Security</p>
            <p className="text-indigo-300 text-[9px] font-mono leading-tight font-bold">ANTI-SIM GUARD<br />DATA INTEGRITY</p>
          </div>
        </div>

        <div className="pt-4 space-y-1 opacity-50 text-center font-mono text-[8px] text-zinc-400 uppercase tracking-widest">
          <p>Hardware: WebRTC Optical Sensor</p>
          <p>Engine v{APP_VERSION}</p>
        </div>
      </div>
    </div>
  );
}
