import React from 'react';
import { Play, Square, RotateCcw } from 'lucide-react';

interface ActionButtonsProps {
  isMonitoring: boolean;
  onStartMeasurement: () => void;
  onReset: () => void;
}

export function ActionButtons({ isMonitoring, onStartMeasurement, onReset }: ActionButtonsProps) {
  return (
    <div
      className="monitor-actions fixed bottom-0 left-0 right-0 grid grid-cols-2 z-10"
      style={{
        height: 'calc(64px + env(safe-area-inset-bottom, 0px))',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      <button
        type="button"
        onClick={onStartMeasurement}
        className={`group flex items-center justify-center gap-2 font-bold text-xs tracking-widest uppercase transition-all duration-200 border-r border-white/5 active:scale-[0.98] ${
          isMonitoring
            ? 'bg-red-500/15 hover:bg-red-500/25 text-red-400'
            : 'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400'
        }`}
      >
        {isMonitoring ? (
          <>
            <Square className="w-3.5 h-3.5 fill-current text-red-400" />
            <span>DETENER</span>
          </>
        ) : (
          <>
            <Play className="w-3.5 h-3.5 fill-current text-emerald-400" />
            <span>INICIAR</span>
          </>
        )}
      </button>

      <button
        type="button"
        onClick={onReset}
        className="flex items-center justify-center gap-2 font-semibold text-xs tracking-wider uppercase text-zinc-400 hover:text-white bg-white/[0.02] hover:bg-white/[0.06] active:scale-[0.98] transition-all duration-200"
      >
        <RotateCcw className="w-3.5 h-3.5 text-zinc-400 group-hover:text-white" />
        <span>REINICIAR</span>
      </button>
    </div>
  );
}

