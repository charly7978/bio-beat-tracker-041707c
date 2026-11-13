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

  it('muestra el aviso de captura degradada que produce el motor', () => {
    // Un sensor saturado no permite afirmar presión: el motor lo declara como
    // causa y el coach muestra ese aviso en lugar de una guía de presión.
    const html = renderToStaticMarkup(
      <PressureCoach
        evidence={evidenceWith({
          action: 'FIX_SATURATION',
          headline: 'SENSOR SATURADO',
          detail: 'El sensor está saturado: el rojo llega al tope. Baja el brillo o apaga el flash.',
          progress: 0,
        })}
        isMonitoring
      />,
    );

    expect(html).not.toContain('PRESIÓN ÓPTIMA · MANTÉN');
    expect(html).toContain('SENSOR SATURADO');
    expect(html).toContain('saturado');
  });

  it('muestra la guía de calentar el dedo (vasoconstricción)', () => {
    const html = renderToStaticMarkup(
      <PressureCoach
        evidence={evidenceWith({
          action: 'WARM',
          headline: 'VASOCONSTRICCIÓN: DEDO FRÍO O ESTRÉS',
          detail: 'El pulso está al 25% pero el DC sigue al 100%: no estás apretando de más. Frótalo o tápalo; no aprietes más.',
          progress: 0.2,
        })}
        isMonitoring
      />,
    );

    expect(html).toContain('VASOCONSTRICCIÓN');
    expect(html).toContain('no aprietes más');
  });

  it('muestra el aviso secundario de centrado aunque el titular sea de presión', () => {
    // El coach solo mostraba la instrucción de PRESIÓN: "centra la yema" o
    // "sostén el dedo quieto" nunca llegaban al usuario en 2D.
    const html = renderToStaticMarkup(
      <PressureCoach
        evidence={{
          ...evidenceWith({
            action: 'PRESS_MORE',
            headline: 'PRESIONA UN POCO MÁS',
          }),
          failing: ['Centra la yema en la lente', 'Sostén el dedo quieto'],
        }}
        isMonitoring
      />,
    );

    expect(html).toContain('PRESIONA UN POCO MÁS');
    expect(html).toContain('Centra la yema en la lente');
  });

  it('no duplica el titular dentro del aviso secundario', () => {
    const html = renderToStaticMarkup(
      <PressureCoach
        evidence={{
          ...evidenceWith({
            action: 'RELEASE',
            headline: 'SUELTA UN POCO EL DEDO',
            pressure: 'HEAVY',
          }),
          failing: ['Presión excesiva: suelta un poco el dedo'],
        }}
        isMonitoring
      />,
    );

    // El secundario es redundante con el titular: no debe repetirse.
    expect(html.match(/SUELTA UN POCO EL DEDO/gi)?.length).toBe(1);
  });

  it('declara la explicación alternativa cuando la evidencia es ambigua', () => {
    const html = renderToStaticMarkup(
      <PressureCoach
        evidence={{
          ...evidenceWith({
            action: 'PRESS_MORE',
            headline: 'APOYO INSUFICIENTE SOBRE LA LENTE',
            confidence: 0.4,
          }),
          etiology: {
            cause: 'INSUFFICIENT_CONTACT',
            label: 'Apoyo insuficiente sobre la lente',
            action: 'PRESS_MORE',
            headline: 'APOYO INSUFICIENTE SOBRE LA LENTE',
            explanation: 'La lente está cubierta al 18%.',
            confidence: 0.4,
            alternatives: [{ cause: 'OFF_CENTER', probability: 0.32 }],
            supporting: [],
            contradicting: [],
          },
        }}
        isMonitoring
      />,
    );

    expect(html).toContain('También encaja');
    expect(html).toContain('dedo descentrado');
    expect(html).toContain('32%');
  });

  it('no declara alternativa cuando la evidencia es concluyente', () => {
    const html = renderToStaticMarkup(
      <PressureCoach
        evidence={{
          ...evidenceWith({ action: 'HOLD', headline: 'CONTACTO ÓPTIMO', confidence: 0.9 }),
          etiology: {
            cause: 'OPTIMAL',
            label: 'Contacto óptimo',
            action: 'HOLD',
            headline: 'CONTACTO ÓPTIMO',
            explanation: 'Todo correcto.',
            confidence: 0.9,
            alternatives: [{ cause: 'VASOCONSTRICTION', probability: 0.12 }],
            supporting: [],
            contradicting: [],
          },
        }}
        isMonitoring
      />,
    );

    expect(html).not.toContain('También encaja');
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

  it("en modo srOnly no pinta tarjeta visible pero conserva el anuncio accesible", () => {
    const html = renderToStaticMarkup(
      <PressureCoach evidence={evidenceWith()} isMonitoring srOnly />,
    );
    // La tarjeta flotante tapaba la ventana de previsualizacion: en la app va
    // oculta a la vista (el texto ya vive dentro del canvas)...
    expect(html).toContain("sr-only");
    expect(html).not.toContain("absolute left-2 right-2");
    // ...pero el anuncio sigue existiendo para lectores de pantalla, porque el
    // texto del canvas no es accesible.
    expect(html).toContain("role=\"status\"");
    expect(html).toContain("aria-live=\"polite\"");
  });
});
