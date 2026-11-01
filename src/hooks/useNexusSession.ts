import { useCallback, useEffect, useRef, useState } from 'react';
import { logWarn } from '@/utils/logger';
import type { ProcessedSignal } from '@/types/signal';
import { PPGSignalProcessor } from '@/modules/signal-processing/PPGSignalProcessor';
import { loadBackpressureConfig } from '@/lib/perf/backpressureConfig';
import {
  negotiateProximalCapture,
  readProximalEnv,
  releaseProximalStream,
} from '@/lib/device/dualCameraBridge';
import {
  NexusSessionEngine,
  createIdleNexusSnapshot,
  type NexusSessionSnapshot,
} from '@/lib/vitals/nexusSessionEngine';
import { CalibrationManager } from '@/modules/vital-signs/CalibrationManager';
import {
  UNCALIBRATED_PTT_MODEL,
  type PttPersonalModel,
} from '@/lib/vitals/nexusFusionCore';



/**
 * USE NEXUS SESSION — Orquestación del modo dual cara+dedo (F2, blueprint)
 * =======================================================================
 * Capa delgada de React sobre piezas ya (a) negociadoras del puente
 * `dualCameraBridge` (única apertura del frontal; la trasera sigue siendo
 * exclusiva de CameraView), (b) del extractor facial en hilo principal —
 * la MISMA clase PPGSignalProcessor del fallback del repo, modo 'gym' —
 * y (c) del motor de sesión `nexusSessionEngine`, que conecta ambos feeds al
 * pipeline oficial `deriveCrossSiteObservation` (sin DSP duplicado).
 *
 * Contrato de degradación honesto: cada intento fallido publica SU motivo
 * técnico (permiso, dispositivo ausente, API indisponible); el snapshot del
 * motor es la única fuente de estado mostrada. La señal del sitio distal
 * entra por `pushDistalSignal` desde el callback caliente del router.
 */
export interface UseNexusSessionResult {
  /** Estado de la sesión dual (motor); nunca se inventa un τ sin evidencia. */
  snapshot: NexusSessionSnapshot;
  /** true con stream frontal abierto y extractor facial corriendo. */
  proximalActive: boolean;
  /** Nivel de captura logrado por el puente ('L2' feria / 'L0' degradado). */
  captureLevel: 'L0' | 'L2';
  /** Motivo técnico de la negociación (constantes del bridge). */
  captureReason: string;
  startProximalCapture: () => Promise<void>;
  stopProximalCapture: () => void;
  /** Conexión con el callback caliente del router (canal distal). */
  pushDistalSignal: (signal: ProcessedSignal) => void;
}

