import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useMonitorViewport } from '../useMonitorViewport';
import { CircularBuffer } from '@/utils/CircularBuffer';
import type { PpgLayout } from '@/lib/ui/ppgCanvasRenderer';

it('la inspección conserva muestras, amplitud y evidencia visual mientras el flujo vivo cambia', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const buffer = { current: new CircularBuffer(600) };
  for (let i = 0; i < 400; i++) buffer.current.push({ time: 10000 + i * 33, value: i, isArrhythmia: false });
  const stats = { current: { min: 0, max: 400, range: 400 } };
  const visibility = { current: { strength: 0.8, traceRevealed: true } };
  const layout = { current: { plot: { x: 12, y: 200, w: 360, h: 400 } } as PpgLayout };
  let viewport!: ReturnType<typeof useMonitorViewport>;
  function Harness() { viewport = useMonitorViewport(buffer, stats, layout, visibility); return null; }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Harness)));
  try {
    act(() => viewport.inspect());
    const frozen = viewport.view.current.inspection!;
    const lastTime = frozen.endMs;
    buffer.current.push({ time: 24000, value: -999, isArrhythmia: true });
    buffer.current.getPoints()[0].value = -888;
    stats.current.max = 1000;
    visibility.current = { strength: 0, traceRevealed: false };
    expect(frozen.buffer.getPointsCount()).toBe(400);
    expect(frozen.buffer.getPoints()[0].value).toBe(0);
    expect(frozen.endMs).toBe(lastTime);
    expect(frozen.stats.max).toBe(400);
    expect(frozen.strength).toBe(0.8);
    expect(frozen.traceRevealed).toBe(true);
    act(() => viewport.pan(-100000));
    expect(frozen.endMs).toBe(14000);
    act(() => viewport.changeWindow(2000));
    expect(viewport.view.current.windowMs).toBe(2000);
    act(() => viewport.returnLive());
    expect(viewport.view.current.inspection).toBeUndefined();
    expect(buffer.current.getPointsCount()).toBe(401);
    const surface = {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      setPointerCapture: vi.fn(), hasPointerCapture: () => false,
    };
    const outside = { currentTarget: surface, pointerId: 7, clientX: 500, clientY: 300 } as unknown as Parameters<typeof viewport.canvasHandlers.onPointerDown>[0];
    act(() => viewport.canvasHandlers.onPointerDown(outside));
    act(() => viewport.canvasHandlers.onPointerUp(outside));
    expect(surface.setPointerCapture).not.toHaveBeenCalled();
    expect(viewport.view.current.inspection).toBeUndefined();
  } finally { act(() => root.unmount()); vi.unstubAllGlobals(); }
});
