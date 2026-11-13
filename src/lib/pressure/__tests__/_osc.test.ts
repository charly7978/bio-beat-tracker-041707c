import { describe, it } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import {
  createTransmuralState,
  observeTransmuralPressure,
} from '../transmuralPressureModel';

const OUT = process.env.TEMP + '/ppg-osc.txt';

const HEALTHY = {
  sealRatio: 0.62,
  perfusedFraction: 0.7,
  perfusionIndex: 0.004,
  dcLevel: 150,
  roiRedCv: 0.05,
  motionScore: 0.05,
};

const PRESS = {
  sealRatio: 0.9,
  perfusedFraction: 0.7,
  perfusionIndex: 0.0005,
  dcLevel: 215,
  roiRedCv: 0.006,
  motionScore: 0.05,
};

describe('oscilacion', () => {
  it('alterna frames en la banda de transición', () => {
    writeFileSync(OUT, '');
    const s = createTransmuralState();
    let r = observeTransmuralPressure(s, HEALTHY);
    for (let i = 0; i < 45; i++) r = observeTransmuralPressure(s, HEALTHY);

    // Alterna entre "sano" y "presionando" cada frame: la señal está justo en el
    // límite. Un veredicto con histéresis no debería cambiar en cada frame.
    let changes = 0;
    let prev = r.state;
    const seq: string[] = [];
    for (let i = 0; i < 60; i++) {
      const frame = i % 2 === 0 ? HEALTHY : PRESS;
      r = observeTransmuralPressure(s, frame);
      if (r.state !== prev) {
        changes++;
        seq.push(`${i}:${prev}->${r.state}`);
      }
      prev = r.state;
    }
    appendFileSync(OUT, `cambios=${changes} estados=${[...new Set(seq)].join(',')}\n`);
    appendFileSync(OUT, `detalle=${seq.slice(0, 20).join(' | ')}\n`);
  });
});