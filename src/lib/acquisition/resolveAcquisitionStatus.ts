import type { MeasurementStatus } from '@/types/measurements';
import type { ContactState } from '@/types/signal';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

export interface AcquisitionStatusInput {
  contactState: ContactState;
  fingerDetected: boolean;
  coverageRatio: number;
  perfusionIndex: number;
  motionScore: number;
  saturationRatio: number;
  underexposureRatio: number;
  fpsEffective: number;
  frameDropRatio: number;
  timestampJitterMs: number;
  torchActive?: boolean;
  torchSupported?: boolean;
  mode?: 'finger' | 'gym';
  faceDetected?: boolean;
}

/**
 * Estado técnico de adquisición (una sola función — no duplicar en UI/processors).
 */
export function resolveAcquisitionStatus(input: AcquisitionStatusInput): MeasurementStatus {
  const F = VITAL_THRESHOLDS.FINGER;
  const Q = VITAL_THRESHOLDS.QUALITY;
  const isGym = input.mode === 'gym';

  // Antorcha solo requerida en modo finger (cámara trasera con flash)
  if (!isGym) {
    if (input.torchSupported === false) return 'TORCH_UNAVAILABLE';
    if (input.torchSupported && input.torchActive === false) return 'TORCH_UNAVAILABLE';
  }

  const hasPresence = isGym
    ? Boolean(input.faceDetected || input.fingerDetected)
    : Boolean(input.fingerDetected);

  if (!hasPresence || input.contactState === 'NO_CONTACT') {
    return 'NO_FINGER';
  }

  if (input.saturationRatio > VITAL_THRESHOLDS.ROUTER.SATURATION_FRAME_RATIO) return 'SATURATED';
  if ((input.underexposureRatio ?? 0) > VITAL_THRESHOLDS.ROUTER.UNDEREXPOSURE_FRAME_RATIO) {
    return 'UNDEREXPOSED';
  }
  if (input.motionScore > Q.MAX_MOTION) return 'MOTION_ARTIFACT';
  if (input.fpsEffective > 0 && input.fpsEffective < 20) return 'LOW_FPS';
  if (input.timestampJitterMs > Q.MAX_JITTER_MS) return 'LOW_FPS';

  if (input.perfusionIndex > 0 && input.perfusionIndex < Q.MIN_PI * 0.35) {
    return 'LOW_SIGNAL_QUALITY';
  }

  // En gym mode el rostro ocupa un área menor de la pantalla (15-40%), no el 50-70% del dedo
  const minCoverage = isGym ? 0.12 : (F.MIN_COVERAGE * 0.7);
  if (input.coverageRatio < minCoverage) {
    return 'LOW_SIGNAL_QUALITY';
  }

  if (!isGym && input.coverageRatio > 0.55 && input.perfusionIndex < Q.MIN_PI * 0.5) {
    return 'LOW_SIGNAL_QUALITY';
  }

  if (input.frameDropRatio > 0.25) return 'LOW_FPS';

  return input.contactState === 'STABLE_CONTACT' ? 'VALID' : 'WARMUP';
}
