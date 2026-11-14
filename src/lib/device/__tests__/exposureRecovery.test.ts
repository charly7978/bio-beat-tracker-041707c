import { describe, expect, it } from 'vitest';
import { FingerExposureRecovery, type FingerExposurePhotometry } from '../exposureRecovery';

const CLIPPED: FingerExposurePhotometry = { sealRatio: 0.8, tissueRed: 255, clippedRatio: 0.95 };

function camera(options: { mode?: string; ev?: number; ignored?: boolean; unsupported?: boolean; deferred?: Promise<void> } = {}) {
  const calls: MediaTrackConstraints[] = [];
  const settings = { exposureMode: options.mode ?? 'continuous', exposureCompensation: options.ev ?? 0 };
  const track = {
    readyState: 'live',
    getCapabilities: () => options.unsupported ? {} : { exposureCompensation: { min: -2, max: 2, step: 0.25 } },
    getSettings: () => ({ ...settings }),
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      calls.push(constraints);
      if (options.deferred) await options.deferred;
      if (!options.ignored) settings.exposureCompensation = (constraints.advanced![0] as { exposureCompensation: number }).exposureCompensation;
    },
  };
  return { track: track as unknown as MediaStreamTrack, calls, settings };
}

async function feed(control: FingerExposureRecovery, track: MediaStreamTrack, start = 1000, end = 1600, photometry = CLIPPED) {
  for (let t = start; t <= end; t += 100) await control.observe(track, photometry, t);
}

