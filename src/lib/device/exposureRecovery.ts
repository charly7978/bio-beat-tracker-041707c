import { CAMERA_EXPOSURE_RECOVERY_DEFAULTS as C } from '@/config/signalProcessing';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

export interface FingerExposurePhotometry {
  sealRatio: number;
  tissueRed: number;
  clippedRatio: number;
}

interface ExposureCapabilities {
  exposureCompensation?: { min?: number; max?: number; step?: number };
}

interface ExposureSettings {
  exposureMode?: string;
  exposureCompensation?: number;
}

type RecoveryStatus = 'idle' | 'waiting' | 'adjusting' | 'locked' | 'unsupported' | 'blocked';

function isAutomatic(mode: string | undefined): boolean {
  return mode === 'continuous' || mode === 'single-shot';
}

function validPhotometry(p: FingerExposurePhotometry): boolean {
  return [p.sealRatio, p.tissueRed, p.clippedRatio].every(Number.isFinite) &&
    p.sealRatio >= 0 && p.sealRatio <= 1 && p.clippedRatio >= 0 && p.clippedRatio <= 1 &&
    p.tissueRed >= 0 && p.tissueRed <= 255;
}

/**
 * Feedback acotado de compensación EV mientras AE sigue automático.
 * No interpreta pulso ni altera los gates de señal. El recorte fotométrico puede
 * impedir adquirir contacto antes de que optimizeForFinger tenga señal que fijar.
 */
export class FingerExposureRecovery {
  private track: MediaStreamTrack | null = null;
  private generation = 0;
  private pending: Promise<void> | null = null;
  private finalLockRequested = false;
  private finalLockInFlight = false;
  private lastObservationMs: number | null = null;
  private clippingSinceMs: number | null = null;
  private lastAttemptMs: number | null = null;
  private previousImage: FingerExposurePhotometry | null = null;
  private noProgress = 0;
  private attempts = 0;
  private status: RecoveryStatus = 'idle';
  private reason = 'waiting-for-photometry';

  clear(): void {
    this.generation++;
    this.track = null;
    this.pending = null;
    this.finalLockRequested = false;
    this.finalLockInFlight = false;
    this.lastObservationMs = null;
    this.clippingSinceMs = null;
    this.lastAttemptMs = null;
    this.previousImage = null;
    this.noProgress = 0;
    this.attempts = 0;
    this.status = 'idle';
    this.reason = 'waiting-for-photometry';
  }

  private bind(track: MediaStreamTrack): void {
    if (this.track !== track) {
      this.clear();
      this.track = track;
    }
  }

  getDiagnostics() {
    return { status: this.status, reason: this.reason, attempts: this.attempts };
  }

  /** Called synchronously before optimizeForFinger starts changing ISP modes. */
  async beginFinalLock(track: MediaStreamTrack): Promise<boolean> {
    this.bind(track);
    if (this.finalLockInFlight || track.readyState !== 'live') return false;
    this.finalLockRequested = true;
    this.finalLockInFlight = true;
    const generation = this.generation;
    if (this.pending) await this.pending;
    if (this.generation !== generation || this.track !== track || track.readyState !== 'live') return false;
    this.status = 'locked';
    this.reason = 'stable-contact-lock';
    return true;
  }

  isCurrentLock(track: MediaStreamTrack): boolean {
    return this.track === track && this.finalLockRequested && this.finalLockInFlight && track.readyState === 'live';
  }

  finishFinalLock(track: MediaStreamTrack): void {
    if (this.track === track) this.finalLockInFlight = false;
  }

