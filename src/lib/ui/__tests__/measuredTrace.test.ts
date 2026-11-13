import { describe, expect, it } from 'vitest';
import { traceMeasuredPath } from '../measuredTrace';
import { clampInspectionEnd, clampWindowMs } from '../monitorViewport';

describe('interpolación visual entre muestras observadas', () => {
  it('atraviesa cada muestra sin crear amplitud fuera de sus extremos, incluso con intervalos desiguales', () => {
    const points = [{ x: 0, y: 0 }, { x: 3, y: 8 }, { x: 11, y: 1 }, { x: 13, y: 1 }, { x: 24, y: -5 }, { x: 28, y: 12 }];
    const curves: number[][] = [];
    const ctx = { bezierCurveTo: (...values: number[]) => curves.push(values) } as unknown as CanvasRenderingContext2D;
    traceMeasuredPath(ctx, points);
    expect(curves).toHaveLength(points.length - 1);
    curves.forEach(([x1, y1, x2, y2, x3, y3], i) => {
      const a = points[i]; const b = points[i + 1];
      expect([x3, y3]).toEqual([b.x, b.y]);
      expect(x1).toBeGreaterThanOrEqual(a.x); expect(x2).toBeLessThanOrEqual(b.x);
      for (let n = 0; n <= 100; n++) {
        const t = n / 100;
        const y = (1 - t) ** 3 * a.y + 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3 * y3;
        expect(y).toBeGreaterThanOrEqual(Math.min(a.y, b.y) - 1e-9);
        expect(y).toBeLessThanOrEqual(Math.max(a.y, b.y) + 1e-9);
      }
    });
  });
  it('la cara de retorno recorre la misma curva en sentido inverso', () => {
    const points = [{ x: 0, y: 0 }, { x: 4, y: 9 }, { x: 10, y: 2 }];
    const forward: number[][] = []; const reverse: number[][] = [];
    traceMeasuredPath({ bezierCurveTo: (...p: number[]) => forward.push(p) } as unknown as CanvasRenderingContext2D, points);
    traceMeasuredPath({ bezierCurveTo: (...p: number[]) => reverse.push(p) } as unknown as CanvasRenderingContext2D, points, 0, 2, true);
    expect(reverse).toHaveLength(2);
    forward.forEach((f, i) => {
      const r = reverse[reverse.length - i - 1];
      expect(r.slice(0, 2)).toEqual(f.slice(2, 4));
      expect(r.slice(2, 4)).toEqual(f.slice(0, 2));
      expect(r.slice(4, 6)).toEqual([points[i].x, points[i].y]);
    });
  });

});

describe('límites de exploración visual', () => {
  it('no permite ampliar fuera de la ventana admitida ni explorar tiempo sin observaciones', () => {
    expect(clampWindowMs(NaN)).toBe(4000);
    expect(clampWindowMs(10)).toBe(1000);
    expect(clampWindowMs(100000)).toBe(8000);
    expect(clampInspectionEnd(0, 10000, 20000, 4000)).toBe(14000);
    expect(clampInspectionEnd(99999, 10000, 20000, 4000)).toBe(20000);
    expect(clampInspectionEnd(0, 10000, 11000, 4000)).toBe(11000);
  });
});