describe('recuperación universal de exposición antes del lock', () => {
  it('espera evidencia sostenida y sólo reduce compensación con AE automático', async () => {
    const control = new FingerExposureRecovery();
    const c = camera();
    await feed(control, c.track, 1000, 1500);
    expect(c.calls).toHaveLength(0);
    await control.observe(c.track, CLIPPED, 1600);
    expect(c.calls).toEqual([{ advanced: [{ exposureCompensation: -0.5 }] }]);
    expect(c.settings.exposureMode).toBe('continuous');
    expect(control.getDiagnostics()).toEqual({ status: 'waiting', reason: 'awaiting-image-response', attempts: 1 });
  });

  it.each(['manual', 'none', ''])('no cambia exposición cuando el modo real es %s', async mode => {
    const control = new FingerExposureRecovery();
    const c = camera({ mode });
    await feed(control, c.track, 1000, 5000);
    expect(c.calls).toHaveLength(0);
    expect(control.getDiagnostics().status).toBe('unsupported');
  });

  it('no presupone un control que el dispositivo no expone', async () => {
    const control = new FingerExposureRecovery();
    const c = camera({ unsupported: true });
    await feed(control, c.track, 1000, 5000);
    expect(c.calls).toHaveLength(0);
    expect(control.getDiagnostics().reason).toBe('automatic-ev-unavailable');
  });

  it.each([
    { ...CLIPPED, sealRatio: 0.05 },
    { ...CLIPPED, tissueRed: 180, clippedRatio: 0.1 },
    { ...CLIPPED, clippedRatio: NaN },
  ])('no ajusta por un flash sin tejido o por fotometría no utilizable: %o', async p => {
    const control = new FingerExposureRecovery();
    const c = camera();
    await feed(control, c.track, 1000, 5000, p);
    expect(c.calls).toHaveLength(0);
  });

  it('un hueco o timestamp repetido no crea dwell de contacto', async () => {
    const control = new FingerExposureRecovery();
    const c = camera();
    await feed(control, c.track, 1000, 1300);
    for (let i = 0; i < 30; i++) await control.observe(c.track, CLIPPED, 1300);
    await control.observe(c.track, CLIPPED, 3000);
    expect(c.calls).toHaveLength(0);
    await feed(control, c.track, 3100, 3600);
    expect(c.calls).toHaveLength(1);
  });

  it('respeta cooldown y se detiene cuando cambia EV sin mejorar la imagen', async () => {
    const control = new FingerExposureRecovery();
    const c = camera();
    await feed(control, c.track, 1000, 3000);
    expect(c.calls).toHaveLength(1);
    await control.observe(c.track, CLIPPED, 3100);
    expect(c.calls).toHaveLength(2);
    await feed(control, c.track, 3200, 6000);
    expect(c.calls).toHaveLength(2);
    expect(control.getDiagnostics().reason).toBe('no-image-progress');
  });

  it('deja de insistir si applyConstraints no queda reflejado en settings', async () => {
    const control = new FingerExposureRecovery();
    const c = camera({ ignored: true });
    await feed(control, c.track, 1000, 6000);
    expect(c.calls).toHaveLength(1);
    expect(control.getDiagnostics().reason).toBe('ev-change-unverified');
  });

  it('la retirada sostenida renueva el presupuesto aunque nunca se alcanzó contacto estable', async () => {
    const control = new FingerExposureRecovery();
    const c = camera();
    await feed(control, c.track, 1000, 6000);
    expect(control.getDiagnostics().status).toBe('blocked');
    await feed(control, c.track, 6100, 6700, { sealRatio: 0, tissueRed: 50, clippedRatio: 0 });
    expect(control.getDiagnostics()).toEqual({ status: 'idle', reason: 'uncovered-new-placement', attempts: 0 });
    await feed(control, c.track, 6800, 7400);
    expect(c.calls).toHaveLength(3);
    expect(control.getDiagnostics().attempts).toBe(1);
  });

  it('respeta el límite inferior de EV sin repetir requests idénticas', async () => {
    const control = new FingerExposureRecovery();
    const c = camera({ ev: -2 });
    await feed(control, c.track, 1000, 6000);
    expect(c.calls).toHaveLength(0);
    expect(control.getDiagnostics().reason).toBe('ev-lower-bound');
  });

  it('serializa el bloqueo final detrás de una compensación pendiente', async () => {
    let release!: () => void;
    const deferred = new Promise<void>(resolve => { release = resolve; });
    const control = new FingerExposureRecovery();
    const c = camera({ deferred });
    await feed(control, c.track, 1000, 1500);
    const adjustment = control.observe(c.track, CLIPPED, 1600);
    let locks = 0;
    const lock = control.lockForFinger(c.track, async (isCurrent, markChange) => { expect(isCurrent()).toBe(true); markChange(); locks++; });
    await Promise.resolve();
    expect(locks).toBe(0);
    expect(control.getAcquisitionState().settling).toBe(true);
    await control.lockForFinger(c.track, async () => { locks++; });
    release();
    await adjustment;
    await lock;
    expect(locks).toBe(1);
    await feed(control, c.track, 1700, 6000);
    expect(c.calls).toHaveLength(1);
    expect(control.getDiagnostics().status).toBe('locked');
    expect(control.getAcquisitionState()).toEqual({ revision: 2, settling: false });
  });

  it('un resultado atrasado de otra track no modifica el estado de la nueva', async () => {
    let release!: () => void;
    const deferred = new Promise<void>(resolve => { release = resolve; });
    const control = new FingerExposureRecovery();
    const old = camera({ deferred });
    await feed(control, old.track, 1000, 1500);
    const pending = control.observe(old.track, CLIPPED, 1600);
    // Let the old request reach the driver, then replace the track.
    await Promise.resolve();
    control.clear();
    const current = camera();
    await feed(control, current.track, 2000, 2500);
    const next = control.observe(current.track, CLIPPED, 2600);
    expect(current.calls).toHaveLength(0);
    release(); await pending; await next;
    expect(current.calls).toHaveLength(1);
    expect(control.getDiagnostics()).toEqual({ status: 'waiting', reason: 'awaiting-image-response', attempts: 1 });
  });

  it('la pérdida y reentrada no reviven el lease de un lock antiguo', async () => {
    let release!: () => void;
    const deferred = new Promise<void>(resolve => { release = resolve; });
    const control = new FingerExposureRecovery();
    const c = camera();
    const steps: string[] = [];
    const first = control.lockForFinger(c.track, async (isCurrent, markChange) => {
      markChange();
      steps.push('old-mode');
      await deferred;
      if (isCurrent()) steps.push('old-value');
    });
    await Promise.resolve();
    const restore = control.resumeAcquisition(c.track, async (isCurrent, markChange) => {
      markChange();
      expect(isCurrent()).toBe(true); steps.push('continuous');
    });
    const second = control.lockForFinger(c.track, async (isCurrent, markChange) => {
      markChange();
      expect(isCurrent()).toBe(true); steps.push('new-lock');
    });
    expect(steps).toEqual(['old-mode']);
    expect(control.getAcquisitionState().settling).toBe(true);
    release();
    await Promise.all([first, restore, second]);
    expect(steps).toEqual(['old-mode', 'continuous', 'new-lock']);
    expect(control.getAcquisitionState()).toEqual({ revision: 3, settling: false });
    expect(control.getDiagnostics().status).toBe('locked');
  });

  it('restaura después de un EV pendiente y permite recuperar el nuevo contacto', async () => {
    let release!: () => void;
    const deferred = new Promise<void>(resolve => { release = resolve; });
    const control = new FingerExposureRecovery();
    const c = camera({ deferred });
    await feed(control, c.track, 1000, 1500);
    const old = control.observe(c.track, CLIPPED, 1600);
    await Promise.resolve();
    let restored = false;
    const restore = control.resumeAcquisition(c.track, async () => { restored = true; });
    await control.observe(c.track, CLIPPED, 2000);
    expect(restored).toBe(false);
    release(); await old; await restore;
    expect(restored).toBe(true);
    await feed(control, c.track, 3000, 3600);
    expect(c.calls).toHaveLength(2);
    expect(control.getDiagnostics().attempts).toBe(1);
  });

  it('una track detenida no ejecuta un lock encolado', async () => {
    let release!: () => void;
    const deferred = new Promise<void>(resolve => { release = resolve; });
    const control = new FingerExposureRecovery();
    const c = camera({ deferred });
    await feed(control, c.track, 1000, 1500);
    const pending = control.observe(c.track, CLIPPED, 1600);
    await Promise.resolve();
    let locked = false;
    const lock = control.lockForFinger(c.track, async () => { locked = true; });
    Object.defineProperty(c.track, 'readyState', { value: 'ended' });
    release(); await pending; await lock;
    expect(locked).toBe(false);
    expect(control.getAcquisitionState().settling).toBe(false);
  });
});
