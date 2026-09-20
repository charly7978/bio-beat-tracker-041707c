import { describe, expect, it } from 'vitest';
import { median, robustBounds, robustDynamicRange, skewness, stdDev, kurtosis, shannonEntropy, hjorthMetrics } from '../stats';

describe('stats', () => {
  it('median de ventana impar/par', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('robustDynamicRange positivo', () => {
    expect(robustDynamicRange([1, 2, 3, 4, 5])).toBeGreaterThan(0);
    const b = robustBounds([10, 20, 30]);
    expect(b.range).toBeGreaterThan(0);
  });

  describe('stdDev', () => {
    it('calcula desviación estándar con arrays normales y tipados', () => {
      expect(stdDev([])).toBe(0);
      expect(stdDev([42])).toBe(0);
      const vals = [2, 4, 4, 4, 5, 5, 7, 9];
      const sd = stdDev(vals);
      expect(sd).toBeCloseTo(2.0, 2);

      const f64 = new Float64Array([2, 4, 4, 4, 5, 5, 7, 9]);
      expect(stdDev(f64)).toBeCloseTo(2.0, 2);
    });
  });

  describe('skewness (SQI Elgendi 2016)', () => {
    it('señal simétrica → ~0', () => {
      expect(Math.abs(skewness([-2, -1, 0, 1, 2]))).toBeLessThan(1e-6);
    });
    it('cola a la derecha (PPG limpio) → positiva', () => {
      // muchos valores bajos + pocos picos altos = subida sistólica abrupta
      expect(skewness([0, 0, 0, 0, 0, 0, 0, 1, 3, 8])).toBeGreaterThan(0);
    });
    it('cola a la izquierda → negativa', () => {
      // masa alta + cola baja (el 0 arrastra una cola a la izquierda)
      expect(skewness([10, 10, 10, 10, 10, 10, 10, 9, 7, 0])).toBeLessThan(0);
    });
    it('soporta Float64Array', () => {
      const f64 = new Float64Array([0, 0, 0, 0, 0, 0, 0, 1, 3, 8]);
      expect(skewness(f64)).toBeGreaterThan(0);
    });
    it('señal plana o corta → 0 (sin información)', () => {
      expect(skewness([5, 5, 5, 5])).toBe(0);
      expect(skewness([1, 2])).toBe(0);
    });
  });

  describe('kurtosis (Fisher-Pearson excess)', () => {
    it('seal normal → ~0', () => {
      // Normal distribution approximation
      const normal = [1, -1, 0, 1, -1, 0, 1, -1, 0, 0];
      expect(Math.abs(kurtosis(normal))).toBeLessThan(2);
    });
    it('heavy tails (artifacts) → positive', () => {
      // Most values near 0 with few extreme outliers = heavy tails
      const artifact = [0, 0, 0, 0, 0, 0, 0, 0, 50, -50];
      expect(kurtosis(artifact)).toBeGreaterThan(1);
    expect(kurtosis(artifact)).toBeCloseTo(2, 1);
    });
    it('n < 3 → 0', () => {
      expect(kurtosis([1])).toBe(0);
      expect(kurtosis([1, 2])).toBe(0);
    });
    it('flat signal → 0', () => {
      expect(kurtosis([5, 5, 5, 5])).toBe(0);
    });
    it('soporta Float64Array', () => {
      const f64 = new Float64Array([0, 0, 0, 0, 0, 0, 0, 50, -50]);
      expect(kurtosis(f64)).toBeGreaterThan(0);
    });
  });

  describe('shannonEntropy', () => {
    it('seal plana → 0', () => {
      expect(shannonEntropy([5, 5, 5, 5])).toBe(0);
    });
    it('n < 2 → 0', () => {
      expect(shannonEntropy([])).toBe(0);
      expect(shannonEntropy([1])).toBe(0);
    });
    it('alta entropía = ruido', () => {
      // Random uniform signal has high entropy
      const random = Array.from({ length: 100 }, () => Math.floor(Math.random() * 64));
      const h = shannonEntropy(random);
      expect(h).toBeGreaterThan(3); // log2(64) = 6, random ~ 6 nats
    });
    it('baja entropía = periódica', () => {
      // Repeated pattern = low entropy
      const periodic = Array.from({ length: 64 }, (_, i) => i % 4);
      const hPeriodic = shannonEntropy(periodic);
      const random = Array.from({ length: 64 }, () => Math.floor(Math.random() * 64));
      const hRandom = shannonEntropy(random);
      expect(hPeriodic).toBeLessThan(hRandom);
    });
    it('soporta Float64Array', () => {
      const f64 = new Float64Array([0, 0, 0, 0, 0, 0, 0, 1, 3, 8]);
      expect(shannonEntropy(f64)).toBeGreaterThan(0);
    });
  });

  describe('hjorthMetrics', () => {
    it('n < 2 → defaults', () => {
      const r = hjorthMetrics([5]);
      expect(r.activity).toBe(0);
      expect(r.mobility).toBe(0);
      expect(r.complexity).toBe(1);
    });
    it('actividad = varianza', () => {
      const vals = [0, 2, 4, 2, 0, -2, -4, -2];
      const m = hjorthMetrics(vals);
      // Varianza de estos valores
      const mean = 0;
      let variance = 0;
      for (const v of vals) variance += (v - mean) * (v - mean);
      variance /= vals.length;
      expect(m.activity).toBeCloseTo(variance, 2);
    });
    it('seal periódica → movilidad < 1', () => {
      // PPG-like signal: slow + fast oscillation
      const ppg = Array.from({ length: 60 }, (_, i) =>
        Math.sin(i * 0.3) + Math.sin(i * 1.2) * 0.3
      );
      const m = hjorthMetrics(ppg);
      expect(m.mobility).toBeGreaterThan(0);
      expect(m.mobility).toBeLessThan(5); // reasonable range
    });
  });
});
