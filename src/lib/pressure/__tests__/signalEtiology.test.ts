import { describe, expect, it } from 'vitest';
import {
  inferSignalEtiology,
  type EtiologyEvidence,
  type SignalCauseId,
} from '../signalEtiology';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

const P = VITAL_THRESHOLDS.PRESSURE;

/**
 * Evidencia base: dedo bien colocado, pulso pleno y DC estable en su punto de
 * mejor pulso. Cada prueba desvía SOLO el signo que corresponde a la causa que
 * quiere demostrar, igual que la fisiología describe cada estado.
 */
const OPTIMAL: EtiologyEvidence = {
  seal: 0.7,
  sealNorm: 1,
  pulsatility: 1,
  perfusionRatio: 1,
  hasReference: true,
  dcRatio: 1,
  dcRise: 0,
  blanching: 0,
  piTrend: 0,
  cvRatio: 1,
  perfusedFraction: 0.7,
  stillness: 0.95,
  centering: 0.95,
  capture: 'OK',
};

function infer(overrides: Partial<EtiologyEvidence> = {}) {
  return inferSignalEtiology({ ...OPTIMAL, ...overrides });
}

describe('signalEtiology — razonamiento causal de la señal', () => {
  describe('identifica cada causa por su firma fisiológica', () => {
    it('contacto óptimo → HOLD', () => {
      const r = infer();
      expect(r.cause).toBe('OPTIMAL');
      expect(r.action).toBe('HOLD');
      expect(r.confidence).toBeGreaterThan(0.5);
    });

    it('lente sin cubrir → REPOSITION', () => {
      const r = infer({
        seal: 0.02,
        sealNorm: 0,
        pulsatility: 0,
        perfusionRatio: 0,
        hasReference: false,
        cvRatio: 0,
        perfusedFraction: 0,
      });
      expect(r.cause).toBe('NO_CONTACT');
      expect(r.action).toBe('REPOSITION');
      expect(r.explanation).toMatch(/apoya el dedo/i);
    });

    it('lente cubierta a medias → PRESS_MORE (apretar sí añade cobertura)', () => {
      const r = infer({
        seal: 0.18,
        sealNorm: (0.18 - P.COVER_MIN) / (P.COVER_GOOD - P.COVER_MIN),
        pulsatility: 0.2,
        perfusionRatio: 0,
        hasReference: false,
        cvRatio: 1,
        perfusedFraction: 0.2,
      });
      expect(r.cause).toBe('INSUFFICIENT_CONTACT');
      expect(r.action).toBe('PRESS_MORE');
    });

    it('dedo descentrado con cobertura parcial → CENTER', () => {
      const r = infer({
        seal: 0.3,
        sealNorm: (0.3 - P.COVER_MIN) / (P.COVER_GOOD - P.COVER_MIN),
        centering: 0.05,
        pulsatility: 0.3,
        hasReference: false,
        perfusedFraction: 0.3,
      });
      expect(r.cause).toBe('OFF_CENTER');
      expect(r.action).toBe('CENTER');
    });

    it('blanqueo mecánico (AC cae + DC sube) → RELEASE', () => {
      const r = infer({
        seal: 0.9,
        pulsatility: 0.1,
        perfusionRatio: 0.08,
        dcRatio: 1.45,
        dcRise: 0.8,
        blanching: 0.8,
        piTrend: -1,
        cvRatio: 0.4,
      });
      expect(r.cause).toBe('EXCESS_PRESSURE');
      expect(r.action).toBe('RELEASE');
      expect(r.explanation).toMatch(/colaps/i);
    });

    it('vasoconstricción (AC cae + DC estable + PI subiendo) → WARM', () => {
      const r = infer({
        seal: 0.65,
        pulsatility: 0.25,
        perfusionRatio: 0.25,
        dcRatio: 1.0,
        dcRise: 0,
        blanching: 0,
        piTrend: 1,
        cvRatio: 1,
        perfusedFraction: 0.35,
      });
      expect(r.cause).toBe('VASOCONSTRICTION');
      expect(r.action).toBe('WARM');
      expect(r.explanation).toMatch(/frío|frótalo/i);
      expect(r.explanation).toMatch(/no aprietes más/i);
    });

    it('movimiento → WAIT', () => {
      const r = infer({ stillness: 0.02, motion: undefined } as Partial<EtiologyEvidence>);
      expect(r.cause).toBe('MOTION');
      expect(r.action).toBe('WAIT');
    });
  });

  describe('precondiciones: no se diagnostica lo que no se puede medir', () => {
    it('sin acoplamiento óptico NO se diagnostica vasoconstricción', () => {
      // Con la lente sin cubrir la AC baja porque no entra luz, no porque el
      // lecho capilar esté cerrado. Diagnosticar frío aquí sería inventar.
      const r = infer({
        seal: 0.05,
        sealNorm: 0,
        pulsatility: 0.05,
        perfusionRatio: 0,
        hasReference: false,
        cvRatio: 0,
        perfusedFraction: 0,
      });
      expect(r.cause).not.toBe('VASOCONSTRICTION');
    });

    it('sin acoplamiento óptico NO se diagnostica blanqueo', () => {
      const r = infer({
        seal: 0.08,
        sealNorm: 0,
        pulsatility: 0.05,
        perfusionRatio: 0.1,
        dcRatio: 1.9,
        dcRise: 1,
        blanching: 1,
        cvRatio: 0.1,
        perfusedFraction: 0,
      });
      expect(r.cause).not.toBe('EXCESS_PRESSURE');
    });

    it('un sensor saturado invalida cualquier lectura fisiológica', () => {
      const r = infer({ capture: 'SATURATED', seal: 0.9, pulsatility: 1 });
      expect(r.cause).toBe('SATURATED');
      expect(r.action).toBe('FIX_SATURATION');
      expect(r.confidence).toBe(1);
      expect(r.explanation).toMatch(/saturado/i);
    });

    it('subexposición y baja frecuencia también son precondiciones', () => {
      expect(infer({ capture: 'UNDEREXPOSED' }).cause).toBe('UNDEREXPOSED');
      expect(infer({ capture: 'UNDEREXPOSED' }).action).toBe('FIX_LIGHT');
      expect(infer({ capture: 'LOW_FPS' }).cause).toBe('LOW_FPS');
      expect(infer({ capture: 'LOW_FPS' }).action).toBe('FIX_FPS');
    });
  });

  describe('explicabilidad: dice qué pasa y por qué, con números medidos', () => {
    it('la explicación cita el porcentaje de pulso y el DC', () => {
      const r = infer({
        seal: 0.9,
        pulsatility: 0.12,
        perfusionRatio: 0.1,
        dcRatio: 1.45,
        dcRise: 0.8,
        blanching: 0.8,
        piTrend: -1,
      });
      expect(r.explanation).toMatch(/\d+%/);
      expect(r.explanation).toMatch(/DC/i);
      expect(r.explanation).toMatch(/pulso/i);
    });

    it('separa la firma del frío de la del blanqueo con el mismo pulso bajo', () => {
      // Mismo pulso al 25%: lo que cambia es el DC y la tendencia.
      const cold = infer({ seal: 0.65, pulsatility: 0.25, dcRatio: 1.0, piTrend: 1 });
      const pressed = infer({
        seal: 0.9,
        pulsatility: 0.25,
        dcRatio: 1.5,
        dcRise: 0.9,
        blanching: 0.8,
        piTrend: -1,
      });
      expect(cold.action).toBe('WARM');
      expect(pressed.action).toBe('RELEASE');
      expect(cold.explanation).not.toBe(pressed.explanation);
    });

    it('incluye la TENDENCIA del PI en la explicación cuando es decisiva', () => {
      // El segundo signo que separa frío de presión mecánica debe estar en el
      // texto: no basta con calcularlo.
      const coldRising = infer({
        seal: 0.65,
        pulsatility: 0.25,
        dcRatio: 1,
        piTrend: 1,
        perfusedFraction: 0.3,
      });
      expect(coldRising.explanation).toMatch(/va subiendo|se calienta/i);

      const pressedFalling = infer({
        seal: 0.9,
        pulsatility: 0.12,
        dcRatio: 1.5,
        dcRise: 0.9,
        blanching: 0.8,
        piTrend: -1,
      });
      expect(pressedFalling.explanation).toMatch(/sigue cayendo/i);
    });

    it('no inventa una tendencia cuando el PI está estable', () => {
      const stable = infer({
        seal: 0.9,
        pulsatility: 0.12,
        dcRatio: 1.5,
        dcRise: 0.9,
        blanching: 0.8,
        piTrend: 0,
      });
      expect(stable.explanation).not.toMatch(/sigue cayendo|va subiendo/i);
    });

    it('expone alternativas cuando la evidencia es ambigua', () => {
      const r = infer({
        seal: 0.45,
        sealNorm: 1,
        pulsatility: 0.4,
        perfusionRatio: 0.6,
        dcRatio: 1.05,
        dcRise: 0.1,
        blanching: 0.2,
        piTrend: 0,
      });
      expect(r.confidence).toBeLessThan(0.9);
      expect(r.alternatives.length).toBeGreaterThan(0);
      expect(r.alternatives[0].probability).toBeGreaterThan(0);
      expect(r.alternatives[0].probability).toBeLessThanOrEqual(1);
    });
  });

  describe('robustez numérica y determinismo', () => {
    it('nunca devuelve NaN ni probabilidades fuera de [0,1]', () => {
      const cases: Partial<EtiologyEvidence>[] = [
        { seal: Number.NaN, sealNorm: Number.NaN },
        { dcRatio: Number.NaN },
        { cvRatio: Number.NaN, pulsatility: Number.NaN },
        { perfusedFraction: Number.NaN, centering: Number.NaN },
        { seal: -5, sealNorm: 9, dcRatio: -3, cvRatio: 12 },
      ];
      for (const c of cases) {
        const r = infer(c);
        expect(Number.isFinite(r.confidence)).toBe(true);
        expect(r.confidence).toBeGreaterThanOrEqual(0);
        expect(r.confidence).toBeLessThanOrEqual(1);
        for (const alt of r.alternatives) {
          expect(Number.isFinite(alt.probability)).toBe(true);
          expect(alt.probability).toBeGreaterThanOrEqual(0);
          expect(alt.probability).toBeLessThanOrEqual(1);
        }
        expect(typeof r.explanation).toBe('string');
        expect(r.explanation.length).toBeGreaterThan(0);
      }
    });

    it('es determinista: la misma evidencia da la misma causa', () => {
      const evidence: EtiologyEvidence = {
        ...OPTIMAL,
        seal: 0.9,
        pulsatility: 0.1,
        dcRatio: 1.5,
        dcRise: 0.9,
        blanching: 0.8,
      };
      const a = inferSignalEtiology(evidence);
      const b = inferSignalEtiology(evidence);
      expect(a.cause).toBe(b.cause);
      expect(a.action).toBe(b.action);
      expect(a.explanation).toBe(b.explanation);
      expect(a.confidence).toBe(b.confidence);
    });

    it('no muta la evidencia de entrada', () => {
      const evidence: EtiologyEvidence = { ...OPTIMAL };
      const snapshot = JSON.stringify(evidence);
      inferSignalEtiology(evidence);
      expect(JSON.stringify(evidence)).toBe(snapshot);
    });

    it('toda causa declarada produce etiqueta y explicación no vacías', () => {
      const signatures: Array<[SignalCauseId, Partial<EtiologyEvidence>]> = [
        ['NO_CONTACT', { seal: 0.01, sealNorm: 0, pulsatility: 0, hasReference: false, cvRatio: 0 }],
        ['OFF_CENTER', { seal: 0.3, sealNorm: 0.6, centering: 0.02, pulsatility: 0.3, hasReference: false }],
        ['INSUFFICIENT_CONTACT', { seal: 0.15, sealNorm: 0.15, pulsatility: 0.2, hasReference: false }],
        ['EXCESS_PRESSURE', { seal: 0.9, pulsatility: 0.1, dcRatio: 1.5, dcRise: 0.9, blanching: 0.8 }],
        ['VASOCONSTRICTION', { seal: 0.65, pulsatility: 0.25, dcRatio: 1, piTrend: 1, perfusedFraction: 0.3 }],
        ['MOTION', { stillness: 0.01 }],
        ['SATURATED', { capture: 'SATURATED' }],
        ['UNDEREXPOSED', { capture: 'UNDEREXPOSED' }],
        ['LOW_FPS', { capture: 'LOW_FPS' }],
        ['OPTIMAL', {}],
      ];

      for (const [, overrides] of signatures) {
        const r = infer(overrides);
        expect(r.label.length).toBeGreaterThan(0);
        expect(r.headline.length).toBeGreaterThan(0);
        expect(r.explanation.length).toBeGreaterThan(20);
      }
    });
  });
});