export function useNexusSession(): UseNexusSessionResult {
  const [snapshot, setSnapshot] = useState<NexusSessionSnapshot>(createIdleNexusSnapshot);
  const [proximalActive, setProximalActive] = useState(false);
  const [captureLevel, setCaptureLevel] = useState<'L0' | 'L2'>('L0');
  const [captureReason, setCaptureReason] = useState('SIN_INTENTO_DE_CAPTURA');

  const engineRef = useRef<NexusSessionEngine | null>(null);
  const processorRef = useRef<PPGSignalProcessor | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastSnapshotKeyRef = useRef<string>('');
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  const getEngine = useCallback(() => {
    if (!engineRef.current) {
      const calibrated = CalibrationManager.getInstance().getActiveNexusPttModel();
      const personalModel: PttPersonalModel = calibrated ?? UNCALIBRATED_PTT_MODEL;
      engineRef.current = new NexusSessionEngine({ personalModel });
    }
    return engineRef.current;
  }, []);

  /** Publica el snapshot solo si cambió algo visible (sin render por frame). */
  const publishSnapshot = useCallback((snap: NexusSessionSnapshot) => {
    const key = [
      snap.status,
      snap.reason,
      snap.tauMs === null ? '' : String(Math.round(snap.tauMs)),
      snap.coherenceLevel ?? '',
      snap.coherenceScore ?? '',
    ].join('|');
    if (key === lastSnapshotKeyRef.current) return;
    lastSnapshotKeyRef.current = key;
    setSnapshot(snap);
  }, []);

  /** Conexión del canal distal: el router llama esto con cada ProcessedSignal. */
  const pushDistalSignal = useCallback(
    (signal: ProcessedSignal) => {
      const engine = engineRef.current;
      if (!engine) return; // NEXUS no armado: el modo dedo sigue intacto
      engine.pushDistal({
        tsMs: signal.timestamp,
        value: signal.filteredValue,
        contactOk: !!signal.fingerDetected && signal.contactState !== 'NO_CONTACT',
      });
      publishSnapshot(engine.maybeEvaluate(signal.timestamp));
    },
    [publishSnapshot],
  );

  const startProximalCapture = useCallback(async () => {
    const engine = getEngine();
    engine.activate();

    // 1) Negociación del stream frontal (puente; trasera = CameraView)
    const result = await negotiateProximalCapture(readProximalEnv());
    engine.setProximalCapture(result.level, result.proximalStream !== null, result.reason);
    setCaptureLevel(result.level);
    setCaptureReason(result.reason);
    if (!result.proximalStream) {
      logWarn('useNexusSession', `captura proximal no disponible: ${result.reason}`);
      publishSnapshot(engine.maybeEvaluate(performance.now()));
      return;
    }

    // 2) Extractor facial en hilo principal (misma clase del fallback del repo)
    try {
      const processor = new PPGSignalProcessor(
        (facialSignal) => {
          const live = engineRef.current;
          if (!live) return;
          live.pushProximal({
            tsMs: facialSignal.timestamp,
            value: facialSignal.filteredValue,
            faceSeen: facialSignal.faceDetected === true,
          });
          publishSnapshot(live.maybeEvaluate(facialSignal.timestamp));
        },
        (error) => {
          logWarn('useNexusSession', `extractor facial error: ${error.code} ${error.message}`);
        },
      );
      processor.setMeasurementMode('gym');
      processor.setBackpressureConfig(loadBackpressureConfig());
      processor.start();
      processorRef.current = processor;

      // 3) Bucle de frames del frontal: drawImage → getImageData → procesador
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = result.proximalStream;
      await video.play().catch(() => {
        logWarn('useNexusSession', 'play() del frontal difirió (autopermiso); el bucle espera frames');
      });
      videoRef.current = video;

      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 120;
      canvasRef.current = canvas;
      ctxRef.current = canvas.getContext('2d', { willReadFrequently: true, alpha: false });

      const tick = (): void => {
        const v = videoRef.current;
        const cv = canvasRef.current;
        const ctx = ctxRef.current;
        if (!v || !cv || !ctx) return;
        if (v.readyState >= 2 && v.videoWidth > 0) {
          try {
            ctx.drawImage(v, 0, 0, cv.width, cv.height);
            const imageData = ctx.getImageData(0, 0, cv.width, cv.height);
            processorRef.current?.processFrame(imageData, performance.now());
          } catch {
            logWarn('useNexusSession', 'frame facial fallido (teardown del vídeo)');
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);

      streamRef.current = result.proximalStream;
      setProximalActive(true);
    } catch (startError) {
      logWarn('useNexusSession', 'inicio del extractor proximal falló', startError);
      releaseProximalStream(result.proximalStream);
      streamRef.current = null;
      engine.setProximalCapture('L0', false, 'APERTURA_FALLIDA');
      engine.deactivate();
      setCaptureLevel('L0');
      setCaptureReason('APERTURA_FALLIDA');
      setProximalActive(false);
      lastSnapshotKeyRef.current = '';
      setSnapshot(engine.snapshot());
    }
  }, [getEngine, publishSnapshot]);

  const stopProximalCapture = useCallback(() => {
    const raf = rafRef.current;
    if (raf !== null) {
      cancelAnimationFrame(raf);
      rafRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      try {
        video.srcObject = null;
      } catch {
        // El cierre del vídeo no debe interrumpir la liberación.
      }
      videoRef.current = null;
    }
    canvasRef.current = null;
    ctxRef.current = null;
    const processor = processorRef.current;
    if (processor) {
      try {
        processor.stop();
      } catch {
        // mismo criterio
      }
      processorRef.current = null;
    }
    const stream = streamRef.current;
    if (stream) {
      releaseProximalStream(stream);
      streamRef.current = null;
    }
    setProximalActive(false);
    const engine = engineRef.current;
    if (engine) {
      engine.deactivate();
      lastSnapshotKeyRef.current = '';
      setSnapshot(engine.snapshot());
    }
    setCaptureLevel('L0');
    setCaptureReason('SESION_DETENIDA');
  }, []);

  // Limpieza al desmontar (término de sesión de medición o recarga de página)
  useEffect(() => {
    return () => {
      stopProximalCapture();
    };
  }, [stopProximalCapture]);

  return {
    snapshot,
    proximalActive,
    captureLevel,
    captureReason,
    startProximalCapture,
    stopProximalCapture,
    pushDistalSignal,
  };
}
