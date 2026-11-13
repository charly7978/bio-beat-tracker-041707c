import { useRef, useCallback } from 'react';
import type { CameraViewHandle } from '@/components/CameraView';
import { acceptVideoFrame, createVideoFrameIdentityState, resolveFrameClock } from '@/lib/device/frameClock';
import { ppgPerf, logWarn } from '@/utils/logger';

interface UseFrameLoopInput {
  cameraRef: React.RefObject<CameraViewHandle>;
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  ctxRef: React.MutableRefObject<CanvasRenderingContext2D | null>;
  processFrame: (imageData: ImageData, timestamp?: number) => void;
}

export function useFrameLoop({ cameraRef, canvasRef, ctxRef, processFrame }: UseFrameLoopInput) {
  const frameLoopRef = useRef<number | null>(null);
  const videoFrameLoopRef = useRef<number | null>(null);
  const isProcessingRef = useRef(false);
  const frameIdentityRef = useRef(createVideoFrameIdentityState());
  const generationRef = useRef(0);
  const lastRafTsRef = useRef<number>(0);

  const startFrameLoop = useCallback(() => {
    if (isProcessingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    isProcessingRef.current = true;
    const generation = ++generationRef.current;
    frameIdentityRef.current = createVideoFrameIdentityState();
    lastRafTsRef.current = 0;

    const captureOneFrame = (frameTimestampMs?: number, metadata?: { presentedFrames?: number; mediaTime?: number }) => {
      if (!isProcessingRef.current || generation !== generationRef.current) return;
      const video = cameraRef.current?.getVideoElement();
      if (!video || video.readyState < 2 || video.videoWidth === 0) {
        frameLoopRef.current = requestAnimationFrame(captureOneFrame);
        return;
      }
      try {
        const identity = metadata ?? {
          presentedFrames: video.getVideoPlaybackQuality?.().totalVideoFrames,
          mediaTime: video.currentTime,
        };
        if (!acceptVideoFrame(frameIdentityRef.current, identity)) {
          scheduleNext(video);
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        processFrame(imageData, frameTimestampMs);
      } catch {
        logWarn('useFrameLoop', 'drawImage/getImageData failed (video teardown)');
      }
      scheduleNext(video);
    };

    const scheduleNext = (video: HTMLVideoElement) => {
      if (!isProcessingRef.current || generation !== generationRef.current) return;
      const vAny = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
      };
      if (typeof vAny.requestVideoFrameCallback === 'function') {
        videoFrameLoopRef.current = vAny.requestVideoFrameCallback((now, metadata) => {
          if (!isProcessingRef.current || generation !== generationRef.current) return;
          // Timestamp de sub-frame por hardware: `captureTime` es el instante real
          // de captura del sensor y `presentationTime` el de entrega a composición
          // (misma base monótona que performance.now(), precisión de µs). `now` es
          // el despacho del callback en el event loop y arrastra su jitter a la fs
          // estimada y a los RR. `resolveFrameClock` elige el reloj más fiel con
          // guarda de base temporal y cae a `now` solo si el UA no informa nada.
          const clock = resolveFrameClock(metadata, now, performance.now());
          ppgPerf.markFrame(metadata, clock.timestamp);
          captureOneFrame(clock.timestamp, metadata);
        });
      } else {
        const tick = (ts: number) => {
          if (!isProcessingRef.current || generation !== generationRef.current) return;
          if (ts - lastRafTsRef.current < 28) {
            frameLoopRef.current = requestAnimationFrame(tick);
            return;
          }
          lastRafTsRef.current = ts;
          ppgPerf.markFrame(undefined, ts);
          captureOneFrame(ts);
        };
        frameLoopRef.current = requestAnimationFrame(tick);
      }
    };

    captureOneFrame(performance.now());
  }, [cameraRef, canvasRef, ctxRef, processFrame]);

  const stopFrameLoop = useCallback(() => {
    isProcessingRef.current = false;
    generationRef.current++;
    const video = cameraRef.current?.getVideoElement() as (HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void }) | null;
    if (videoFrameLoopRef.current !== null && typeof video?.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(videoFrameLoopRef.current);
      videoFrameLoopRef.current = null;
    }
    if (frameLoopRef.current) {
      cancelAnimationFrame(frameLoopRef.current);
      frameLoopRef.current = null;
    }
  }, [cameraRef]);

  return { startFrameLoop, stopFrameLoop, isProcessingRef };
}

