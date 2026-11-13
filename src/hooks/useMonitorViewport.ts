import { useCallback, useRef, useState } from 'react';
import type { MutableRefObject, PointerEvent, KeyboardEvent } from 'react';
import { CircularBuffer } from '@/utils/CircularBuffer';
import type { AmplitudeStats, PpgLayout, PpgRenderState } from '@/lib/ui/ppgCanvasRenderer';
import { clampInspectionEnd, clampWindowMs, MONITOR_VIEW } from '@/lib/ui/monitorViewport';

type Inspection = NonNullable<PpgRenderState['inspection']>;

/** Gestos sobre una copia visual. Captura y estimadores siguen recibiendo datos. */
export function useMonitorViewport(buffer: MutableRefObject<CircularBuffer | null>, stats: MutableRefObject<AmplitudeStats>, layout: MutableRefObject<PpgLayout>, visibility: MutableRefObject<{ strength: number; traceRevealed: boolean }>) {
  const [windowMs, setWindowMs] = useState<number>(MONITOR_VIEW.defaultWindowMs);
  const [inspecting, setInspecting] = useState(false);
  const [annotations, setAnnotations] = useState(true);
  const [focus, setFocus] = useState(false);
  const view = useRef({ windowMs: MONITOR_VIEW.defaultWindowMs as number, inspection: undefined as Inspection | undefined, focus: false, annotations: true });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ x: 0, endMs: 0, distance: 0, windowMs: 4000, moved: false });

  const changeWindow = useCallback((ms: number) => {
    const next = clampWindowMs(ms);
    view.current.windowMs = next;
    const i = view.current.inspection;
    if (i) {
      const points = i.buffer.getPoints();
      if (points.length) i.endMs = clampInspectionEnd(i.endMs, points[0].time, points[points.length - 1].time, next);
    }
    setWindowMs(next);
  }, []);
  const returnLive = useCallback(() => { view.current.inspection = undefined; setInspecting(false); }, []);
  const inspect = useCallback(() => {
    const points = buffer.current?.getPoints() ?? [];
    if (!points.length) return;
    const copy = new CircularBuffer(points.length);
    for (const point of points) copy.push({ ...point });
    view.current.inspection = { buffer: copy, endMs: points[points.length - 1].time, stats: { ...stats.current }, strength: visibility.current.strength, traceRevealed: visibility.current.traceRevealed, cursorFraction: 0.5 };
    setInspecting(true);
  }, [buffer, stats, visibility]);
  const pan = useCallback((deltaMs: number) => {
    const i = view.current.inspection;
    if (!i) return;
    const points = i.buffer.getPoints();
    i.endMs = clampInspectionEnd(i.endMs + deltaMs, points[0].time, points[points.length - 1].time, view.current.windowMs);
  }, []);
  const toggleAnnotations = useCallback(() => { view.current.annotations = !view.current.annotations; setAnnotations(view.current.annotations); }, []);
  const toggleFocus = useCallback(() => {
    view.current.focus = !view.current.focus;
    setFocus(view.current.focus);
  }, []);
  const pointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const plot = layout.current.plot;
    if (y < plot.y || y > plot.y + plot.h) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      gesture.current = { x: e.clientX, endMs: view.current.inspection?.endMs ?? 0, distance: 0, windowMs: view.current.windowMs, moved: false };
      const i = view.current.inspection;
      if (i) i.cursorFraction = Math.max(0, Math.min(1, (e.clientX - rect.left - plot.x) / plot.w));
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current.distance = Math.hypot(a.x - b.x, a.y - b.y);
      gesture.current.windowMs = view.current.windowMs;
      gesture.current.moved = true;
    }
  };
  const pointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (g.distance > 8 && distance > 8) changeWindow(g.windowMs * g.distance / distance);
    } else if (pointers.current.size === 1 && g.distance === 0 && view.current.inspection) {
      const dx = e.clientX - g.x;
      if (Math.abs(dx) > 6) g.moved = true;
      const i = view.current.inspection;
      const target = g.endMs - dx / layout.current.plot.w * view.current.windowMs;
      pan(target - i.endMs);
    }
  };
  const pointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    if (pointers.current.size === 1 && !gesture.current.moved && !view.current.inspection) inspect();
    pointers.current.delete(e.pointerId);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const cancelPointer = (e: PointerEvent<HTMLCanvasElement>) => { pointers.current.delete(e.pointerId); gesture.current.moved = true; };
  const keyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    if (e.key === '+' || e.key === '=') { e.preventDefault(); changeWindow(view.current.windowMs / 1.5); }
    if (e.key === '-') { e.preventDefault(); changeWindow(view.current.windowMs * 1.5); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); pan(-view.current.windowMs / 4); }
    if (e.key === 'ArrowRight') { e.preventDefault(); pan(view.current.windowMs / 4); }
    if (e.key === 'Escape') returnLive();
    if (e.key === 'Enter') { e.preventDefault(); if (view.current.inspection) returnLive(); else inspect(); }
  };
  return { windowMs, inspecting, focus, annotations, toggleAnnotations, view, changeWindow, inspect, returnLive, pan, toggleFocus,
    canvasHandlers: { onPointerDown: pointerDown, onPointerMove: pointerMove, onPointerUp: pointerUp, onPointerCancel: cancelPointer, onLostPointerCapture: cancelPointer, onKeyDown: keyDown } };
}
