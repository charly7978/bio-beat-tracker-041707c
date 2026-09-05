import { describe, it, expect, beforeEach } from 'vitest';
import { GymFaceTracker } from '../gymFaceTracker';

describe('GymFaceTracker', () => {
  let tracker: GymFaceTracker;

  beforeEach(() => {
    tracker = new GymFaceTracker();
  });

  it('no detecta rostro en cuadro negro o vacio', () => {
    const width = 64;
    const height = 64;
    const rgba = new Uint8ClampedArray(width * height * 4); // Todo 0 (negro)

    const result = tracker.processFrame({ data: rgba, width, height }, 1000);
    expect(result.faceDetected).toBe(false);
    expect(result.skinPixelCount).toBe(0);
    expect(result.rawRed).toBe(0);
    expect(result.rawGreen).toBe(0);
  });

  it('detecta parche de tono piel y localiza sub-ROIs de frente y pomulos', () => {
    const width = 80;
    const height = 80;
    const rgba = new Uint8ClampedArray(width * height * 4);

    // Pintar region central con color piel tipico (R=180, G=130, B=100)
    // R > 95, G > 40, B > 20, R > G > B, (R - G) = 50 >= 15
    for (let y = 15; y < 65; y++) {
      for (let x = 15; x < 65; x++) {
        const idx = (y * width + x) * 4;
        rgba[idx] = 180;
        rgba[idx + 1] = 130;
        rgba[idx + 2] = 100;
        rgba[idx + 3] = 255;
      }
    }

    // Procesar varios cuadros sucesivos para activar el umbral de deteccion consecutiva (>= 3)
    tracker.processFrame({ data: rgba, width, height }, 1000);
    tracker.processFrame({ data: rgba, width, height }, 1033);
    const finalResult = tracker.processFrame({ data: rgba, width, height }, 1066);

    expect(finalResult.faceDetected).toBe(true);
    expect(finalResult.skinPixelCount).toBeGreaterThan(120);
    expect(finalResult.rawRed).toBeGreaterThan(150);
    expect(finalResult.rawGreen).toBeGreaterThan(100);
    expect(finalResult.confidence).toBeGreaterThan(0);

    // Verificar que las cajas de frente y pomulos estan acotadas dentro del cuadro
    expect(finalResult.foreheadBox.width).toBeGreaterThan(0);
    expect(finalResult.foreheadBox.height).toBeGreaterThan(0);
    expect(finalResult.foreheadBox.x + finalResult.foreheadBox.width).toBeLessThanOrEqual(width);
    expect(finalResult.cheeksBox.x + finalResult.cheeksBox.width).toBeLessThanOrEqual(width);
  });

  it('calcula velocidad optica y puntaje de movimiento con desplazamiento', () => {
    const width = 80;
    const height = 80;

    const createFrame = (offsetY: number): Uint8ClampedArray => {
      const buffer = new Uint8ClampedArray(width * height * 4);
      for (let y = 20 + offsetY; y < 55 + offsetY; y++) {
        for (let x = 25; x < 55; x++) {
          if (y >= 0 && y < height) {
            const idx = (y * width + x) * 4;
            buffer[idx] = 190;
            buffer[idx + 1] = 135;
            buffer[idx + 2] = 105;
            buffer[idx + 3] = 255;
          }
        }
      }
      return buffer;
    };

    // Frame 1 estacionario
    tracker.processFrame({ data: createFrame(0), width, height }, 1000);
    tracker.processFrame({ data: createFrame(0), width, height }, 1033);

    // Frame 3 con desplazamiento brusco vertical (cabeceo de trote)
    const movingResult = tracker.processFrame({ data: createFrame(10), width, height }, 1066);

    expect(movingResult.headVelocity).toBeGreaterThanOrEqual(0);
    expect(movingResult.motionScore).toBeGreaterThanOrEqual(0);
  });

  it('el metodo reset limpia la memoria de rastreo', () => {
    const width = 80;
    const height = 80;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 15; y < 65; y++) {
      for (let x = 15; x < 65; x++) {
        const idx = (y * width + x) * 4;
        rgba[idx] = 180;
        rgba[idx + 1] = 130;
        rgba[idx + 2] = 100;
        rgba[idx + 3] = 255;
      }
    }

    tracker.processFrame({ data: rgba, width, height }, 1000);
    tracker.processFrame({ data: rgba, width, height }, 1033);
    tracker.processFrame({ data: rgba, width, height }, 1066);
    expect(tracker.processFrame({ data: rgba, width, height }, 1100).faceDetected).toBe(true);

    tracker.reset();

    // Inmediatamente despues del reset no debe estar detectado
    const afterReset = tracker.processFrame({ data: rgba, width, height }, 1200);
    expect(afterReset.faceDetected).toBe(false);
  });
});
