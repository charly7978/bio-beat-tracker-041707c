import { useRef, useCallback } from 'react';
import type { CameraViewHandle } from '@/components/CameraView';
import { ppgPerf, logWarn } from '@/utils/logger';

interface UseFrameLoopInput {
  cameraRef: React.RefObject<CameraViewHandle>;
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  ctxRef: React.MutableRefObject<CanvasRenderingContext2D | null>;
  processFrame: (imageData: ImageData, timestamp?: number) => void;
}

/**
 * Bucle de captura ligado al frame del vídeo (`requestVideoFrameCallback` con
 * respaldo `requestAnimationFrame` throttleado), con garantías honestas:
 *
 * - El callback RVFC se cancela SIEMPRE sobre el MISMO elemento <video> que lo
 *   registró (se conserva referencia vinculada); cambiar de cámara sin esto
 *   dejaba callbacks huérfanos del vídeo anterior.
 * - Fotogramas duplicados o antiguos (misma marca temporal o retroceso del
 *   reloj) se descartan antes de llegar al worker: evita procesar dos veces el
 *   mismo frame y corromper la estimación de FPS/jitter. O(1) por frame.
 * - `lastTs` se resetea en cada arranque para no descartar el primer frame
 *   tras un cambio de cámara.
 */
export function useFrameLoop({ cameraRef, canvasRef, ctxRef, processFrame }: UseFrameLoopInput) {
  const frameLoopRef = useRef<number | null>(null);
  const videoFrameLoopRef = useRef<number | null>(null);
  /** Vídeo sobre el que se registró el RVFC pendiente (cancelación correcta). */
  const boundVideoRef = useRef<HTMLVideoElement | null>(null);
  const isProcessingRef = useRef(false);
  const lastRafTsRef = useRef<number>(0);
  const lastFrameTsRef = useRef<number>(-Infinity);

  const startFrameLoop = useCallback(() => {
    if (isProcessingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    isProcessingRef.current = true;
    lastRafTsRef.current = 0;
    lastFrameTsRef.current = -Infinity;
    boundVideoRef.current = null;

    const captureOneFrame = (frameTimestampMs?: number) => {
      if (!isProcessingRef.current) return;
      const video = cameraRef.current?.getVideoElement();
      if (!video || video.readyState < 2 || video.videoWidth === 0) {
        frameLoopRef.current = requestAnimationFrame(captureOneFrame);
        return;
      }
      // Si el elemento cambió bajo nuestros pies (cambio de cámara), el loop
      // viejo se detiene: el nuevo arranque es el único dueño del pipeline.
      if (boundVideoRef.current !== null && boundVideoRef.current !== video) {
        return;
      }
      const ts =
        typeof frameTimestampMs === 'number' && Number.isFinite(frameTimestampMs)
          ? frameTimestampMs
          : performance.now();
      // Descarta duplicados/antiguos: el worker solo ve tiempo monotónico
      // estrictamente creciente. Sin esto, un rAF repetido tras RVFC
      // procesaba el mismo frame dos veces (FPS inflado, jitter falso).
      if (!(ts > lastFrameTsRef.current)) {
        scheduleNext(video);
        return;
      }
      lastFrameTsRef.current = ts;
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        processFrame(imageData, ts);
      } catch {
        logWarn('useFrameLoop', 'drawImage/getImageData failed (video teardown)');
      }
      scheduleNext(video);
    };

    const scheduleNext = (video: HTMLVideoElement) => {
      if (!isProcessingRef.current) return;
      const vAny = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
      };
      if (typeof vAny.requestVideoFrameCallback === 'function') {
        boundVideoRef.current = video;
        videoFrameLoopRef.current = vAny.requestVideoFrameCallback((now, metadata) => {
          ppgPerf.markFrame(metadata);
          const ts =
            typeof now === 'number' && Number.isFinite(now)
              ? now
              : performance.now();
          captureOneFrame(ts);
        });
      } else {
        boundVideoRef.current = null;
        const tick = (ts: number) => {
          if (!isProcessingRef.current) return;
          if (ts - lastRafTsRef.current < 28) {
            frameLoopRef.current = requestAnimationFrame(tick);
            return;
          }
          lastRafTsRef.current = ts;
          ppgPerf.markFrame();
          captureOneFrame(ts);
        };
        frameLoopRef.current = requestAnimationFrame(tick);
      }
    };

    captureOneFrame(performance.now());
  }, [cameraRef, canvasRef, ctxRef, processFrame]);

  const stopFrameLoop = useCallback(() => {
    isProcessingRef.current = false;
    // Cancelar sobre el vídeo vinculado (no sobre el actual, que puede ser otro
    // tras un cambio de cámara): así no quedan callbacks huérfanos emitiendo.
    const bound = boundVideoRef.current as (HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void }) | null;
    if (videoFrameLoopRef.current !== null && bound && typeof bound.cancelVideoFrameCallback === 'function') {
      try { bound.cancelVideoFrameCallback(videoFrameLoopRef.current); } catch { logWarn('useFrameLoop', 'cancelVideoFrameCallback failed'); }
      videoFrameLoopRef.current = null;
    } else if (videoFrameLoopRef.current !== null) {
      const video = cameraRef.current?.getVideoElement() as (HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void }) | null;
      if (video && typeof video.cancelVideoFrameCallback === 'function') {
        try { video.cancelVideoFrameCallback(videoFrameLoopRef.current); } catch { logWarn('useFrameLoop', 'cancelVideoFrameCallback failed'); }
      }
      videoFrameLoopRef.current = null;
    }
    boundVideoRef.current = null;
    lastFrameTsRef.current = -Infinity;
    if (frameLoopRef.current) {
      cancelAnimationFrame(frameLoopRef.current);
      frameLoopRef.current = null;
    }
  }, [cameraRef]);

  return { startFrameLoop, stopFrameLoop, isProcessingRef };
}
