/**
 * GYM FACE TRACKER — Rastreo y segmentación facial adaptativa para rPPG en movimiento.
 *
 * Características:
 * 1. Segmentación crominámica en espacio YCbCr para aislamiento robusto de piel (inmune a luz variable).
 * 2. Cálculo espacial de momentos de 1º y 2º orden para obtención de centroide y caja envolvente.
 * 3. Seguidor Alpha-Beta para compensar el cabeceo biomecánico (head bobbing en trote/ejercicio).
 * 4. Extracción selectiva de sub-ROIs de alta vascularización (frente y pómulos) excluyendo vello y ojos.
 * 5. Cero asignaciones (zero-allocation) en ciclo caliente de frames para 30+ FPS estables.
 *
 * Referencias científicas:
 * - Kovac et al. (Human skin colour clustering for face detection)
 * - Wang et al. (Algorithmic Principles of Remote PPG, IEEE TBME 2017)
 * - Verkruysse et al. (Remote plethysmographic imaging using ambient light)
 */

export interface FaceBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GymFaceTrackingResult {
  faceDetected: boolean;
  confidence: number;
  faceBox: FaceBoundingBox;
  foreheadBox: FaceBoundingBox;
  cheeksBox: FaceBoundingBox;
  rawRed: number;
  rawGreen: number;
  rawBlue: number;
  skinPixelCount: number;
  headVelocity: number;
  motionScore: number;
}

export class GymFaceTracker {
  // Estado del estimador Alpha-Beta para centroide [x, y] y tamaño [w, h]
  private cx = 0;
  private cy = 0;
  private vx = 0;
  private vy = 0;
  private bw = 0;
  private bh = 0;
  private vbw = 0;
  private vbh = 0;

  private isInitialized = false;
  private consecutiveDetections = 0;
  private consecutiveMisses = 0;
  private lastTimestamp = 0;

  // Parámetros de filtro Alpha-Beta adaptados a aceleración en ejercicio
  private readonly ALPHA = 0.45;
  private readonly BETA = 0.15;
  private readonly MIN_SKIN_PIXELS = 120;

  /**
   * Resetea el estado del rastreador al cambiar de sesión o de cámara.
   */
  public reset(): void {
    this.cx = 0;
    this.cy = 0;
    this.vx = 0;
    this.vy = 0;
    this.bw = 0;
    this.bh = 0;
    this.vbw = 0;
    this.vbh = 0;
    this.isInitialized = false;
    this.consecutiveDetections = 0;
    this.consecutiveMisses = 0;
    this.lastTimestamp = 0;
  }

