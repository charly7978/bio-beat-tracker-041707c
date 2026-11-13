import { describe, expect, it, vi } from 'vitest';
import { PPGSignalProcessor } from '../PPGSignalProcessor';
import type { MotionObservation } from '../../../types/measurements';

const PAGE_ORIGIN_MS = 1_750_000_000_000;
const START_MS = 10_000;

function observation(timestampMs: number, overrides: Partial<MotionObservation> = {}): MotionObservation {
  const seconds = (timestampMs - START_MS) / 1000;
  return {
    timestampMs,
    timeOriginMs: PAGE_ORIGIN_MS,
    clockDomain: 'page-performance',
    accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 + 0.06 * Math.sin(2 * Math.PI * 0.3 * seconds) },
    rotationRate: { alpha: 0, beta: 0, gamma: 0 },
    ...overrides,
  };
}

function feed(processor: PPGSignalProcessor, rateHz: number, seconds = 25): number {
  const count = Math.round(rateHz * seconds);
  for (let i = 0; i <= count; i++) {
    processor.ingestMotionSample(observation(START_MS + i * 1000 / rateHz));
  }
  return START_MS + seconds * 1000;
}

describe('adquisición temporal IMU', () => {
  it.each([15, 30, 60])('conserva 18 rpm con eventos a %s Hz sin asumir 20 Hz', (rateHz) => {
    const processor = new PPGSignalProcessor(() => {});
    const endMs = feed(processor, rateHz);
    const result = processor.getAccelRespirationEstimate(endMs);
    expect(result).not.toBeNull();
    expect(result!.rpm).toBeCloseTo(18, 0);
    expect(result!.quality).toBeGreaterThan(0.8);
  });

  it('conserva la frecuencia aunque cambie la hora de recepción del Worker', () => {
    const first = new PPGSignalProcessor(() => {});
    const second = new PPGSignalProcessor(() => {});
    const now = vi.spyOn(performance, 'now');
    try {
      now.mockReturnValue(100_000);
      const endMs = feed(first, 30);
      now.mockReturnValue(900_000);
      feed(second, 30);
      expect(second.getAccelRespirationEstimate(endMs)).toEqual(first.getAccelRespirationEstimate(endMs));
      expect(first.getAccelRespirationEstimate(endMs)!.rpm).toBeCloseTo(18, 0);
    } finally {
      now.mockRestore();
    }
  });

  it('caduca el resultado cuando dejan de llegar observaciones', () => {
    const processor = new PPGSignalProcessor(() => {});
    const endMs = feed(processor, 30);
    expect(processor.getAccelRespirationEstimate(endMs)).not.toBeNull();
    expect(processor.getAccelRespirationEstimate(endMs + 1001)).toBeNull();
    processor.ingestMotionSample(observation(endMs + 1034));
    expect(processor.getAccelRespirationEstimate(endMs + 1034)).toBeNull();
  });

  it('un frame que retrocede en el reloj no recibe una estimación de su futuro', () => {
    const processor = new PPGSignalProcessor(() => {});
    const endMs = feed(processor, 30);
    expect(processor.getAccelRespirationEstimate(endMs)).not.toBeNull();
    // Dentro del período de caché y del margen de frescura: antes devolvía el resultado futuro.
    expect(processor.getAccelRespirationEstimate(endMs - 100)).toBeNull();
    expect(processor.getAccelRespirationEstimate(endMs)).toBeNull();
  });

  it('un hueco de adquisición reinicia la ventana en vez de concatenar sesiones', () => {
    const processor = new PPGSignalProcessor(() => {});
    const endMs = feed(processor, 30);
    expect(processor.getAccelRespirationEstimate(endMs)).not.toBeNull();
    processor.ingestMotionSample(observation(endMs + 600));
    expect(processor.getAccelRespirationEstimate(endMs + 600)).toBeNull();
  });

  it('un cambio de origen del reloj exige una nueva ventana', () => {
    const processor = new PPGSignalProcessor(() => {});
    const endMs = feed(processor, 30);
    expect(processor.getAccelRespirationEstimate(endMs)).not.toBeNull();
    processor.ingestMotionSample(observation(endMs + 34, { timeOriginMs: PAGE_ORIGIN_MS + 1000 }));
    expect(processor.getAccelRespirationEstimate(endMs + 34)).toBeNull();
  });

  it('una brecha corta pero excesiva para la cadencia reinicia la adquisición', () => {
    const processor = new PPGSignalProcessor(() => {});
    const endMs = feed(processor, 30);
    expect(processor.getAccelRespirationEstimate(endMs)).not.toBeNull();
    processor.ingestMotionSample(observation(endMs + 160));
    expect(processor.getAccelRespirationEstimate(endMs + 160)).toBeNull();
  });

  it('un retroceso temporal no mezcla las dos épocas', () => {
    const processor = new PPGSignalProcessor(() => {});
    const endMs = feed(processor, 30);
    expect(processor.getAccelRespirationEstimate(endMs)).not.toBeNull();
    processor.ingestMotionSample(observation(START_MS));
    expect(processor.getAccelRespirationEstimate(START_MS)).toBeNull();
  });

  it('normaliza timestamps Unix al mismo reloj relativo de los frames', () => {
    const relative = new PPGSignalProcessor(() => {});
    const epoch = new PPGSignalProcessor(() => {});
    const endMs = feed(relative, 30);
    for (let i = 0; i <= 750; i++) {
      const sample = observation(START_MS + i * 1000 / 30);
      epoch.ingestMotionSample({ ...sample, timestampMs: sample.timestampMs + PAGE_ORIGIN_MS });
    }
    expect(epoch.getAccelRespirationEstimate(endMs)!.rpm).toBeCloseTo(relative.getAccelRespirationEstimate(endMs)!.rpm, 0);
  });

  it('duplicados no crean duración ni una ventana respiratoria de ocho segundos', () => {
    const processor = new PPGSignalProcessor(() => {});
    const endMs = feed(processor, 30, 5);
    for (let i = 0; i < 1000; i++) processor.ingestMotionSample(observation(endMs));
    expect(processor.getAccelRespirationEstimate(endMs)).toBeNull();
  });

  it('rechaza datos no finitos y no conserva una lectura anterior', () => {
    const processor = new PPGSignalProcessor(() => {});
    const endMs = feed(processor, 30);
    expect(processor.getAccelRespirationEstimate(endMs)).not.toBeNull();
    processor.ingestMotionSample(observation(endMs + 34, { accelerationIncludingGravity: { x: 0, y: NaN, z: 9.81 } }));
    expect(processor.getAccelRespirationEstimate(endMs + 34)).toBeNull();
  });

  it('el reposo sin oscilación no produce una frecuencia respiratoria', () => {
    const processor = new PPGSignalProcessor(() => {});
    for (let i = 0; i <= 750; i++) {
      processor.ingestMotionSample(observation(START_MS + i * 1000 / 30, {
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 },
      }));
    }
    expect(processor.getAccelRespirationEstimate(START_MS + 25_000)).toBeNull();
  });
});
