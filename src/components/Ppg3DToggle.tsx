import React from 'react';
import { Box } from 'lucide-react';
import { usePpg3dSettings } from '@/store/ppg3dSettings';

export function Ppg3DToggle({ disabled = false }: { disabled?: boolean }) {
  const enabled = usePpg3dSettings((s) => s.enabled);
  const toggle = usePpg3dSettings((s) => s.toggle);
  return <button type="button" onClick={toggle} disabled={disabled}
    aria-pressed={enabled && !disabled} aria-label="Alternar perspectiva 2D y 3D"
    title={disabled ? 'Inspección en 2D para explorar muestras' : 'Cambiar perspectiva del monitor'}
    className="monitor-dimension-toggle">
    <Box size={14}/><span>{enabled && !disabled ? '3D' : '2D'}</span>
  </button>;
}
