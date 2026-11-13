import { describe, expect, it } from 'vitest';
import {
  WELL_CROP_FRAC,
  WELL_VEIL,
  deriveWellGuide,
  fingerprintRidges,
  frameToCrop,
  projectWellUV,
  wellVeilAt,
  type WellGuideInput,
} from '../fingerPlacementOverlay';
import { computeFloorPreviewGeometry } from '../ppg3dProjection';
import type { FingerPlacementEvidence } from '@/lib/finger/fingerPlacementEvidence';
import type { PpgRenderState } from '../ppgCanvasRenderer';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

const PLOT = { x: 12, y: 132, w: 366, h: 542, centerY: 403 };

function makeState(): PpgRenderState {
  return {
    layout: {
      width: 390,
      height: 844,
      header: { x: 0, y: 0, w: 390, h: 36 },
      metrics: { x: 0, y: 36, w: 390, h: 93 },
      plot: PLOT,
      trend: { x: 12, y: 677, w: 366, h: 80 },
      footer: { x: 0, y: 754, w: 390, h: 42 },
    },
    threeD: { enabled: true, intensity: 1 },
  } as unknown as PpgRenderState;
}

function evidence(
  overrides: Partial<FingerPlacementEvidence> = {},
): FingerPlacementEvidence {
  return {
    score: 0.8,
    pressure: 'IDEAL',
    pressureScore: 0.5,
    pressureAxis: 'NONE',
    blanching: 0,
    seal: 0.62,
    pulsatility: 0.9,
    perfusedFraction: 0.7,
    placement: 'CENTERED',
    centroid: { x: 0.5, y: 0.5 },
    offset: { x: 0, y: 0 },
    alignment: 1,
    readiness: 'READY',
    failing: [],
    guidance: {
      action: 'HOLD',
      headline: 'CONTACTO ÓPTIMO',
      detail: '',
      progress: 1,
      confidence: 0.9,
    },
    etiology: {
      cause: 'OPTIMAL',
      confidence: 0.9,
      alternatives: [],
      explanation: '',
      headline: 'CONTACTO ÓPTIMO',
      action: 'HOLD',
      evidence: [],
    },
    coverage: 0.62,
    centering: 1,
    stability: 1,
    motion: 0.05,
    ...overrides,
  } as unknown as FingerPlacementEvidence;
}

function view(overrides: Partial<WellGuideInput> = {}) {
  const base: WellGuideInput = {
    evidence: evidence(),
    acquisitionStage: 'READY',
    hasVideo: true,
    nowMs: 1000,
    beatPulse: 0,
    reducedMotion: false,
    ...overrides,
  };
  return deriveWellGuide(base);
}

