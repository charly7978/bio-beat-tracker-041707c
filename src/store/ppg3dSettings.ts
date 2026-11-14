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

export interface Ppg3DSettings {
  /** Activa el render en perspectiva 3D (true) o el monitor 2D clásico (false). */
  enabled: boolean;
  /**
   * Intensidad de la profundidad [0.6 .. 1.4]. Escala la inclinación del piso y la
   * altura máxima de la cinta de onda. 1 = calibración por defecto.
   */
  intensity: number;
  toggle: () => void;
  setEnabled: (v: boolean) => void;
  setIntensity: (v: number) => void;
}

export const usePpg3dSettings = create<Ppg3DSettings>()(
  persist(
    (set) => ({
      enabled: true,
      intensity: 1,
      toggle: () => set((s) => ({ enabled: !s.enabled })),
      setEnabled: (v) => set({ enabled: v }),
      setIntensity: (v) => set({ intensity: Math.max(0.6, Math.min(1.4, v)) }),
    }),
    {
      name: 'ppg-3d-settings',
      version: 2,
      // El render 2D pasa a ser el perfil inicial para priorizar fluidez en móvil.
      // La opción 3D sigue disponible en el toggle y se puede activar explícitamente.
      migrate: (persistedState) => ({
        ...((persistedState ?? {}) as Partial<Ppg3DSettings>),
        enabled: false,
      }) as Ppg3DSettings,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ enabled: s.enabled, intensity: s.intensity }),
    },
  ),
);
