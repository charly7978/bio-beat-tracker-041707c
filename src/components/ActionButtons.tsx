import { Play, Square, RotateCcw, Box, Cpu, Shield, Activity, Brain } from 'lucide-react';
import { usePpg3dSettings } from '@/store/ppg3dSettings';

export interface ActionButtonsProps {
  isMonitoring: boolean;
  onStartMeasurement: () => void;
  onReset: () => void;
  webgpuAvail?: 'yes' | 'no' | 'checking';
  encryptionReady?: boolean;
  healthAvail?: 'yes' | 'no' | 'checking';
  riskResult?: string | null;
}

export function ActionButtons({
  isMonitoring,
  onStartMeasurement,
  onReset,
  webgpuAvail = 'no',
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
      {/* 1. Fila de Badges de Estado del Sistema */}
      <div className="flex items-center gap-1.5 justify-center mb-1.5 pointer-events-auto">
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[8px] font-mono font-bold tracking-wider uppercase border transition-colors ${
            webgpuAvail === 'yes'
              ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30 glow-cyan'
              : 'bg-zinc-900/60 text-zinc-600 border-zinc-800/60'
          }`}
        >
          <Cpu className="w-2.5 h-2.5" />
          GPU{webgpuAvail === 'yes' ? '·ON' : ''}
        </span>

        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[8px] font-mono font-bold tracking-wider uppercase border transition-colors ${
            encryptionReady
              ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
              : 'bg-zinc-900/60 text-zinc-600 border-zinc-800/60'
          }`}
        >
          <Shield className="w-2.5 h-2.5" />
          {encryptionReady ? 'AES-256' : 'ENC—'}
        </span>

        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[8px] font-mono font-bold tracking-wider uppercase border transition-colors ${
            healthAvail === 'yes'
              ? 'bg-blue-500/10 text-blue-400 border-blue-500/30'
              : 'bg-zinc-900/60 text-zinc-600 border-zinc-800/60'
          }`}
        >
          <Activity className="w-2.5 h-2.5" />
          HEALTH{healthAvail === 'yes' ? '·SYNC' : ''}
        </span>

        {riskResult && (
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[8px] font-mono font-bold tracking-wider uppercase border ${
              riskResult === 'IMMEDIATE'
                ? 'bg-rose-500/15 text-rose-400 border-rose-500/40 glow-rose'
                : riskResult === 'SOON'
                ? 'bg-orange-500/15 text-orange-400 border-orange-500/40'
                : riskResult === 'MONITOR'
                ? 'bg-amber-500/15 text-amber-400 border-amber-500/40'
                : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40 glow-emerald'
            }`}
          >
            <Brain className="w-2.5 h-2.5" />
            AI·{riskResult}
          </span>
        )}
      </div>

      {/* 2. Barra de Control Principal Glassmorphic */}
      <div className="flex items-center gap-2 max-w-sm w-full p-1.5 rounded-2xl glass-panel border border-white/15 shadow-2xl shadow-black/90 pointer-events-auto">
        {/* Botón Principal: Iniciar / Detener */}
        <button
          onClick={onStartMeasurement}
          className={`flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-bold text-xs tracking-wider uppercase font-mono transition-all duration-200 active:scale-[0.97] shadow-lg ${
            isMonitoring
              ? 'bg-gradient-to-r from-rose-600 via-red-600 to-rose-700 text-white shadow-rose-950/60 glow-rose border border-rose-400/50'
              : 'bg-gradient-to-r from-emerald-500 via-emerald-600 to-teal-600 text-white shadow-emerald-950/60 glow-emerald border border-emerald-400/50'
          }`}
        >
          {isMonitoring ? (
            <>
              <Square className="w-3.5 h-3.5 fill-current animate-pulse" />
              <span>Detener Medición</span>
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>Iniciar Medición</span>
            </>
          )}
        </button>

        {/* Conmutador 3D / 2D Integrado */}
        <button
          type="button"
          onClick={toggle3D}
          aria-pressed={is3DEnabled}
          title={is3DEnabled ? 'Modo 3D activo · pulsar para 2D' : 'Modo 2D activo · pulsar para 3D'}
          className={`flex items-center justify-center gap-1 py-3 px-3 rounded-xl font-bold text-[10px] font-mono tracking-wider uppercase transition-all duration-200 active:scale-[0.96] border ${
            is3DEnabled
              ? 'border-cyan-400/60 bg-cyan-950/60 text-cyan-300 shadow-lg shadow-cyan-950/40 glow-cyan animate-hologram'
              : 'border-white/10 bg-white/5 text-zinc-400 hover:text-zinc-200 hover:border-white/20'
          }`}
        >
          <Box className={`w-3.5 h-3.5 transition-transform duration-300 ${is3DEnabled ? 'rotate-12 text-cyan-300' : 'text-zinc-400'}`} />
          <span>{is3DEnabled ? '3D' : '2D'}</span>
        </button>

        {/* Botón Reset */}
        <button
          onClick={onReset}
          aria-label="Reiniciar medición"
          title="Reiniciar buffer y estadísticas"
          className="flex items-center justify-center gap-1 py-3 px-3 rounded-xl font-bold text-[10px] font-mono tracking-wider uppercase text-zinc-300 bg-white/5 hover:bg-white/10 active:bg-white/15 active:scale-[0.96] border border-white/10 hover:border-white/20 transition-all duration-200"
        >
          <RotateCcw className="w-3.5 h-3.5 text-zinc-400" />
          <span>Reset</span>
        </button>
      </div>
    </div>
  );
}
