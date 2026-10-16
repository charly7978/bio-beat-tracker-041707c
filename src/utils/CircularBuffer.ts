interface PPGDataPoint {
  time: number;
  value: number;
  isArrhythmia: boolean;
}

/**
 * Ring buffer real O(1) por push.
 * No usa shift(), evita GC churn y latencia en hot path.
 * Internamente mantiene un buffer pre-asignado con cabeza y cola.
 */
export class CircularBuffer {
  private buffer: (PPGDataPoint | null)[];
  private readonly capacity: number;
  private head = 0;
  private size = 0;

  constructor(size: number) {
    this.capacity = size;
    this.buffer = new Array<PPGDataPoint | null>(size).fill(null);
  }

  push(point: PPGDataPoint): void {
    const idx = (this.head + this.size) % this.capacity;
    if (this.size === this.capacity) {
      this.buffer[this.head] = point;
      this.head = (this.head + 1) % this.capacity;
    } else {
      this.buffer[idx] = point;
      this.size++;
    }
  }

  getPointsCount(): number {
    return this.size;
  }

  /**
   * Obtiene los valores mínimo y máximo de los últimos `count` puntos
   * directamente desde el ring buffer, con O(count) y CERO asignaciones de memoria.
   */
  getRecentExtrema(count: number): { min: number; max: number } {
    if (this.size === 0) return { min: -50, max: 50 };
    const n = Math.min(this.size, count);
    const startOffset = this.size - n;
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < n; i++) {
      const idx = (this.head + startOffset + i) % this.capacity;
      const pt = this.buffer[idx];
      if (pt) {
        if (pt.value < mn) mn = pt.value;
        if (pt.value > mx) mx = pt.value;
      }
    }
    if (!Number.isFinite(mn) || !Number.isFinite(mx)) return { min: -50, max: 50 };
    return { min: mn, max: mx };
  }

  /**
   * Itera sobre los puntos dentro de una ventana de tiempo en orden cronológico
   * de forma directa sobre el ring buffer, con complejidad O(k) donde k es la cantidad
   * de puntos visibles y CERO asignación de arrays u objetos temporales.
   */
  forEachChronologicalInWindow(
    now: number,
    windowMs: number,
    cb: (pt: PPGDataPoint, age: number) => void
  ): void {
    if (this.size === 0) return;
    let countInWindow = 0;
    for (let i = this.size - 1; i >= 0; i--) {
      const idx = (this.head + i) % this.capacity;
      const pt = this.buffer[idx];
      if (!pt) break;
      const age = now - pt.time;
      if (age > windowMs) break;
      countInWindow++;
    }
    if (countInWindow === 0) return;
    const startIdx = this.size - countInWindow;
    for (let i = 0; i < countInWindow; i++) {
      const idx = (this.head + startIdx + i) % this.capacity;
      const pt = this.buffer[idx];
      if (pt) {
        cb(pt, now - pt.time);
      }
    }
  }

  /**
   * Marca retroactivamente como arritmia todos los puntos
   * desde hace `durationMs` milisegundos hasta el presente.
   * Itera al revés desde la cola sin crear copia.
   */
  markArrhythmiaBack(durationMs: number): void {
    if (this.size === 0) return;
    const cutoff = Date.now() - durationMs;
    for (let i = this.size - 1; i >= 0; i--) {
      const idx = (this.head + i) % this.capacity;
      const pt = this.buffer[idx];
      if (!pt || pt.time < cutoff) break;
      pt.isArrhythmia = true;
    }
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
    this.buffer.fill(null);
  }
}

export type { PPGDataPoint };
