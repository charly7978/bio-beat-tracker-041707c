import React from 'react';
import { Box } from 'lucide-react';
import { usePpg3dSettings } from '@/store/ppg3dSettings';

export function Ppg3DToggle() {
  const enabled = usePpg3dSettings((s) => s.enabled);
  const toggle = usePpg3dSettings((s) => s.toggle);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={enabled}
      title={enabled ? 'Modo 3D activo · Toca para alternar a 2D' : 'Modo 2D activo · Toca para alternar a 3D'}
      className={`absolute right-3 z-20 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold tracking-wider backdrop-blur-md border transition-all shadow-md active:scale-95 ${
        enabled
          ? 'border-cyan-500/50 bg-cyan-950/60 text-cyan-300 shadow-cyan-950/30'
          : 'border-white/10 bg-black/60 text-zinc-400 hover:text-white'
      }`}
      style={{
        bottom: 'calc(60px + env(safe-area-inset-bottom, 0px))',
      }}
    >
      <Box className="h-3.5 w-3.5" />
      <span>{enabled ? '3D' : '2D'}</span>
    </button>
  );
}
