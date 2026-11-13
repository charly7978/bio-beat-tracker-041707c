import { describe, it, expect } from 'vitest';
import { inferCameraRuntimeHints } from '../cameraDeviceProfile';
import { passesFingerMaintain } from '@/lib/finger/fingerSceneClassifier';

describe('cameraDeviceProfile', () => {
  it('usa la misma política para cualquier marca o user agent ausente', () => {
    const common = { fpsEffective: 30, timestampJitterMs: 3, torchActive: true };
    const expected = inferCameraRuntimeHints(common);
    for (const userAgent of ['Mozilla TCL 6156', 'Motorola moto g84', 'Samsung SM-A546', 'iPhone Safari', '']) {
      expect(inferCameraRuntimeHints({ ...common, userAgent })).toEqual(expected);
    }
  });

  it.each([{ fpsEffective: 16 }, { timestampJitterMs: 60 }])('adapta el contacto a la captura observada: %o', observation => {
    const normal = inferCameraRuntimeHints({ fpsEffective: 30, timestampJitterMs: 3 });
    const slow = inferCameraRuntimeHints(observation);
    expect(slow.liveFingerMissGrace).toBeGreaterThan(normal.liveFingerMissGrace);
    expect(slow.instantLostToNoContact).toBeGreaterThan(normal.instantLostToNoContact);
  });

  it('sólo declara flash fiable cuando está soportado y confirmado activo', () => {
    expect(inferCameraRuntimeHints({ torchActive: false }).torchReliable).toBe(false);
    expect(inferCameraRuntimeHints({ torchSupported: false, torchActive: true }).torchReliable).toBe(false);
    expect(inferCameraRuntimeHints({ torchSupported: true, torchActive: true }).torchReliable).toBe(true);
  });

});

describe('passesFingerMaintain', () => {
  it('acepta RGB moderado con cobertura mínima', () => {
    const ok = passesFingerMaintain(
      { red: 118, green: 52, blue: 42, coverage: 0.12, fingerScore: 0.2 },
      { red: 112, green: 50, blue: 40, coverage: 0.11, fingerScore: 0.18 },
      { coverageRatio: 0.11, fingerScore: 0.18, fingerTileCount: 4 },
    );
    expect(ok).toBe(true);
  });
});

