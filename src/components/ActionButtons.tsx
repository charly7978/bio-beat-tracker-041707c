import { Play, Square, RotateCcw } from 'lucide-react';

interface ActionButtonsProps {
  isMonitoring: boolean;
  onStartMeasurement: () => void;
  onReset: () => void;
}

export function ActionButtons({ isMonitoring, onStartMeasurement, onReset }: ActionButtonsProps) {
  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-20 flex items-center justify-center p-2.5 bg-gradient-to-t from-black via-black/90 to-transparent"
      style={{
        paddingBottom: 'calc(8px + env(safe-area-inset-bottom, 0px))',
      }}
    >
      <div className="flex items-center gap-2 max-w-sm w-full p-1.5 rounded-2xl glass-panel border border-white/10 shadow-2xl shadow-black/80">
        <button
          onClick={onStartMeasurement}
          className={`flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-bold text-xs tracking-wider uppercase transition-all duration-200 active:scale-[0.97] ${
            isMonitoring
              ? 'bg-gradient-to-r from-rose-600 to-red-600 text-white shadow-lg shadow-rose-950/50 glow-rose border border-rose-400/40'
              : 'bg-gradient-to-r from-emerald-500 via-emerald-600 to-teal-600 text-white shadow-lg shadow-emerald-950/50 glow-emerald border border-emerald-400/40'
          }`}
        >
          {isMonitoring ? (
            <>
              <Square className="w-3.5 h-3.5 fill-current" />
              <span>Detener Medición</span>
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>Iniciar Medición</span>
            </>
          )}
        </button>

        <button
          onClick={onReset}
          aria-label="Reiniciar medición"
          className="flex items-center justify-center gap-1.5 py-3 px-3.5 rounded-xl font-semibold text-xs text-zinc-300 bg-white/5 hover:bg-white/10 active:bg-white/15 active:scale-[0.96] border border-white/10 hover:border-white/20 transition-all duration-200"
        >
          <RotateCcw className="w-3.5 h-3.5 text-zinc-400" />
          <span className="text-[10px] tracking-wider uppercase font-mono">Reset</span>
        </button>
      </div>
    </div>
  );
}
