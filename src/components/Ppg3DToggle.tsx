/**
 * Ppg3DToggle — Conmuta la capa de profundidad 3D del monitor cardíaco.
 *
 * 3D = grilla en perspectiva (profundidad) + onda como cinta extruida.
 * 2D = monitor clásico. La detección y la onda honesta son idénticas en ambos modos;
 * sólo cambia la presentación (ver `src/lib/ui/ppg3dProjection.ts`).
 */
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
      title={enabled ? 'Vista 3D activa · toca para 2D' : 'Vista 2D · toca para 3D'}
      className={`absolute right-3 z-20 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[10px] font-bold tracking-wider uppercase backdrop-blur-md transition-all duration-200 active:scale-95 shadow-lg ${
        enabled
          ? 'border border-cyan-400/60 bg-cyan-950/60 text-cyan-300 shadow-cyan-950/40 glow-cyan animate-hologram'
          : 'border border-white/10 bg-black/50 text-zinc-400 hover:text-zinc-200 hover:border-white/20'
      }`}
      style={{
        bottom: 'calc(68px + env(safe-area-inset-bottom, 0px))',
      }}
    >
      <Box className={`h-3.5 w-3.5 transition-transform duration-300 ${enabled ? 'rotate-12 text-cyan-300' : 'text-zinc-400'}`} />
      <span className="font-mono">{enabled ? '3D ON' : '2D'}</span>
    </button>
  );
}