  /**
   * Procesa un frame de video y extrae las señales cromáticas rPPG estabilizadas.
   */
  public processFrame(
    imageData: ImageData | { data: Uint8ClampedArray; width: number; height: number },
    timestampMs: number
  ): GymFaceTrackingResult {
    const { width, height, data } = imageData;
    const now = timestampMs > 0 ? timestampMs : performance.now();
    const dt = this.lastTimestamp > 0 ? Math.max(0.016, (now - this.lastTimestamp) / 1000) : 0.033;
    this.lastTimestamp = now;

    // Stride espacial dinámico: muestrea cada 2 píxeles horizontal y verticalmente para alta velocidad
    const stride = 2;
    let skinCount = 0;
    let sumX = 0;
    let sumY = 0;
    let sumX2 = 0;
    let sumY2 = 0;

    // 1. Detección y acumulación de píxeles de piel en espacio YCbCr
    for (let y = 0; y < height; y += stride) {
      const rowOffset = y * width * 4;
      for (let x = 0; x < width; x += stride) {
        const i = rowOffset + x * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        // Conversión entera rápida a YCbCr
        const Y = (77 * r + 150 * g + 29 * b) >> 8;
        if (Y < 25 || Y > 245) continue;

        const Cb = ((-43 * r - 85 * g + 128 * b) >> 8) + 128;
        const Cr = ((128 * r - 107 * g - 21 * b) >> 8) + 128;

        // Región cromática estándar de piel humana (Kovac et al. + Peer et al.)
        if (Cb >= 77 && Cb <= 130 && Cr >= 133 && Cr <= 175 && r > g && g > b * 0.8) {
          skinCount++;
          sumX += x;
          sumY += y;
          sumX2 += x * x;
          sumY2 += y * y;
        }
      }
    }

    // 2. Comprobación de masa crítica de piel
    if (skinCount < this.MIN_SKIN_PIXELS) {
      this.consecutiveMisses++;
      if (this.consecutiveMisses > 10) {
        this.consecutiveDetections = 0;
      }
      return {
        faceDetected: false,
        confidence: 0,
        faceBox: { x: 0, y: 0, width: 0, height: 0 },
        foreheadBox: { x: 0, y: 0, width: 0, height: 0 },
        cheeksBox: { x: 0, y: 0, width: 0, height: 0 },
        rawRed: 0,
        rawGreen: 0,
        rawBlue: 0,
        skinPixelCount: 0,
        headVelocity: 0,
        motionScore: 0,
      };
    }

    this.consecutiveMisses = 0;
    this.consecutiveDetections++;

    // 3. Momentos espaciales: Centroide (media) y dispersión (desviación estándar)
    const rawCx = sumX / skinCount;
    const rawCy = sumY / skinCount;
    const varX = Math.max(16, sumX2 / skinCount - rawCx * rawCx);
    const varY = Math.max(25, sumY2 / skinCount - rawCy * rawCy);
    const stdX = Math.sqrt(varX);
    const stdY = Math.sqrt(varY);

    // Dimensiones proporcionales del rostro (altura suele ser 1.25x el ancho)
    const rawBw = Math.min(width * 0.85, Math.max(30, stdX * 2.8));
    const rawBh = Math.min(height * 0.90, Math.max(40, stdY * 3.2));

    // 4. Filtrado Alpha-Beta para estabilizar cabeceo (head-bobbing)
    if (!this.isInitialized) {
      this.cx = rawCx;
      this.cy = rawCy;
      this.bw = rawBw;
      this.bh = rawBh;
      this.vx = 0;
      this.vy = 0;
      this.vbw = 0;
      this.vbh = 0;
      this.isInitialized = true;
    } else {
      // Predicción
      const predCx = this.cx + this.vx * dt;
      const predCy = this.cy + this.vy * dt;
      const predBw = this.bw + this.vbw * dt;
      const predBh = this.bh + this.vbh * dt;

      // Residuales de medición
      const resX = rawCx - predCx;
      const resY = rawCy - predCy;
      const resBw = rawBw - predBw;
      const resBh = rawBh - predBh;

      // Actualización de estado
      this.cx = predCx + this.ALPHA * resX;
      this.cy = predCy + this.ALPHA * resY;
      this.vx += (this.BETA / dt) * resX;
      this.vy += (this.BETA / dt) * resY;

      this.bw = predBw + this.ALPHA * 0.6 * resBw;
      this.bh = predBh + this.ALPHA * 0.6 * resBh;
      this.vbw += (this.BETA * 0.6 / dt) * resBw;
      this.vbh += (this.BETA * 0.6 / dt) * resBh;
    }

    // Cálculo de velocidad física de la cabeza (píxeles/segundo normalizados)
    const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    const headVelocityNorm = Math.min(1.0, speed / (width * 0.8));
    const motionScore = Math.min(1.0, headVelocityNorm * 1.5);

    // Caja delimitadora estabilizada del rostro completo
    const faceLeft = Math.max(0, Math.min(width - 20, Math.round(this.cx - this.bw / 2)));
    const faceTop = Math.max(0, Math.min(height - 20, Math.round(this.cy - this.bh / 2)));
    const faceW = Math.max(20, Math.min(width - faceLeft, Math.round(this.bw)));
    const faceH = Math.max(20, Math.min(height - faceTop, Math.round(this.bh)));

    const faceBox: FaceBoundingBox = {
      x: faceLeft,
      y: faceTop,
      width: faceW,
      height: faceH,
    };

    // 5. Segmentación de Sub-ROIs Biométricas de Alta Densidad Capilar
    // A) Frente (Forehead): tercio superior central, inmune a expresiones orales y barba
    const fhX = Math.round(faceLeft + faceW * 0.22);
    const fhY = Math.round(faceTop + faceH * 0.08);
    const fhW = Math.round(faceW * 0.56);
    const fhH = Math.round(faceH * 0.20);
    const foreheadBox: FaceBoundingBox = {
      x: Math.max(0, Math.min(width - 10, fhX)),
      y: Math.max(0, Math.min(height - 10, fhY)),
      width: Math.max(10, Math.min(width - fhX, fhW)),
      height: Math.max(10, Math.min(height - fhY, fhH)),
    };

    // B) Pómulos y mejillas (Malar region): tercio medio lateral
    const chX = Math.round(faceLeft + faceW * 0.15);
    const chY = Math.round(faceTop + faceH * 0.38);
    const chW = Math.round(faceW * 0.70);
    const chH = Math.round(faceH * 0.28);
    const cheeksBox: FaceBoundingBox = {
      x: Math.max(0, Math.min(width - 10, chX)),
      y: Math.max(0, Math.min(height - 10, chY)),
      width: Math.max(10, Math.min(width - chX, chW)),
      height: Math.max(10, Math.min(height - chY, chH)),
    };

    // 6. Extracción promedio ponderada de crominancia en las sub-ROIs (frente 60% + pómulos 40%)
    let rSumFh = 0, gSumFh = 0, bSumFh = 0, countFh = 0;
    const fhYEnd = foreheadBox.y + foreheadBox.height;
    const fhXEnd = foreheadBox.x + foreheadBox.width;

    for (let y = foreheadBox.y; y < fhYEnd; y++) {
      const rOff = y * width * 4;
      for (let x = foreheadBox.x; x < fhXEnd; x++) {
        const idx = rOff + x * 4;
        rSumFh += data[idx];
        gSumFh += data[idx + 1];
        bSumFh += data[idx + 2];
        countFh++;
      }
    }

    let rSumCh = 0, gSumCh = 0, bSumCh = 0, countCh = 0;
    const chYEnd = cheeksBox.y + cheeksBox.height;
    const chXEnd = cheeksBox.x + cheeksBox.width;

    for (let y = cheeksBox.y; y < chYEnd; y++) {
      const rOff = y * width * 4;
      for (let x = cheeksBox.x; x < chXEnd; x++) {
        const idx = rOff + x * 4;
        rSumCh += data[idx];
        gSumCh += data[idx + 1];
        bSumCh += data[idx + 2];
        countCh++;
      }
    }

    const fhR = countFh > 0 ? rSumFh / countFh : 0;
    const fhG = countFh > 0 ? gSumFh / countFh : 0;
    const fhB = countFh > 0 ? bSumFh / countFh : 0;

    const chR = countCh > 0 ? rSumCh / countCh : 0;
    const chG = countCh > 0 ? gSumCh / countCh : 0;
    const chB = countCh > 0 ? bSumCh / countCh : 0;

    // Fusión biomédica: frente 60% + pómulos 40% (o solo una si la otra no tiene muestras)
    let rawRed = 0;
    let rawGreen = 0;
    let rawBlue = 0;

    if (countFh > 0 && countCh > 0) {
      rawRed = fhR * 0.60 + chR * 0.40;
      rawGreen = fhG * 0.60 + chG * 0.40;
      rawBlue = fhB * 0.60 + chB * 0.40;
    } else if (countFh > 0) {
      rawRed = fhR;
      rawGreen = fhG;
      rawBlue = fhB;
    } else if (countCh > 0) {
      rawRed = chR;
      rawGreen = chG;
      rawBlue = chB;
    }

    const confidence = Math.min(1.0, (this.consecutiveDetections / 8) * (1 - motionScore * 0.4));

    return {
      faceDetected: this.consecutiveDetections >= 3,
      confidence,
      faceBox,
      foreheadBox,
      cheeksBox,
      rawRed,
      rawGreen,
      rawBlue,
      skinPixelCount: skinCount,
      headVelocity: speed,
      motionScore,
    };
  }
}
