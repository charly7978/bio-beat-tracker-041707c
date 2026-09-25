
import { useState, useEffect, useCallback, useRef } from 'react';
import type { ProcessedSignal, ProcessingError, MeasurementMode } from '../types/signal';
import {
  loadBackpressureConfig,
  saveBackpressureConfig,
  type BackpressureConfig,
} from '../lib/perf/backpressureConfig';
import { createLogger } from '../utils/logger';

const log = createLogger('useSignalProcessor');

/**
 * Hook que adapta el procesamiento de PPG a través de un Web Worker en un hilo separado.
 * Mantiene compatibilidad total con la interfaz del hilo principal de React.
 */
export const useSignalProcessor = () => {
  const workerRef = useRef<Worker | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const isProcessingRef = useRef(false);
  const [measurementMode, setMeasurementModeState] = useState<MeasurementMode>('finger');
  const measurementModeRef = useRef<MeasurementMode>('finger');
  const [lastSignal, setLastSignal] = useState<ProcessedSignal | null>(null);
  const [currentStride, setCurrentStride] = useState<number>(3);

  // Guardar estadísticas recibidas del Worker para resolver getters síncronos
  const rgbStatsRef = useRef({
    redAC: 0,
    redDC: 0,
    greenAC: 0,
    greenDC: 0,
    blueAC: 0,
    blueDC: 0,
    rgRatio: 0,
    ratioOfRatios: 0
  });

  const backpressureStateRef = useRef({
    pixelStride: 3,
    estimatedSampleRate: 0,
    activeSource: 'RG',
    config: loadBackpressureConfig()
  });

  // Hot-path callback: corre por cada frame SIN pasar por React.
  const realtimeCbRef = useRef<((s: ProcessedSignal) => void) | null>(null);
  // Throttle del snapshot UI (lastSignal): ~10 Hz es suficiente para HUD.
  const lastUiPushRef = useRef<number>(0);
  const UI_SNAPSHOT_INTERVAL_MS = 100;
  /**
   * CONTRAPRESIÓN EXPLÍCITA (cola acotada de capacidad 1 + descarte):
   * `postMessage` al worker es una cola NO acotada: a 30 fps con un móvil
   * lento el worker acumula mensajes y la latencia supera el borde vivo de
   * emisión (1200 ms) → todos los picos caducan como NO_NEW_PEAK. Con un solo
   * frame en vuelo, el productor (rAF/RVFC) descarta el frame nuevo mientras
   * el worker procesa (drop-newest, O(1)): la latencia queda acotada a un
   * tiempo de proceso y el FPS efectivo baja con elegancia en vez de
   * acumular deuda. El descarte se contabiliza para diagnóstico.
   */
  const frameInFlightRef = useRef(false);
  const frameInFlightAtRef = useRef(0);
  const droppedFramesRef = useRef(0);
  const lastDropLogAtRef = useRef(0);
  /** El worker tarda > este tiempo ⇒ se considera atascado y se resincroniza. */
  const IN_FLIGHT_STALE_MS = 500;
  const lastUiContactRef = useRef<{ finger: boolean; contact: string }>({
    finger: false,
    contact: 'NO_CONTACT',
  });

  // Single-instance lifecycle guard.
  const initializationState = useRef<'IDLE' | 'INITIALIZING' | 'READY' | 'ERROR'>('IDLE');
  const pendingStartRef = useRef(false);

  useEffect(() => {
    if (initializationState.current !== 'IDLE') {
      return;
    }

    initializationState.current = 'INITIALIZING';

    try {
      // Instanciar el Web Worker compatible con Vite y TypeScript
      workerRef.current = new Worker(
        new URL('../workers/ppgSignal.worker.ts', import.meta.url),
        { type: 'module' }
      );

      workerRef.current.onmessage = (event: MessageEvent) => {
        const { type, data } = event.data;

        if (type === 'initialized') {
          initializationState.current = 'READY';
          if (pendingStartRef.current && !isProcessingRef.current && workerRef.current) {
            isProcessingRef.current = true;
            setIsProcessing(true);
            workerRef.current.postMessage({ type: 'start' });
            log.info('PPG Web Worker inicializado y arrancado por solicitud pendiente');
          }
        } else if (type === 'signalReady') {
          if (initializationState.current !== 'READY') return;
          const { signal, rgbStats, backpressureState } = data;
          // El worker terminó: la ranura de vuelo queda libre.
          frameInFlightRef.current = false;

          // Actualizar las caches de telemetría
          if (rgbStats) rgbStatsRef.current = rgbStats;
          if (backpressureState) {
            backpressureStateRef.current = backpressureState;
            setCurrentStride((prev) => (prev !== backpressureState.pixelStride ? backpressureState.pixelStride : prev));
          }

          // 1) Hot path: callback síncrono (DSP, ringbuffers, refs en Index).
          const cb = realtimeCbRef.current;
          if (cb) {
            try { cb(signal); } catch {
              log.warn('Realtime callback threw — signal may be stale');
            }
          }

          // 2) Snapshot UI throttleado a ~10 Hz para HUD/diagnóstico.
          const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
          const contactChanged =
            signal.fingerDetected !== lastUiContactRef.current.finger ||
            signal.contactState !== lastUiContactRef.current.contact;
          if (contactChanged) {
            lastUiContactRef.current = {
              finger: signal.fingerDetected,
              contact: signal.contactState,
            };
            lastUiPushRef.current = nowMs;
            setLastSignal(signal);
          } else if (nowMs - lastUiPushRef.current >= UI_SNAPSHOT_INTERVAL_MS) {
            lastUiPushRef.current = nowMs;
            setLastSignal(signal);
          }
        } else if (type === 'backpressureConfigChanged') {
          if (data) {
            backpressureStateRef.current.config = data;
          }
        } else if (type === 'error') {
          const err = data as ProcessingError;
          console.error(`PPGSignalProcessor Web Worker error: ${err.code} ${err.message}`);
        }
      };

      // Inicializar el procesador dentro del worker
      workerRef.current.postMessage({
        type: 'init',
        data: {
          backpressureConfig: loadBackpressureConfig()
        }
      });
    } catch (e) {
      log.error('Failed to initialize PPG Web Worker:', e);
      initializationState.current = 'ERROR';
    }

    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      initializationState.current = 'IDLE';
    };
  }, []);

  // Listener de movimiento en el hilo principal
  useEffect(() => {
    if (!isProcessing) return;

    let motionListenerActive = false;

    const handleMotionEvent = (event: DeviceMotionEvent) => {
      const acc = event.accelerationIncludingGravity;
      const rot = event.rotationRate;

      workerRef.current?.postMessage({
        type: 'motion',
        data: {
          accelerationIncludingGravity: acc ? { x: acc.x, y: acc.y, z: acc.z } : null,
          rotationRate: rot ? { alpha: rot.alpha, beta: rot.beta, gamma: rot.gamma } : null
        }
      });
    };

    try {
      if (typeof DeviceMotionEvent !== 'undefined') {
        const dme = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
        if (typeof dme.requestPermission === 'function') {
          dme.requestPermission()
            .then((state: string) => {
              if (state === 'granted') {
                window.addEventListener('devicemotion', handleMotionEvent, { passive: true });
                motionListenerActive = true;
              }
            })
            .catch(() => { log.warn('DeviceMotion permission denied'); });
        } else {
          window.addEventListener('devicemotion', handleMotionEvent, { passive: true });
          motionListenerActive = true;
        }
      }
    } catch {
      log.warn('DeviceMotionEvent not supported on this device');
    }

    return () => {
      if (motionListenerActive) {
        window.removeEventListener('devicemotion', handleMotionEvent);
      }
    };
  }, [isProcessing]);

  const startProcessing = useCallback(() => {
    pendingStartRef.current = true;
    if (!workerRef.current || initializationState.current !== 'READY') {
      log.info('startProcessing solicitado mientras worker inicializa — encolado');
      return;
    }
    if (isProcessingRef.current) {
      return;
    }
    isProcessingRef.current = true;
    setIsProcessing(true);
    workerRef.current.postMessage({ type: 'start' });
  }, []);

  /** Reset duro del procesador (fin de sesión o cambio de cámara). */
  const resetProcessor = useCallback(() => {
    rgbStatsRef.current = {
      redAC: 0, redDC: 0, greenAC: 0, greenDC: 0, blueAC: 0, blueDC: 0,
      rgRatio: 0, ratioOfRatios: 0,
    };
    lastUiPushRef.current = 0;
    lastUiContactRef.current = { finger: false, contact: 'NO_CONTACT' };
    // Liberar la ranura de vuelo: el reset del worker descarta trabajo previo.
    frameInFlightRef.current = false;
    workerRef.current?.postMessage({ type: 'reset' });
  }, []);

  const stopProcessing = useCallback(() => {
    pendingStartRef.current = false;
    isProcessingRef.current = false;
    setIsProcessing(false);
    frameInFlightRef.current = false;
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'stop' });
    }
    setLastSignal(null);
    lastUiPushRef.current = 0;
    lastUiContactRef.current = { finger: false, contact: 'NO_CONTACT' };
    rgbStatsRef.current = {
      redAC: 0, redDC: 0, greenAC: 0, greenDC: 0, blueAC: 0, blueDC: 0,
      rgRatio: 0, ratioOfRatios: 0,
    };
  }, []);

  const processFrame = useCallback((imageData: ImageData, frameTimestampMs?: number) => {
    if (!workerRef.current || initializationState.current !== 'READY' || !isProcessingRef.current) {
      return;
    }

    // Contrapresión: si hay un frame en vuelo, descartar el nuevo (drop-newest)
    // en vez de encolar deuda. Resincronizar si la ranura lleva demasiado
    // tiempo ocupada (worker atascado o mensaje perdido).
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (frameInFlightRef.current) {
      if (nowMs - frameInFlightAtRef.current < IN_FLIGHT_STALE_MS) {
        droppedFramesRef.current += 1;
        if (nowMs - lastDropLogAtRef.current > 5000) {
          lastDropLogAtRef.current = nowMs;
          log.info(`Backpressure: ${droppedFramesRef.current} frames descartados (worker saturado)`);
        }
        return;
      }
      frameInFlightRef.current = false;
    }
    frameInFlightRef.current = true;
    frameInFlightAtRef.current = nowMs;

    // Transferir el buffer de píxeles (Uint8ClampedArray.buffer) de forma eficiente sin copiar
    const buffer = imageData.data.buffer;
    try {
      workerRef.current.postMessage({
        type: 'processFrame',
        data: {
          imageData,
          timestamp: frameTimestampMs
        }
      }, [buffer]);
    } catch {
      // El buffer puede estar detached si el frame se reutilizó: liberar ranura.
      frameInFlightRef.current = false;
      log.warn('processFrame postMessage failed (detached buffer) — frame descartado');
    }
  }, []);

  const getRGBStats = useCallback(() => {
    return rgbStatsRef.current;
  }, []);

  const getBackpressureState = useCallback(() => {
    return backpressureStateRef.current;
  }, []);

  const getBackpressureConfig = useCallback((): BackpressureConfig => {
    return backpressureStateRef.current.config;
  }, []);

  /** Frames descartados por contrapresión (cola acotada) desde el arranque. */
  const getDroppedFrames = useCallback((): number => {
    return droppedFramesRef.current;
  }, []);

  const setCameraRuntimeHints = useCallback((diag: Record<string, unknown> | null | undefined) => {
    workerRef.current?.postMessage({
      type: 'setCameraRuntimeHints',
      data: diag
    });
  }, []);

  const setBackpressureConfig = useCallback((partial: Partial<BackpressureConfig>): BackpressureConfig => {
    const nextCfg = { ...backpressureStateRef.current.config, ...partial };
    saveBackpressureConfig(nextCfg);
    backpressureStateRef.current.config = nextCfg;
    
    workerRef.current?.postMessage({
      type: 'setBackpressureConfig',
      data: partial
    });
    
    return nextCfg;
  }, []);

  const setSignalCallback = useCallback((cb: ((s: ProcessedSignal) => void) | null) => {
    realtimeCbRef.current = cb;
  }, []);

  const setMeasurementMode = useCallback((mode: MeasurementMode) => {
    measurementModeRef.current = mode;
    setMeasurementModeState(mode);
    // El cambio de modo invalida el frame en vuelo del modo anterior.
    frameInFlightRef.current = false;
    workerRef.current?.postMessage({
      type: 'setMeasurementMode',
      data: mode,
    });
    log.info(`useSignalProcessor: Modo enviado al worker: ${mode}`);
  }, []);

  return {
    isProcessing,
    lastSignal,
    currentStride,
    measurementMode,
    setMeasurementMode,
    startProcessing,
    stopProcessing,
    processFrame,
    getRGBStats,
    getBackpressureState,
    getBackpressureConfig,
    getDroppedFrames,
    setBackpressureConfig,
    setCameraRuntimeHints,
    setSignalCallback,
    resetProcessor,
  };
};
