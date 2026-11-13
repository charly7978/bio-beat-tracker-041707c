/**
 * Perfil de cámara en runtime.
 * Una política común, ajustada por cadencia observada; la marca no prueba calidad.
 */
export interface CameraRuntimeHints {
  /** Captura web sin garantía fotométrica: mantiene la tolerancia de contacto. */
  constrained: boolean;
  torchReliable: boolean;
  minPiScale: number;
  ensembleConfScale: number;
  liveFingerMissGrace: number;
  fingerConfirmFrames: number;
  instantLostToUnstable: number;
  instantLostToNoContact: number;
  bufferResetAfterNoContact: number;
  gateRangeScale: number;
}

const TOLERANT_DEFAULT: Omit<CameraRuntimeHints, 'torchReliable' | 'constrained'> = {
  minPiScale: 0.1,
  ensembleConfScale: 0.5,
  liveFingerMissGrace: 32,
  fingerConfirmFrames: 3,
  instantLostToUnstable: 22,
  instantLostToNoContact: 48,
  bufferResetAfterNoContact: 80,
  gateRangeScale: 0.65,
};

export function inferCameraRuntimeHints(
  cameraDiag?: Record<string, unknown> | null,
): CameraRuntimeHints {
  const fps = typeof cameraDiag?.fpsEffective === 'number' ? cameraDiag.fpsEffective : 0;
  const jitter =
    typeof cameraDiag?.timestampJitterMs === 'number' ? cameraDiag.timestampJitterMs : 0;
  const torchSupported = cameraDiag?.torchSupported !== false;
  const torchActive = cameraDiag?.torchActive === true;
  const torchReliable = torchSupported && torchActive;

  const constrained = true;

  let profile = { ...TOLERANT_DEFAULT };
  if ((Number.isFinite(fps) && fps > 0 && fps < 18) || (Number.isFinite(jitter) && jitter > 55)) {
    profile = {
      ...profile,
      liveFingerMissGrace: 40,
      instantLostToNoContact: 60,
      bufferResetAfterNoContact: 70,
    };
  }

  return {
    constrained,
    torchReliable,
    ...profile,
  };
}

