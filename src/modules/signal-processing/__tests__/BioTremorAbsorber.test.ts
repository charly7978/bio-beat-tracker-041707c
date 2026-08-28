import { describe, expect, it } from 'vitest';
import { BioTremorAbsorber } from '../BioTremorAbsorber';

describe('BioTremorAbsorber', () => {
  it('inicializa correctamente y procesa frames limpios', () => {
    const absorber = new BioTremorAbsorber({ gridRows: 4, gridCols: 4, temporalMemoryDepth: 16 });
    const dummyTiles = Array.from({ length: 16 }, () => ({ r: 180, g: 60, b: 40, count: 100 }));

    const out = absorber.processFrame(dummyTiles, { r: 180, g: 60, b: 40 });

    expect(out.red).toBeGreaterThan(150);
    expect(out.green).toBeGreaterThan(40);
    expect(out.blue).toBeGreaterThan(20);
    expect(out.pressureStability).toBeGreaterThanOrEqual(0.7);
    expect(Number.isFinite(out.syntheticPpg)).toBe(true);
  });

  it('absorbe micro-desplazamientos espaciales (sub-pixel tremor)', () => {
    const absorber = new BioTremorAbsorber({ gridRows: 4, gridCols: 4, temporalMemoryDepth: 16 });

    // Frame 1-5: Centroide centrado
    for (let f = 0; f < 5; f++) {
      const tiles = Array.from({ length: 16 }, (_, i) => ({
        r: i === 5 || i === 6 || i === 9 || i === 10 ? 220 : 160,
        g: 60,
        b: 40,
        count: 100,
      }));
      absorber.processFrame(tiles, { r: 180, g: 60, b: 40 });
    }

    // Frame 6: Micro-temblor hacia un lado (shift de 1 tile)
    const shiftedTiles = Array.from({ length: 16 }, (_, i) => ({
      r: i === 6 || i === 7 || i === 10 || i === 11 ? 220 : 160,
      g: 60,
      b: 40,
      count: 100,
    }));
    const outTremor = absorber.processFrame(shiftedTiles, { r: 180, g: 60, b: 40 });

    // El absorber detecta el temblor pero mantiene la señal roja y verde estables sin caer a 0
    expect(outTremor.red).toBeGreaterThan(150);
    expect(outTremor.green).toBeGreaterThan(40);
    expect(outTremor.tremorScore).toBeGreaterThanOrEqual(0);
    expect(outTremor.absorbedDisplacement).toBeDefined();
  });

  it('desacopla saltos hidrodinámicos de presión en modo común (orthogonal projection)', () => {
    const absorber = new BioTremorAbsorber({ gridRows: 4, gridCols: 4, temporalMemoryDepth: 16 });

    // Baseline frames
    for (let f = 0; f < 10; f++) {
      const tiles = Array.from({ length: 16 }, () => ({ r: 180, g: 60, b: 40, count: 100 }));
      absorber.processFrame(tiles, { r: 180, g: 60, b: 40 });
    }

    // Salto brusco de presión mecánica (DC jump simultáneo en R, G, B de +30)
    const pressurizedTiles = Array.from({ length: 16 }, () => ({ r: 210, g: 90, b: 70, count: 100 }));
    const outPressure = absorber.processFrame(pressurizedTiles, { r: 210, g: 90, b: 70 });

    // La señal PPG sintética no debe explotar a NaN ni a infinito
    expect(Number.isFinite(outPressure.syntheticPpg)).toBe(true);
    expect(Math.abs(outPressure.syntheticPpg)).toBeLessThan(150);
    expect(outPressure.red).toBeGreaterThan(170);
  });

  it('reset limpia toda la memoria espaciotemporal y reinicia anclas', () => {
    const absorber = new BioTremorAbsorber();
    const dummyTiles = Array.from({ length: 16 }, () => ({ r: 200, g: 50, b: 30, count: 50 }));
    absorber.processFrame(dummyTiles, { r: 200, g: 50, b: 30 });

    absorber.reset();

    const freshTiles = Array.from({ length: 16 }, () => ({ r: 170, g: 45, b: 35, count: 50 }));
    const freshOut = absorber.processFrame(freshTiles, { r: 170, g: 45, b: 35 });
    expect(freshOut.red).toBeGreaterThan(140);
    expect(freshOut.tremorScore).toBeLessThan(0.5);
  });
});
