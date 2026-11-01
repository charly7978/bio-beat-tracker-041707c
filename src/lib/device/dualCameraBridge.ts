/**
 * DUAL CAMERA BRIDGE — Puente de captura del sitio proximal (frontal)
 * ===================================================================
 * Captura dual del modo NEXUS (cara + dedo, blueprint
 * docs/nexus-vitals-blueprint.md capítulo 6). La doctrina de niveles:
 *
 *   L0  solo dedo (pipeline existente; CameraView sigue siendo el ÚNICO
 *       dueño del stream trasero — pedir la trasera aquí chocaría con el
 *       stream vivo y lo cerraría).
 *   L2  dedo + cara concurrentes en web: este módulo abre SOLO el stream
 *       frontal; el distal ya corre gestionado por CameraView + worker.
 *   L3/L4  sesiones nativas concurrentes (AVCaptureMultiCamSession /
 *       Camera2 dual) y alta velocidad — requieren el plugin nativo
 *       Capacitor del plan; el contrato quedará abierto cuando el puente
 *       nativo exista.
 *
 * Políticas de honestidad (coherentes con `check:no-sim` y waveHonesty):
 *  - Cada fallo de apertura devuelve UN motivo técnico explícito; nunca se
 *    disimula un nivel inferior ("degradación elegante con motivo").
 *  - El módulo no muta dispositivos ni torch: solo solicita el frontal con
 *    constraints moderados (alineados con CAMERA_RESOLUTION.gym).
 */

/** Resultado de la negociación del sitio proximal (cara). */
export interface ProximalCaptureResult {
  /** 'L2' con stream frontal abierto; 'L0' si solo queda el modo dedo. */
  level: 'L0' | 'L2';
  /** Stream del sitio proximal (frontal), null si no se abrió. */
  proximalStream: MediaStream | null;
  /** Motivo técnico siempre presente ('PROXIMAL_ABIERTO' en el caso feliz). */
  reason: string;
}

/** Entorno mínimo inyectable para la negociación (tests sin DOM real). */
export interface ProximalCaptureEnv {
  getUserMedia?: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStream>;
}

/** Motivos técnicos de la negociación (constantes estables para UI/tests). */
export const PROXIMAL_REASONS = {
  OPEN: 'PROXIMAL_ABIERTO',
  API_MISSING: 'API_NO_DISPONIBLE',
  PERMISSION_DENIED: 'PERMISO_NO_CONCEDIDO',
  DEVICE_MISSING: 'FRONTAL_NO_DISPONIBLE',
  OPEN_FAILED: 'APERTURA_FALLIDA',
} as const;

/**
 * Foto del entorno web real: se toma al llamar (no en import) para respetar
 * entornos donde `navigator.mediaDevices` sensa por HTTPS/seguridad.
 */
export function readProximalEnv(): ProximalCaptureEnv {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const media = nav as (Navigator & { mediaDevices?: MediaDevices & { getUserMedia?: ProximalCaptureEnv['getUserMedia'] } }) | undefined;
  return { getUserMedia: media?.mediaDevices?.getUserMedia };
}

/**
 * Constraints del sitio proximal: frontal, resolución moderada y 30 fps
 * objetivo (mismo presupuesto que el modo gym: menos píxeles = más FPS).
 */
export function proximalConstraints(): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 },
    },
  };
}

/** Clasifica el fallo de apertura en un motivo técnico explícito. */
function classifyOpenError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return PROXIMAL_REASONS.PERMISSION_DENIED;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return PROXIMAL_REASONS.DEVICE_MISSING;
    default:
      return PROXIMAL_REASONS.OPEN_FAILED;
  }
}

/**
 * Negocia la captura del sitio proximal. Jamás toca el stream trasero:
 * CameraView lo administra con exclusividad (torch, optimizeForFinger,
 * diagnostics) y anya re-apertura lo interrumpiría.
 */
export async function negotiateProximalCapture(
  env: ProximalCaptureEnv,
): Promise<ProximalCaptureResult> {
  if (typeof env.getUserMedia !== 'function') {
    return { level: 'L0', proximalStream: null, reason: PROXIMAL_REASONS.API_MISSING };
  }
  try {
    const stream = await env.getUserMedia(proximalConstraints());
    if (!stream) {
      return { level: 'L0', proximalStream: null, reason: PROXIMAL_REASONS.OPEN_FAILED };
    }
    return { level: 'L2', proximalStream: stream, reason: PROXIMAL_REASONS.OPEN };
  } catch (error) {
    return { level: 'L0', proximalStream: null, reason: classifyOpenError(error) };
  }
}

/** Libera el stream proximal de forma defensible (tracks + referencia). */
export function releaseProximalStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Un track ya detenido no debe interrumpir la liberación del resto.
    }
  }
}
