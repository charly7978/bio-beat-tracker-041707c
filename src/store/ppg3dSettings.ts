/**
 * PPG 3D SETTINGS — Estado de la capa de visualización 3D del monitor cardíaco.
 *
 * La profundidad 3D (grilla en perspectiva + cinta de onda extruida) se dibuja en
 * canvas 2D puro mediante proyección en perspectiva (ver `src/lib/ui/ppg3dProjection.ts`).
 * NO usa Three.js / React-Three-Fiber: es más liviano en móvil, no rompe el build y
 * reusa exactamente las mismas coordenadas honestas de la onda 2D.
 *
 * Este store sólo controla la PRESENTACIÓN. La detección de latidos, la amplitud honesta
 * y el barrido temporal siguen funcionando idénticos al modo 2D.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/** Rango de intensidad de profundidad 3D (escala la inclinación del piso). */
export const PPG3D_INTENSITY_MIN = 0.6;
export const PPG3D_INTENSITY_MAX = 1.4;

export interface Ppg3DSettings {
  /** Activa el render en perspectiva 3D (true) o el monitor 2D clásico (false). */
  enabled: boolean;
  /**
   * Intensidad de la profundidad [PPG3D_INTENSITY_MIN .. PPG3D_INTENSITY_MAX].
   * Escala la inclinación del piso y la altura máxima de la cinta de onda.
   * 1 = calibración por defecto.
   */
  intensity: number;
  toggle: () => void;
}

export const usePpg3dSettings = create<Ppg3DSettings>()(
  persist(
    (set) => ({
      enabled: true,
      intensity: 1,
      toggle: () => set((s) => ({ enabled: !s.enabled })),
    }),
    {
      name: 'ppg-3d-settings',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ enabled: s.enabled, intensity: s.intensity }),
    },
  ),
);
