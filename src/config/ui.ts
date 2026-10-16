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

/**
 * Valores por defecto del perfil de usuario para calibración.
 * Fuente canónica: Index.tsx y cualquier componente que necesite valores iniciales.
 */
export const DEFAULT_USER_PROFILE = {
  age: '35',
  height: '172',
  weight: '70',
  gender: 'male' as const,
} as const;

/**
 * Constantes de cámara para CameraView.
 * Fuente canónica: ningún componente debe redeclarar estos valores.
 */
export const CAMERA_CONFIG = {
  /** Tiempo máximo de espera a que el <video> presente el primer frame (ms). */
  WAIT_FOR_VIDEO_TIMEOUT_MS: 8000,
  /** PID controller gains para ajuste de ISO/exposure. */
  PID_KP: 0.4,
  PID_KI: 0.015,
  PID_KD: 0.12,
} as const;
