import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFrameLoop } from '../useFrameLoop';
import type { CameraViewHandle } from '@/components/CameraView';

function setup(captureState?: { revision: number; settling: boolean }) {
  let handle = 0;
  const callbacks = new Map<number, VideoFrameRequestCallback>();
  const video = {
    readyState: 2, videoWidth: 48, currentTime: 0,
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 0 }),
    requestVideoFrameCallback: (cb: VideoFrameRequestCallback) => { callbacks.set(++handle, cb); return handle; },
    cancelVideoFrameCallback: vi.fn(),
  };
  const pixels = { data: new Uint8ClampedArray(48 * 48 * 4), width: 48, height: 48 } as ImageData;
  const ctx = { drawImage: vi.fn(), getImageData: () => pixels };
  const processFrame = vi.fn();
  const cameraRef = { current: { getVideoElement: () => video, getAcquisitionState: () => captureState } as unknown as CameraViewHandle };
  const canvasRef = { current: { width: 48, height: 48 } as HTMLCanvasElement };
  const ctxRef = { current: ctx as unknown as CanvasRenderingContext2D };
  let loop!: ReturnType<typeof useFrameLoop>;
  function Harness() { loop = useFrameLoop({ cameraRef, canvasRef, ctxRef, processFrame }); return null; }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Harness)));
  const fire = (id: number, frame: number, time: number) => callbacks.get(id)!(time, {
    presentedFrames: frame, mediaTime: 0, presentationTime: time,
  } as VideoFrameCallbackMetadata);
  return { loop, processFrame, ctx, callbacks, fire, root };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('useFrameLoop: cuadros del sensor y ciclos de captura', () => {
  it('conserva muestras nuevas con píxeles idénticos y omite sólo la misma identidad', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const h = setup();
    try {
      h.loop.startFrameLoop();
      h.processFrame.mockClear();
      for (let i = 1; i <= 90; i++) h.fire(i, i, 10_000 + i * 33);
      expect(h.processFrame).toHaveBeenCalledTimes(90);
      h.fire(91, 90, 13_003);
      expect(h.processFrame).toHaveBeenCalledTimes(90);
      h.fire(92, 91, 13_036);
      expect(h.processFrame).toHaveBeenLastCalledWith(expect.objectContaining({ width: 48 }), 13_036);
      expect(h.processFrame).toHaveBeenCalledTimes(91);
    } finally { h.loop.stopFrameLoop(); act(() => h.root.unmount()); }
  });

  it('asocia la revisión ISP al cuadro y conserva su snapshot', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const state = { revision: 2, settling: true };
    const h = setup(state);
    try {
      h.loop.startFrameLoop(); h.processFrame.mockClear();
      h.fire(1, 1, 5000);
      state.revision = 3; state.settling = false;
      expect(h.processFrame.mock.calls[0][2]).toEqual({ revision: 2, settling: true });
      h.fire(2, 2, 5033);
      expect(h.processFrame.mock.calls[1][2]).toEqual({ revision: 3, settling: false });
    } finally { h.loop.stopFrameLoop(); act(() => h.root.unmount()); }
  });

  it('un callback antiguo no procesa ni crea otro bucle después de reiniciar', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const h = setup();
    try {
      h.loop.startFrameLoop();
      const stale = h.callbacks.get(1)!;
      h.loop.stopFrameLoop();
      h.loop.startFrameLoop();
      h.processFrame.mockClear();
      const before = h.callbacks.size;
      stale(5000, { presentedFrames: 1, presentationTime: 5000 } as VideoFrameCallbackMetadata);
      expect(h.processFrame).not.toHaveBeenCalled();
      expect(h.callbacks.size).toBe(before);
      h.fire(2, 1, 5033);
      expect(h.processFrame).toHaveBeenCalledTimes(1);
    } finally { h.loop.stopFrameLoop(); act(() => h.root.unmount()); }
  });
});
