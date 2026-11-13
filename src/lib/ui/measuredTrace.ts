interface Point { x: number; y: number }

function tangent(points: readonly Point[], index: number, from: number, to: number): number {
  const left = points[Math.max(from, index - 1)];
  const mid = points[index];
  const right = points[Math.min(to, index + 1)];
  const h0 = mid.x - left.x;
  const h1 = right.x - mid.x;
  const d0 = h0 > 0 ? (mid.y - left.y) / h0 : 0;
  const d1 = h1 > 0 ? (right.y - mid.y) / h1 : 0;
  if (index === from) return d1;
  if (index === to) return d0;
  if (d0 * d1 <= 0) return 0;
  const w0 = 2 * h1 + h0;
  const w1 = h1 + 2 * h0;
  return (w0 + w1) / (w0 / d0 + w1 / d1);
}

/** Curva cúbica monótona entre muestras: atraviesa los puntos sin crear extremos. */
export function traceMeasuredPath(ctx: CanvasRenderingContext2D, points: readonly Point[], from = 0, to = points.length - 1, reverse = false): void {
  if (from >= to) return;
  const direction = reverse ? -1 : 1;
  for (let i = reverse ? to : from; reverse ? i > from : i < to; i += direction) {
    const next = i + direction;
    const a = points[i];
    const b = points[next];
    const h = b.x - a.x;
    if (h === 0 || typeof ctx.bezierCurveTo !== 'function') { ctx.lineTo(b.x, b.y); continue; }
    const m0 = tangent(points, i, from, to);
    const m1 = tangent(points, next, from, to);
    // Control points permanecen dentro de la amplitud observada del segmento.
    const bound = (y: number) => Math.max(Math.min(a.y, b.y), Math.min(Math.max(a.y, b.y), y));
    ctx.bezierCurveTo(a.x + h / 3, bound(a.y + m0 * h / 3), b.x - h / 3, bound(b.y - m1 * h / 3), b.x, b.y);
  }
}
