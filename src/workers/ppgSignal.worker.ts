import { PPGSignalProcessor } from '../modules/signal-processing/PPGSignalProcessor';
import type { ProcessedSignal, ProcessingError } from '../types/signal';
import type { CameraCaptureState, MotionObservation } from '../types/measurements';

let processor: PPGSignalProcessor | null = null;

// Escuchar mensajes del hilo principal
self.onmessage = async (event: MessageEvent) => {
  const { type, data } = event.data;

  try {
    switch (type) {
      case 'init': {
        const onSignalReady = (signal: ProcessedSignal) => {
          // Serializar el resultado junto con las estadísticas necesarias
          self.postMessage({
            type: 'signalReady',
            data: {
              signal,
              rgbStats: processor ? processor.getRGBStats() : null,
              backpressureState: processor ? processor.getBackpressureState() : null
            }
          });
        };

        const onError = (error: ProcessingError) => {
          self.postMessage({
            type: 'error',
            data: error
          });
        };

        processor = new PPGSignalProcessor(onSignalReady, onError);
        if (data?.backpressureConfig) {
          processor.setBackpressureConfig(data.backpressureConfig);
        }
        self.postMessage({ type: 'initialized' });
        break;
      }

      case 'start':
        if (processor) {
          processor.start();
          self.postMessage({ type: 'started' });
        }
        break;

      case 'stop':
        if (processor) {
          processor.stop();
          self.postMessage({ type: 'stopped' });
        }
        break;

      case 'processFrame': {
        if (!processor || !processor.isProcessing) {
          self.postMessage({ type: 'frameProcessed' });
          return;
        }
        const { imageData, timestamp, captureState } = data as { imageData: ImageData; timestamp?: number; captureState?: CameraCaptureState };
        try {
          processor.processFrame(imageData, timestamp, captureState);
        } finally {
          // ACK único por frame: signalReady es dato, frameProcessed es control
          // de flujo. Así un error accesorio nunca libera dos veces la misma imagen.
          self.postMessage({ type: 'frameProcessed' });
        }
        break;
      }

      case 'motion': {
        if (!processor) return;
        // Mantener el reloj de la página: también es el de processFrame(timestamp).
        processor.ingestMotionSample(data as MotionObservation);
        break;
      }

      case 'setCameraRuntimeHints':
        if (processor) {
          processor.setCameraRuntimeHints(data);
        }
        break;

      case 'setBackpressureConfig':
        if (processor) {
          const newCfg = processor.setBackpressureConfig(data);
          self.postMessage({
            type: 'backpressureConfigChanged',
            data: newCfg
          });
        }
        break;

      default:
        // Tipo de mensaje no reconocido - ignorado silenciosamente
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      data: {
        code: 'WORKER_INTERNAL_ERROR',
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
};

