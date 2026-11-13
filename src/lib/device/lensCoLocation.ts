/**
 * Profiling de co-ubicación lente ↔ flash (diagnóstico fotométrico de arranque).
 *
 * En smartphones con 2–4 cámaras traseras, `facingMode: environment` NO garantiza
 * la lente principal: Chrome puede abrir la gran angular o el teleobjetivo en
 * Samsung/Huawei, y las etiquetas de `enumerateDevices` dependen del vendor y del
 * locale (no se puede filtrar por string de label). El proxy web fiable de "lente
 * adyacente al flash" es que el torch de esa track ilumine el tejido.
 *
 * Este escaneo mide el flujo lumínico de los primeros ~500 ms tras encender el
 * torch y clasifica la colocación del dedo:
 *
 *  - `finger-flash-lens`: dedo sobre la lente junto al flash. La luz LED atraviesa
 *    el tejido → rojo alto con dominancia roja y ratios R/G y R/B que cumplen la
 *    firma de hemoglobina ya validada en `VITAL_THRESHOLDS.FINGER` (misma fuente
 *    de verdad que `PPGSignalProcessor`; no se duplican umbrales).
 *  - `lens-covered-dark`: frame casi negro con torch activo → el dedo está sobre
 *    una lente alejada del LED (ultra gran angular / tele) o el flash no llegó.
 *    Es el caso que genera la alerta al usuario.
 *  - `scene-visible`: sin dedo; se ve la escena.
 *  - `indeterminate`: ventana insuficiente, torch sin confirmar u oscuridad sin
 *    torch (no se puede atribuir a lente equivocada).
 *
 * ES SOLO DIAGNÓSTICO DE COLOCACIÓN: no filtra ni altera la señal de medición (los
 * gates fisiológicos siguen en `PPGSignalProcessor`), no retrasa `onStreamReady`
 * y no avanza ningún filtro de estado dentro de React.
 */
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { createLogger } from '@/utils/logger';

const log = createLogger('lensCoLocation');

export type LensVerdict =
  | 'finger-flash-lens'  // dedo sobre la lente adyacente al flash
  | 'lens-covered-dark'  // lente cubierta a oscuras con torch activo (lente equivocada)
  | 'scene-visible'      // sin dedo: se ve la escena
  | 'indeterminate';     // ventana insuficiente / torch sin confirmar / oscuridad sin torch

export interface LuminousSample {
  tMs: number;
  /** Media del canal rojo 0–255 sobre la grilla de muestreo. */
  red: number;
  green: number;
  blue: number;
}

export interface LensScanResult {
  verdict: LensVerdict;
  torchOn: boolean;
  durationMs: number;
  samples: number;
  /** Rojo medio de la parte asentada de la ventana (último 60 %). */
  redMean: number;
  /** red − (green + blue)/2 sobre la parte asentada. */
  redDominance: number;
  /** Subida de luma (r+g+b) dentro de la ventana: el "flujo" del torch encendiéndose. */
  lumaRise: number;
  message?: string;
}

const DARK_TOTAL_SUM = 30; // misma semántica "casi negro" que la calibración ZLO de PPGSignalProcessor
const MIN_SAMPLES = 4;
const SETTLED_FRACTION = 0.4; // el AE/driver se asienta tras encender el torch; mide el último 60 %

/**
 * Clasificador puro del flujo lumínico. `torchOn` debe reflejar si el torch fue
 * confirmado vía `getSettings()` (no solo "se envió la constraint").
 */
