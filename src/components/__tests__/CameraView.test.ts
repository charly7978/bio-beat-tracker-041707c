import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CameraView, { type CameraViewHandle } from '../CameraView';

vi.mock('@/lib/device/platform', () => ({ isNative: () => false }));
vi.mock('@/lib/device/lensCoLocation', () => ({
  startLensCoLocationScan: vi.fn(async () => ({ verdict: 'inconclusive' })),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

type Controls = Record<string, string | number | boolean>;
function camera(options: { ignore?: (entry: Controls) => boolean; reject?: (entry: Controls) => boolean; torchSyntax?: 'fourth' | 'stale'; unsupported?: boolean } = {}) {
  const settings: Controls = {
    exposureMode: 'continuous', whiteBalanceMode: 'continuous', focusMode: 'continuous',
    iso: 120, exposureTime: 15, colorTemperature: 5100, focusDistance: 5, frameRate: 30,
  };
  const calls: Controls[] = [];
  const track = {
    readyState: 'live',
    getSettings: () => ({ ...settings }),
    getCapabilities: () => options.unsupported ? {} : {
      exposureMode: ['continuous', 'manual'], whiteBalanceMode: ['continuous', 'manual'],
      focusMode: ['continuous', 'manual'], focusDistance: { min: 2.5, max: 10 },
      iso: { min: 25, max: 800 }, exposureTime: { min: 1, max: 100 },
      exposureCompensation: { min: -2, max: 2 }, colorTemperature: { min: 2000, max: 8000 },
      frameRate: { min: 15, max: 30 }, torch: true,
    },
    applyConstraints: vi.fn(async (constraints: MediaTrackConstraints) => {
      const entry = (constraints.advanced?.[0] ?? constraints) as Controls;
      calls.push({ ...entry });
      if (options.reject?.(entry)) throw new Error('Control rejected');
      if (options.ignore?.(entry)) return;
      if ('torch' in entry || 'torchMode' in entry) {
        if (options.torchSyntax === 'fourth') {
          if (entry.torchMode !== 'torch' && entry.torch !== false) throw new Error('Torch syntax rejected');
          settings.torch = entry.torchMode === 'torch';
        } else if (options.torchSyntax !== 'stale') settings.torch = entry.torch === true;
        return;
      }
      if (entry.exposureMode === 'manual') { settings.iso = 25; settings.exposureTime = 1; }
      if (entry.whiteBalanceMode === 'manual') settings.colorTemperature = 2000;
      Object.assign(settings, entry);
    }),
    stop: vi.fn(() => { track.readyState = 'ended'; }),
  };
  const stream = {
    getVideoTracks: () => [track], getTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream, calls, settings };
}

const roots = new Set<Root>();
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
async function renderCamera(getUserMedia: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  const ref = createRef<CameraViewHandle>();
  const ready = vi.fn();
  const root = createRoot(document.createElement('div'));
  roots.add(root);
  act(() => root.render(createElement(CameraView, { ref, isMonitoring: true, onStreamReady: ready })));
  await act(flush);
  return { ref, ready, root };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLVideoElement.prototype, 'readyState', 'get').mockReturnValue(2);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLVideoElement.prototype, 'play').mockResolvedValue();
});
afterEach(async () => {
  for (const root of roots) act(() => root.unmount());
  roots.clear();
  await flush();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('CameraView: controles y ciclo de adquisición', () => {
  it('un control opcional rechazado no bloquea AE/AWB y no impone ISO/EV iniciales', async () => {
    const c = camera({ reject: entry => 'frameRate' in entry });
    const h = await renderCamera(vi.fn().mockResolvedValue(c.stream));
    expect(h.ready).toHaveBeenCalledWith(c.stream);
    expect(c.calls).toContainEqual({ exposureMode: 'continuous' });
    expect(c.calls).toContainEqual({ whiteBalanceMode: 'continuous' });
    const mode = c.calls.findIndex(entry => entry.focusMode === 'manual');
    expect(c.calls[mode + 1]).toEqual({ focusDistance: 2.5 });
    expect(c.calls.some(entry => 'iso' in entry || 'exposureCompensation' in entry || 'exposureTime' in entry)).toBe(false);
    expect(h.ref.current?.getAcquisitionState()).toEqual({ revision: 1, settling: false });
  });

  it('fija los valores medidos antes del modo manual sin salto hacia un rojo objetivo', async () => {
    const c = camera();
    const h = await renderCamera(vi.fn().mockResolvedValue(c.stream));
    c.calls.length = 0;
    h.ref.current?.optimizeForFinger(100);
    expect(h.ref.current?.getAcquisitionState().settling).toBe(true);
    await flush();
    expect(c.calls).toEqual([
      { whiteBalanceMode: 'manual' }, { colorTemperature: 5100 },
      { exposureMode: 'manual' }, { iso: 120 }, { exposureTime: 15 },
    ]);
    expect(c.settings).toMatchObject({ iso: 120, exposureTime: 15, colorTemperature: 5100 });
    expect(h.ref.current?.getAcquisitionState()).toEqual({ revision: 2, settling: false });
    h.ref.current?.optimizeForFinger(220); await flush();
    expect(c.calls).toHaveLength(5);
    h.ref.current?.resumeFingerAcquisition(); await flush();
    expect(c.settings).toMatchObject({ exposureMode: 'continuous', whiteBalanceMode: 'continuous' });
    h.ref.current?.optimizeForFinger(220); await flush();
    expect(c.calls.filter(entry => entry.exposureMode === 'manual')).toHaveLength(2);
  });

  it('no envía valores manuales si el driver ignora el cambio de modo', async () => {
    const c = camera({ ignore: entry => entry.exposureMode === 'manual' || entry.whiteBalanceMode === 'manual' });
    const h = await renderCamera(vi.fn().mockResolvedValue(c.stream));
    c.calls.length = 0;
    h.ref.current?.optimizeForFinger(180); await flush();
    expect(c.calls).toEqual([{ whiteBalanceMode: 'manual' }, { exposureMode: 'manual' }]);
    expect(c.settings.exposureMode).toBe('continuous');
  });

  it('restaura continuo si el valor convergido no queda confirmado tras el modo manual', async () => {
    const c = camera({ ignore: entry => 'iso' in entry || 'colorTemperature' in entry });
    const h = await renderCamera(vi.fn().mockResolvedValue(c.stream));
    c.calls.length = 0;
    h.ref.current?.optimizeForFinger(180); await flush();
    expect(c.calls).toContainEqual({ exposureMode: 'continuous' });
    expect(c.calls).toContainEqual({ whiteBalanceMode: 'continuous' });
    expect(c.settings.exposureMode).toBe('continuous');
    expect(c.settings.whiteBalanceMode).toBe('continuous');
  });

  it('una plataforma sin controles manuales sigue funcionando sin requests ISP inventados', async () => {
    const c = camera({ unsupported: true, torchSyntax: 'stale' });
    const h = await renderCamera(vi.fn().mockResolvedValue(c.stream));
    expect(h.ready).toHaveBeenCalledOnce();
    c.calls.length = 0;
    const revision = h.ref.current?.getAcquisitionState().revision;
    h.ref.current?.optimizeForFinger(180); await flush();
    expect(c.calls).toEqual([]);
    expect(h.ref.current?.getAcquisitionState().revision).toBe(revision);
  });

  it('mantiene las cuatro sintaxis de torch, incluida la cuarta de drivers antiguos', async () => {
    const c = camera({ torchSyntax: 'fourth' });
    const h = await renderCamera(vi.fn().mockResolvedValue(c.stream));
    expect(h.ready).toHaveBeenCalledOnce();
    expect(c.calls.filter(entry => 'torch' in entry || 'torchMode' in entry)).toEqual([
      { torch: true }, { torch: true }, { torch: 'on' }, { torchMode: 'torch' },
    ]);
  });

  it('conserva el fallback sin settings de torch verificados', async () => {
    const c = camera({ torchSyntax: 'stale' });
    const h = await renderCamera(vi.fn().mockResolvedValue(c.stream));
    expect(h.ready).toHaveBeenCalledOnce();
    expect(c.calls.filter(entry => 'torch' in entry || 'torchMode' in entry)).toHaveLength(5);
  });

  it('el stream con constraints relajados recibe la misma inicialización de torch', async () => {
    const c = camera();
    const media = vi.fn()
      .mockRejectedValueOnce(new DOMException('Unsupported resolution', 'OverconstrainedError'))
      .mockResolvedValueOnce(c.stream);
    const h = await renderCamera(media);
    expect(media).toHaveBeenCalledTimes(2);
    expect(c.settings.torch).toBe(true);
    expect(c.settings.exposureMode).toBe('continuous');
    expect(h.ready).toHaveBeenCalledWith(c.stream);
  });

  it('detiene un fallback que llega después de cancelar sin publicar stream ready', async () => {
    const c = camera();
    let release!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>(resolve => { release = resolve; });
    const media = vi.fn()
      .mockRejectedValueOnce(new DOMException('Unsupported resolution', 'OverconstrainedError'))
      .mockReturnValueOnce(pending);
    const h = await renderCamera(media);
    act(() => h.root.unmount()); roots.delete(h.root);
    release(c.stream); await flush();
    expect(c.track.stop).toHaveBeenCalledOnce();
    expect(h.ready).not.toHaveBeenCalled();
    expect(c.track.applyConstraints).not.toHaveBeenCalled();
  });

  it('una apertura atrasada no reemplaza ni detiene el stream de la siguiente sesión', async () => {
    const old = camera();
    const current = camera();
    let release!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>(resolve => { release = resolve; });
    const media = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(current.stream);
    const h = await renderCamera(media);
    act(() => h.root.render(createElement(CameraView, { ref: h.ref, isMonitoring: false, onStreamReady: h.ready })));
    act(() => h.root.render(createElement(CameraView, { ref: h.ref, isMonitoring: true, onStreamReady: h.ready })));
    await act(flush);
    expect(h.ready).toHaveBeenCalledExactlyOnceWith(current.stream);
    release(old.stream); await flush();
    expect(old.track.stop).toHaveBeenCalledOnce();
    expect(current.track.stop).not.toHaveBeenCalled();
    expect(h.ref.current?.getVideoElement()?.srcObject).toBe(current.stream);
    expect(h.ready).toHaveBeenCalledOnce();
  });
});