describe('deriveWellGuide — la ventana sólo dice OK si es verdad', () => {
  it('sin evidencia no afirma nada y no dibuja fantasma', () => {
    const v = view({ evidence: undefined });
    expect(v.readiness).toBe('INACTIVE');
    expect(v.ghostVisible).toBe(false);
    expect(v.label).toBe('SENSOR EN ESPERA');
  });

  it('dedo bien colocado + adquisición READY → READY, sin fantasma', () => {
    const v = view();
    expect(v.readiness).toBe('READY');
    expect(v.ghostVisible).toBe(false);
    expect(v.label).toMatch(/ESTABLE/);
    expect(v.alignment).toBe(1);
  });

  it('colocación perfecta pero adquisición aún buscando → NO dice READY', () => {
    const v = view({ acquisitionStage: 'SEARCHING' });
    expect(v.readiness).not.toBe('READY');
  });

  it('sin tejido sobre la lente → NO_CONTACT y sin corrección', () => {
    const v = view({
      evidence: evidence({
        placement: 'NO_FINGER',
        readiness: 'NO_CONTACT',
        seal: 0.02,
        alignment: 0,
        centroid: { x: 0.5, y: 0.5 },
      }),
    });
    expect(v.readiness).toBe('NO_CONTACT');
    expect(v.ghostVisible).toBe(false);
  });

  it('dedo descentrado → ALIGNING con fantasma y corrección hacia el centro', () => {
    const v = view({
      evidence: evidence({
        placement: 'EDGE',
        readiness: 'ALIGNING',
        alignment: 0,
        centroid: { x: 0.78, y: 0.5 },
        offset: { x: -0.28, y: 0 },
        seal: 0.4,
      }),
    });

    expect(v.readiness).toBe('ALIGNING');
    expect(v.ghostVisible).toBe(true);
    // El fantasma se dibuja donde el tejido está de verdad (derecha del centro).
    expect(v.ghost.u).toBeGreaterThan(0.7);
    expect(v.ghost.v).toBeCloseTo(0.5, 5);
    // La corrección apunta al centro: u negativa, v nula.
    expect(v.correction.u).toBeLessThan(0);
    expect(v.correction.v).toBeCloseTo(0, 5);
    expect(v.offset).toBeGreaterThan(0);
    expect(v.severity).toBeGreaterThan(0);
  });

  it('la corrección es simétrica en los cuatro cuadrantes', () => {
    const cases: Array<[number, number, number, number]> = [
      [0.8, 0.5, -1, 0],
      [0.2, 0.5, 1, 0],
      [0.5, 0.8, 0, -1],
      [0.5, 0.2, 0, 1],
    ];
    for (const [cx, cy, signU, signV] of cases) {
      const v = view({
        evidence: evidence({
          placement: 'EDGE',
          readiness: 'ALIGNING',
          alignment: 0.2,
          centroid: { x: cx, y: cy },
          seal: 0.35,
        }),
      });
      if (signU !== 0) {
        expect(Math.sign(v.correction.u)).toBe(signU);
        expect(v.correction.v).toBeCloseTo(0, 5);
      } else {
        expect(Math.sign(v.correction.v)).toBe(signV);
        expect(v.correction.u).toBeCloseTo(0, 5);
      }
    }
  });

  it('un descentrado mínimo queda en la zona muerta: no se pide corrección', () => {
    const dead = VITAL_THRESHOLDS.PLACEMENT.OVERLAY.DEADBAND;
    const v = view({
      evidence: evidence({
        placement: 'CENTERED',
        readiness: 'ALIGNING',
        alignment: 0.95,
        centroid: { x: 0.5 + dead * WELL_CROP_FRAC * 0.5, y: 0.5 },
        seal: 0.6,
      }),
    });
    expect(v.offset).toBeLessThanOrEqual(dead);
    expect(v.severity).toBeLessThan(0.2);
  });

  it('presión no óptima se declara PRESSURE, no READY', () => {
    const v = view({
      evidence: evidence({ pressure: 'LIGHT', readiness: 'PRESSURE' }),
    });
    expect(v.readiness).toBe('PRESSURE');
  });

  it('el sellado codifica el tamaño del fantasma y el pulso su opacidad', () => {
    const low = view({
      evidence: evidence({ seal: 0.12, pulsatility: 0.1, readiness: 'ALIGNING' }),
    });
    const high = view({
      evidence: evidence({ seal: 0.9, pulsatility: 0.95, readiness: 'ALIGNING' }),
    });
    expect(high.ghostScale).toBeGreaterThan(low.ghostScale);
    expect(high.ghostAlpha).toBeGreaterThan(low.ghostAlpha);
  });

  it('con movimiento reducido el barrido se congela', () => {
    const a = view({ reducedMotion: true, nowMs: 0 });
    const b = view({ reducedMotion: true, nowMs: 900 });
    expect(a.scan).toBe(b.scan);
    expect(a.breath).toBe(1);
  });
});

describe('frameToCrop — la guía y el vídeo comparten recorte', () => {
  it('mapea el recorte central exacto del vídeo', () => {
    const inset = (1 - WELL_CROP_FRAC) / 2;
    expect(frameToCrop(inset)).toBeCloseTo(0, 6);
    expect(frameToCrop(0.5)).toBeCloseTo(0.5, 6);
    expect(frameToCrop(1 - inset)).toBeCloseTo(1, 6);
  });
});

describe('projectWellUV — inversa exacta del pintado por franjas', () => {
  it('recupera la fila de pantalla desde la v del recorte (ida y vuelta)', () => {
    const geo = computeFloorPreviewGeometry(makeState(), 1);
    for (const y of [geo.farY + 2, (geo.farY + geo.nearY) / 2, geo.nearY - 2]) {
      const v = geo.sourceVAt(y);
      const p = projectWellUV(geo, 0.5, v);
      expect(p.y).toBeCloseTo(y, 6);
    }
  });

  it('extremidad: v=0 cae en el borde lejano y v=1 en el cercano', () => {
    const geo = computeFloorPreviewGeometry(makeState(), 1);
    expect(projectWellUV(geo, 0.5, 0).y).toBeCloseTo(geo.farY, 6);
    expect(projectWellUV(geo, 0.5, 1).y).toBeCloseTo(geo.nearY, 6);
  });

  it('u=0 y u=1 caen en los bordes del trapecio a esa profundidad', () => {
    const geo = computeFloorPreviewGeometry(makeState(), 1);
    const v = 0.4;
    const left = projectWellUV(geo, 0, v);
    const right = projectWellUV(geo, 1, v);
    const depth = geo.quad.zn + (1 - v) * (geo.quad.zf - geo.quad.zn);
    const expectedHalf = geo.quad.halfW * geo.proj.scaleAt(
      (depth - geo.proj.zNear) / (geo.proj.zFar - geo.proj.zNear),
    );
    expect(right.x - left.x).toBeCloseTo(expectedHalf * 2, 4);
    expect((left.x + right.x) / 2).toBeCloseTo(geo.proj.vpX, 6);
  });

  it('el centro del recorte coincide con el centro óptico de la lente', () => {
    const geo = computeFloorPreviewGeometry(makeState(), 1);
    const c = projectWellUV(geo, 0.5, 0.5);
    expect(c.x).toBeCloseTo(geo.proj.vpX, 6);
    expect(c.y).toBeGreaterThan(geo.farY);
    expect(c.y).toBeLessThan(geo.nearY);
  });
});

