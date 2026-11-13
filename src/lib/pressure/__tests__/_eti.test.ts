import { describe, it } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import { inferSignalEtiology, type EtiologyEvidence } from '../signalEtiology';

const OUT = process.env.TEMP + '/etiologia.txt';

function trace(name: string, e: EtiologyEvidence) {
  const r = inferSignalEtiology(e);
  appendFileSync(
    OUT,
    `${name}: cause=${r.cause} action=${r.action} conf=${r.confidence.toFixed(3)}\n` +
      `   alt=${r.alternatives.map((a) => `${a.cause}:${a.probability.toFixed(2)}`).join(',')}\n` +
      `   expl=${r.explanation.slice(0, 90)}\n`,
  );
  return r;
}

describe('debug etiologia', () => {
  it('casos', () => {
    writeFileSync(OUT, '');

    // PRESSING_SOFT: seal 0.16, PI 0.0008, dc 60
    trace('SOFT', {
      seal: 0.16,
      sealNorm: (0.16 - 0.1) / (0.42 - 0.1),
      pulsatility: 0.0008 / 0.004,
      perfusionRatio: 0,
      hasReference: false,
      dcRatio: 1,
      dcRise: 0,
      blanching: 0,
      piTrend: 0,
      cvRatio: 0.02 / 0.012,
      perfusedFraction: 0.2,
      stillness: 0.89,
      centering: 0.95,
      capture: 'OK',
    });

    // No contact
    trace('NONE', {
      seal: 0.03, sealNorm: 0, pulsatility: 0, perfusionRatio: 0, hasReference: false,
      dcRatio: 1, dcRise: 0, blanching: 0, piTrend: 0, cvRatio: 0,
      perfusedFraction: 0, stillness: 0.95, centering: 0.95, capture: 'OK',
    });

    // Good seal, weak pulse, DC steady -> should be WARM
    trace('COLD', {
      seal: 0.62, sealNorm: 1, pulsatility: 0.25, perfusionRatio: 0.25,
      hasReference: true, dcRatio: 1.0, dcRise: 0, blanching: 0, piTrend: 1,
      cvRatio: 1, perfusedFraction: 0.4, stillness: 0.9, centering: 0.95, capture: 'OK',
    });

    // Blanching
    trace('HEAVY', {
      seal: 0.9, sealNorm: 1, pulsatility: 0.12, perfusionRatio: 0.1,
      hasReference: true, dcRatio: 1.45, dcRise: 0.8, blanching: 0.75, piTrend: -1,
      cvRatio: 0.4, perfusedFraction: 0.7, stillness: 0.9, centering: 0.95, capture: 'OK',
    });

    // Optimal
    trace('IDEAL', {
      seal: 0.7, sealNorm: 1, pulsatility: 1, perfusionRatio: 1,
      hasReference: true, dcRatio: 1.0, dcRise: 0, blanching: 0, piTrend: 0,
      cvRatio: 1, perfusedFraction: 0.7, stillness: 0.95, centering: 0.95, capture: 'OK',
    });
  });
});