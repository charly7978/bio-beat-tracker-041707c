import { Play, Square, RotateCcw, Box, Shield, Activity, Brain } from 'lucide-react';
import { usePpg3dSettings } from '@/store/ppg3dSettings';

export interface ActionButtonsProps {
  isMonitoring: boolean;
  onStartMeasurement: () => void;
  onReset: () => void;
  encryptionReady?: boolean;
  healthAvail?: 'yes' | 'no' | 'checking';
  riskResult?: string | null;
}

export function ActionButtons({
  isMonitoring,
  onStartMeasurement,
  onReset,
  encryptionReady = false,
  healthAvail = 'no',
  riskResult = null,
}: ActionButtonsProps) {
  const is3DEnabled = usePpg3dSettings((s) => s.enabled);
  const toggle3D = usePpg3dSettings((s) => s.toggle);

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-20 flex flex-col items-center justify-end px-3 pt-2 bg-gradient-to-t from-black via-black/95 to-transparent pointer-events-none"
      style={{
        paddingBottom: 'calc(10px + env(safe-area-inset-bottom, 0px))',
      }}
    >
      {/* 1. Fila de Badges de Estado del Sistema con Brillo Holográfico */}
      <div className="flex items-center gap-1.5 justify-center mb-2 pointer-events-auto">
        <span
          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[8px] font-mono font-bold tracking-wider uppercase border transition-all duration-300 ${
            encryptionReady
              ? 'bg-amber-500/15 text-amber-300 border-amber-500/40 glow-amber shadow-[0_0_12px_rgba(245,158,11,0.35)]'
              : 'bg-zinc-900/70 text-zinc-500 border-zinc-800/80 backdrop-blur-md'
          }`}
        >
          <Shield className="w-2.5 h-2.5" />
          {encryptionReady ? 'LOCAL CIFRADO' : 'ENC—'}
        </span>

        <span
          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[8px] font-mono font-bold tracking-wider uppercase border transition-all duration-300 ${
            healthAvail === 'yes'
              ? 'bg-blue-500/15 text-blue-300 border-blue-500/40 shadow-[0_0_12px_rgba(59,130,246,0.35)]'
              : 'bg-zinc-900/70 text-zinc-500 border-zinc-800/80 backdrop-blur-md'
          }`}
        >
          <Activity className="w-2.5 h-2.5" />
          HEALTH{healthAvail === 'yes' ? '·SYNC' : ''}
        </span>

        {riskResult && (
          <span
            className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[8px] font-mono font-bold tracking-wider uppercase border transition-all duration-300 ${
              riskResult === 'IMMEDIATE'
                ? 'bg-rose-500/20 text-rose-300 border-rose-500/50 glow-rose animate-pulse'
                : riskResult === 'SOON'
                ? 'bg-orange-500/20 text-orange-300 border-orange-500/50'
                : riskResult === 'MONITOR'
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50 glow-emerald'
            }`}
          >
            <Brain className="w-2.5 h-2.5" />
            AI·{riskResult}
          </span>
        )}
      </div>

      {/* 2. Barra de Control Principal Glassmorphic */}
      <div className="flex items-center gap-2 max-w-sm w-full p-2 rounded-2xl glass-panel border border-white/20 shadow-2xl shadow-black/95 backdrop-blur-xl pointer-events-auto">
        {/* Botón Principal: Iniciar / Detener Medición */}
        <button
          onClick={onStartMeasurement}
          className={`flex-1 flex items-center justify-center gap-2 py-3.5 px-4 rounded-xl font-bold text-xs tracking-wider uppercase font-mono transition-all duration-300 active:scale-[0.96] shadow-xl ${
            isMonitoring
              ? 'bg-gradient-to-r from-rose-600 via-red-600 to-rose-700 text-white shadow-rose-950/70 glow-rose border border-rose-400/60 hover:brightness-110'
              : 'bg-gradient-to-r from-emerald-500 via-emerald-600 to-teal-600 text-white shadow-emerald-950/70 glow-emerald border border-emerald-400/60 hover:brightness-110'
          }`}
        >
          {isMonitoring ? (
            <>
              <Square className="w-4 h-4 fill-current animate-pulse text-rose-100" />
              <span className="text-glow-rose">Detener Medición</span>
            </>
          ) : (
            <>
              <Play className="w-4 h-4 fill-current text-emerald-100" />
              <span className="text-glow-emerald">Iniciar Medición</span>
            </>
          )}
        </button>

        {/* Conmutador 3D / 2D Integrado */}
        <button
          type="button"
          onClick={toggle3D}
          aria-pressed={is3DEnabled}
          title={is3DEnabled ? 'Modo 3D activo · pulsar para 2D' : 'Modo 2D activo · pulsar para 3D'}
          className={`flex items-center justify-center gap-1.5 py-3.5 px-3.5 rounded-xl font-bold text-[10px] font-mono tracking-wider uppercase transition-all duration-300 active:scale-[0.95] border ${
            is3DEnabled
              ? 'border-cyan-400/70 bg-cyan-950/70 text-cyan-200 shadow-lg shadow-cyan-950/50 glow-cyan animate-hologram'
              : 'border-white/15 bg-white/5 text-zinc-300 hover:text-white hover:border-white/30 hover:bg-white/10'
          }`}
        >
          <Box className={`w-4 h-4 transition-transform duration-300 ${is3DEnabled ? 'rotate-12 text-cyan-300' : 'text-zinc-400'}`} />
          <span>{is3DEnabled ? '3D' : '2D'}</span>
        </button>

        {/* Botón Reset */}
        <button
          onClick={onReset}
          aria-label="Reiniciar medición"
          title="Reiniciar buffer y estadísticas"
          className="flex items-center justify-center gap-1 py-3.5 px-3 rounded-xl font-bold text-[10px] font-mono tracking-wider uppercase text-zinc-300 bg-white/5 hover:bg-white/10 hover:text-white active:bg-white/15 active:scale-[0.95] border border-white/15 hover:border-white/30 transition-all duration-300"
        >
          <RotateCcw className="w-3.5 h-3.5 text-zinc-400 group-hover:text-white" />
          <span>Reset</span>
        </button>
      </div>
    </div>
  );
}