describe('wellVeilAt — contrato de transparencia', () => {
  it('deja pasar ≥ 70% de la luz en la banda del dedo (centro de la ventana)', () => {
    expect(1 - wellVeilAt(0.55, 1)).toBeGreaterThanOrEqual(0.7);
    expect(1 - wellVeilAt(0.75, 1)).toBeGreaterThanOrEqual(0.7);
  });

  it('el borde lejano se funde con el horizonte, pero nunca tapa', () => {
    expect(wellVeilAt(0, 1)).toBeLessThanOrEqual(1 - 0.55);
  });

  it('ninguna capa de velo supera el 30%', () => {
    expect(WELL_VEIL.TINT_MIN + WELL_VEIL.TINT_MAX).toBeLessThanOrEqual(0.1);
    expect(WELL_VEIL.DEPTH_FAR).toBeLessThanOrEqual(0.3);
    expect(WELL_VEIL.DEPTH_MID).toBeLessThanOrEqual(0.3);
    expect(WELL_VEIL.GLASS_FAR).toBeLessThanOrEqual(0.1);
  });

  it('el velo disminuye del borde lejano al cercano (el dedo se ve mejor cerca)', () => {
    const far = wellVeilAt(0.05, 1);
    const mid = wellVeilAt(0.5, 1);
    const near = wellVeilAt(0.95, 1);
    expect(far).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(near);
  });

  it('subir el veredicto aclara (más apertura = menos tinte relativo)', () => {
    expect(wellVeilAt(0.6, 1)).toBeGreaterThanOrEqual(wellVeilAt(0.6, 0));
  });
});

describe('fingerprintRidges — forma determinista y registrable', () => {
  const RIDGES = VITAL_THRESHOLDS.PLACEMENT.OVERLAY.RIDGES;
  const outerRidge = (scale: number) => fingerprintRidges(0.5, 0.5, scale)[RIDGES - 1];

  it('devuelve el número de crestas configurado con muestras suficientes', () => {
    const ridges = fingerprintRidges(0.5, 0.5, 1);
    expect(ridges).toHaveLength(VITAL_THRESHOLDS.PLACEMENT.OVERLAY.RIDGES);
    for (const r of ridges) expect(r.length).toBeGreaterThan(20);
  });

  it('es determinista: dos llamadas dan la misma huella', () => {
    const a = JSON.stringify(fingerprintRidges(0.4, 0.6, 1.1));
    const b = JSON.stringify(fingerprintRidges(0.4, 0.6, 1.1));
    expect(a).toBe(b);
  });

  it('la huella crece con la escala y queda centrada en (cu,cv)', () => {
    const small = fingerprintRidges(0.5, 0.5, 0.6);
    const big = fingerprintRidges(0.5, 0.5, 1);
    const span = (r: { u: number; v: number }[][]) => {
      const pts = r.flat();
      const us = pts.map((p) => p.u);
      return Math.max(...us) - Math.min(...us);
    };
    expect(span(big)).toBeGreaterThan(span(small));

    const outer = outerRidge(1);
    const us = outer.map((p) => p.u);
    const vs = outer.map((p) => p.v);
    // El delta se abre arriba (no es un óvalo cerrado): el eje X sí va centrado y
    // todo cae dentro del semieje configurado.
    expect((Math.max(...us) + Math.min(...us)) / 2).toBeCloseTo(0.5, 3);
    const rv = VITAL_THRESHOLDS.PLACEMENT.OVERLAY.RIDGE_V;
    expect(Math.min(...vs)).toBeGreaterThan(0.5 - rv * 1.1);
    expect(Math.max(...vs)).toBeLessThan(0.5 + rv * 1.1);
  });

  it('la almohadilla es más larga que ancha (forma de huella, no de círculo)', () => {
    const outer = outerRidge(1);
    const w = Math.max(...outer.map((p) => p.u)) - Math.min(...outer.map((p) => p.u));
    const h = Math.max(...outer.map((p) => p.v)) - Math.min(...outer.map((p) => p.v));
    expect(h).toBeGreaterThan(w);
  });
});
