import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PressureCoach } from '../PressureCoach';
import type { FingerPlacementEvidence } from '@/lib/finger/fingerPlacementEvidence';

/**
 * La guía es la parte ESENCIAL del encargo. Estas pruebas comprueban el texto
 * que realmente llega al DOM, no solo que el modelo calcula algo: si el
 * componente devuelve vacío, el usuario no ve nada por muy bueno que sea el
 * modelo.
 */
function evidenceWith(
  overrides: Partial<FingerPlacementEvidence['guidance']> & {
    pressure?: FingerPlacementEvidence['pressure'];
  } = {},
): FingerPlacementEvidence {
  const action = overrides.action ?? 'HOLD';
  return {
    score: 0.7,
    pressure: overrides.pressure ?? 'IDEAL',
    pressureScore: 0.5,
    pressureAxis: 'OPTIMAL',
    blanching: 0,
    seal: 0.7,
    pulsatility: 0.8,
    perfusedFraction: 0.6,
    placement: 'CENTERED',
    failing: [],
    coverage: 0.7,
    centering: 0.9,
    stability: 0.9,
    motion: 0.9,
    guidance: {
      action,
      headline: 'PRESIÓN ÓPTIMA · MANTÉN',
      detail: 'El pulso tiene su amplitud máxima.',
      progress: 0.9,
      confidence: 0.7,
      ...overrides,
    },
  };
}

describe('PressureCoach — la guía llega al usuario', () => {
  it('renderiza el titular y el detalle de la guía', () => {
    const html = renderToStaticMarkup(
      <PressureCoach evidence={evidenceWith()} isMonitoring />,
    );

    expect(html).toContain('PRESIÓN ÓPTIMA · MANTÉN');
    expect(html).toContain('El pulso tiene su amplitud máxima.');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it('muestra "apoya el dedo" aunque la confianza sea baja (sin contacto)', () => {
    // Defecto aceptado en la ronda adversarial: el filtro por confianza ocultaba
    // justo esta instrucción, la más necesaria cuando no hay dedo.
    const html = renderToStaticMarkup(
      <PressureCoach
        evidence={evidenceWith({
          action: 'REPOSITION',
          headline: 'APOYA EL DEDO EN LA LENTE',
          confidence: 0.05,
          progress: 0,
        })}
        isMonitoring
      />,
    );

    expect(html).toContain('APOYA EL DEDO EN LA LENTE');
  });

  it('muestra el aviso de "suelta" cuando la presión es excesiva', () => {
    const html = renderToStaticMarkup(
      <PressureCoach
        evidence={evidenceWith({
          action: 'RELEASE',
          headline: 'SUELTA UN POCO EL DEDO',
          pressure: 'HEAVY',
          blanching: 0.8,
        })}
        isMonitoring
      />,
    );

    expect(html).toContain('SUELTA UN POCO EL DEDO');
    expect(html).toContain('animate-pulse');
  });

  it('sustituye la guía de presión por un aviso técnico si la captura está degradada', () => {
    const html = renderToStaticMarkup(
      <PressureCoach
        evidence={evidenceWith({ action: 'HOLD', headline: 'PRESIÓN ÓPTIMA · MANTÉN' })}
        isMonitoring
        status="SATURATED"
      />,
    );

    // No debe afirmar presión cuando el sensor está saturado.
    expect(html).not.toContain('PRESIÓN ÓPTIMA · MANTÉN');
    expect(html).toContain('DEMOSTRE LA IMAGEN');
  });

  it('no renderiza nada si la monitorización no está activa', () => {
    const html = renderToStaticMarkup(
      <PressureCoach evidence={evidenceWith()} isMonitoring={false} />,
    );
    expect(html).toBe('');
  });

  it('no renderiza la espera de confianza nula (ruido), pero sí una espera fiable', () => {
    const silent = renderToStaticMarkup(
      <PressureCoach
        evidence={evidenceWith({
          action: 'WAIT',
          headline: 'AJUSTANDO LA CÁMARA',
          confidence: 0.05,
        })}
        isMonitoring
      />,
    );
    expect(silent).toBe('');

    const visible = renderToStaticMarkup(
      <PressureCoach
        evidence={evidenceWith({
          action: 'WAIT',
          headline: 'AJUSTANDO LA CÁMARA',
          confidence: 0.5,
        })}
        isMonitoring
      />,
    );
    expect(visible).toContain('AJUSTANDO LA CÁMARA');
  });
});