export function classifyLuminousFlow(
  samples: LuminousSample[],
  torchOn: boolean,
): Omit<LensScanResult, 'torchOn' | 'durationMs'> {
  if (samples.length < MIN_SAMPLES) {
    return {
      verdict: 'indeterminate',
      samples: samples.length,
      redMean: 0,
      redDominance: 0,
      lumaRise: 0,
      message: 'ventana insuficiente',
    };
  }

  const settled = samples.slice(Math.floor(samples.length * SETTLED_FRACTION));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const redMean = mean(settled.map(s => s.red));
  const greenMean = mean(settled.map(s => s.green));
  const blueMean = mean(settled.map(s => s.blue));
  const redDominance = redMean - (greenMean + blueMean) / 2;
  const lumaOf = (s: LuminousSample) => s.red + s.green + s.blue;
  const lumaRise = lumaOf(settled[settled.length - 1]) - lumaOf(samples[0]);
  const base = { samples: samples.length, redMean, redDominance, lumaRise };

  // Frame casi negro: con torch confirmado es dedo sobre lente SIN aporte del
  // flash (lente equivocada); sin torch no se puede culpar a la lente.
  if (redMean + greenMean + blueMean < DARK_TOTAL_SUM) {
    return torchOn
      ? { ...base, verdict: 'lens-covered-dark', message: 'lente cubierta a oscuras con torch activo' }
      : { ...base, verdict: 'indeterminate', message: 'oscuro sin torch: no atribuible a lente equivocada' };
  }

  // Firma de hemoglobina (adquisición suave ya validada en VITAL_THRESHOLDS.FINGER):
  // la MISMA que el pipeline exige para aceptar un dedo iluminado por el flash.
  const F = VITAL_THRESHOLDS.FINGER;
  const rgRatio = greenMean > 1 ? redMean / greenMean : 0;
  const rbRatio = blueMean > 1 ? redMean / blueMean : 0;
  if (
    torchOn &&
    redMean >= F.ACQUIRE_SOFT_MIN_RED &&
    rgRatio >= F.ACQUIRE_SOFT_RG &&
    rbRatio >= F.ACQUIRE_SOFT_RB &&
    redDominance >= F.ACQUIRE_SOFT_DOMINANCE
  ) {
    return { ...base, verdict: 'finger-flash-lens' };
  }

  return { ...base, verdict: 'scene-visible' };
}

/**
 * Escaneo de los primeros `durationMs` ms de frames REALES del `<video>` ya
 * encendido con torch. Auto-terminado (no deja timers vivos) y degradado a
 * `indeterminate` si el video/canvas no está disponible. No toca el canvas ni
 * los buffers del pipeline de medición.
 */
export async function startLensCoLocationScan(
  video: HTMLVideoElement,
  opts: { torchOn: boolean; durationMs?: number },
): Promise<LensScanResult> {
  const torchOn = opts.torchOn;
  const durationMs = opts.durationMs ?? 500;
  const fail = (message: string): LensScanResult => ({
    verdict: 'indeterminate',
    torchOn,
    durationMs,
    samples: 0,
    redMean: 0,
    redDominance: 0,
    lumaRise: 0,
    message,
  });

  if (!video || video.readyState < 2 || video.videoWidth === 0) {
    return fail('video no listo');
  }

  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return fail('canvas 2d no disponible');

  const t0 = performance.now();
  const samples: LuminousSample[] = [];
  let cancelled = false;
  let rafHandle = 0;
  let rvfcHandle = 0;
  const vAny = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };

  const sampleOne = () => {
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      let sumR = 0, sumG = 0, sumB = 0, n = 0;
      for (let i = 0; i < d.length; i += 64) { // grilla dispersa: 1 de cada 16 px
        sumR += d[i];
        sumG += d[i + 1];
        sumB += d[i + 2];
        n++;
      }
      samples.push({
        tMs: performance.now() - t0,
        red: sumR / n,
        green: sumG / n,
        blue: sumB / n,
      });
    } catch {
      // teardown del stream a mitad del escaneo: se cierra con lo acumulado
      cancelled = true;
    }
  };

  const cleanup = () => {
    if (rvfcHandle && typeof vAny.cancelVideoFrameCallback === 'function') {
      try { vAny.cancelVideoFrameCallback(rvfcHandle); } catch { /* ya cancelado */ }
    }
    if (rafHandle) cancelAnimationFrame(rafHandle);
  };

  await new Promise<void>(resolve => {
    const step = () => {
      if (cancelled) { resolve(); return; }
      const elapsed = performance.now() - t0;
      if (elapsed >= durationMs) { resolve(); return; }
      sampleOne();
      if (cancelled) { resolve(); return; }
      if (typeof vAny.requestVideoFrameCallback === 'function') {
        rvfcHandle = vAny.requestVideoFrameCallback(() => step());
      } else {
        rafHandle = requestAnimationFrame(() => step());
      }
    };
    step();
  });
  cleanup();

  const classified = classifyLuminousFlow(samples, torchOn);
  const result: LensScanResult = {
    ...classified,
    torchOn,
    durationMs,
  };
  log.info(
    `Co-ubicación lente/flash: ${result.verdict} (rojo=${result.redMean.toFixed(0)}, dom=${result.redDominance.toFixed(0)}, Δluma=${result.lumaRise.toFixed(0)}, muestras=${result.samples})`,
  );
  return result;
}
