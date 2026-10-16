/**
 * Configuración de interfaz de usuario (toasts, tiempos de UI).
 * Fuente canónica: ningún módulo debe redeclarar estos valores.
 */
export const UI_CONFIG = {
  /** Máximo de toasts críticos simultáneos en pantalla. */
  TOAST_LIMIT: 3,
  /** Tiempo (ms) que un toast permanece montado antes de eliminarse del DOM. */
  TOAST_REMOVE_DELAY: 2000,
} as const;