  observe(track: MediaStreamTrack, p: FingerExposurePhotometry, timestampMs: number): Promise<void> {
    this.bind(track);
    if (this.pending) return this.pending;
    if (this.finalLockRequested || track.readyState !== 'live' || this.status === 'unsupported' || this.status === 'blocked') {
      return Promise.resolve();
    }
    if (!Number.isFinite(timestampMs) || timestampMs <= 0 || !validPhotometry(p)) {
      this.clippingSinceMs = null;
      this.reason = 'invalid-photometry';
      return Promise.resolve();
    }
    if (this.lastObservationMs !== null) {
      if (timestampMs === this.lastObservationMs) return Promise.resolve();
      if (timestampMs < this.lastObservationMs || timestampMs - this.lastObservationMs > C.observationGapMs) {
        this.clippingSinceMs = null;
      }
      if (timestampMs < this.lastObservationMs) this.lastAttemptMs = null;
    }
    this.lastObservationMs = timestampMs;
    const clippedFinger = p.sealRatio >= VITAL_THRESHOLDS.PRESSURE.COVER_GOOD &&
      p.tissueRed >= VITAL_THRESHOLDS.PIXEL_ROI.SATURATION_RED && p.clippedRatio >= C.clippedFraction;
    if (!clippedFinger) {
      this.clippingSinceMs = null;
      this.previousImage = null;
      this.noProgress = 0;
      this.status = 'idle';
      this.reason = 'no-sustained-finger-clipping';
      return Promise.resolve();
    }
    this.clippingSinceMs ??= timestampMs;
    this.status = 'waiting';
    this.reason = 'sustained-clipping-dwell';
    if (timestampMs - this.clippingSinceMs < C.clippingDwellMs ||
      (this.lastAttemptMs !== null && timestampMs - this.lastAttemptMs < C.cooldownMs)) return Promise.resolve();
    if (this.attempts >= C.maxAttempts) {
      this.status = 'blocked'; this.reason = 'attempt-limit'; return Promise.resolve();
    }
    if (this.previousImage) {
      const improved = this.previousImage.tissueRed - p.tissueRed >= C.minImageLevelProgress ||
        this.previousImage.clippedRatio - p.clippedRatio >= C.minClippedFractionProgress;
      this.noProgress = improved ? 0 : this.noProgress + 1;
      if (this.noProgress >= C.maxNoProgressAttempts) {
        this.status = 'blocked'; this.reason = 'no-image-progress'; return Promise.resolve();
      }
    }
    const generation = this.generation;
    const operation = this.apply(track, p, timestampMs, generation).finally(() => {
      if (this.pending === operation) this.pending = null;
    });
    this.pending = operation;
    return operation;
  }

  private async apply(track: MediaStreamTrack, image: FingerExposurePhotometry, timestampMs: number, generation: number): Promise<void> {
    try {
      const caps = (track.getCapabilities?.() ?? {}) as ExposureCapabilities;
      const before = (track.getSettings?.() ?? {}) as ExposureSettings;
      const range = caps.exposureCompensation;
      const current = before.exposureCompensation;
      if (!isAutomatic(before.exposureMode) || !range || !Number.isFinite(range.min) ||
        !Number.isFinite(range.max) || !Number.isFinite(current) || range.max! <= range.min!) {
        this.status = 'unsupported'; this.reason = 'automatic-ev-unavailable'; return;
      }
      const step = typeof range.step === 'number' && Number.isFinite(range.step) && range.step > 0 ? range.step : 0;
      let target = Math.max(range.min!, Math.min(range.max!, current! - C.stepEv));
      if (step > 0) target = range.min! + Math.floor((target - range.min!) / step + 1e-6) * step;
      if (target >= current! - 1e-6) {
        this.status = 'blocked'; this.reason = 'ev-lower-bound'; return;
      }
      this.status = 'adjusting'; this.reason = 'reduce-clipped-finger-exposure';
      this.attempts++;
      this.lastAttemptMs = timestampMs;
      this.previousImage = { ...image };
      await track.applyConstraints({ advanced: [{ exposureCompensation: target } as MediaTrackConstraintSet] });
      if (this.generation !== generation || this.track !== track || track.readyState !== 'live') return;
      const after = (track.getSettings?.() ?? {}) as ExposureSettings;
      if (!isAutomatic(after.exposureMode) || !Number.isFinite(after.exposureCompensation) || after.exposureCompensation! >= current! - 1e-6) {
        this.status = 'blocked'; this.reason = 'ev-change-unverified'; return;
      }
      this.status = 'waiting'; this.reason = 'awaiting-image-response';
    } catch {
      if (this.generation === generation && this.track === track) {
        this.status = 'blocked'; this.reason = 'ev-request-rejected';
      }
    }
  }
}
