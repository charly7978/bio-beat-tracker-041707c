import React, { useState, useRef, useEffect, useCallback } from "react";
import { Heart, Sliders, Activity } from "lucide-react";
import CameraView, { CameraViewHandle } from "@/components/CameraView";
import { useSignalProcessor } from "@/hooks/useSignalProcessor";
import { useHeartBeatProcessor } from "@/hooks/useHeartBeatProcessor";
import { useVitalSignsProcessor } from "@/hooks/useVitalSignsProcessor";
import { useSaveMeasurement } from "@/hooks/useSaveMeasurement";
import { useHealthAnalysis } from "@/hooks/useHealthAnalysis";
import { useFrameLoop } from "@/hooks/useFrameLoop";
import { useSignalRouter } from "@/hooks/useSignalRouter";
import { useMeasurementSession } from "@/hooks/useMeasurementSession";
import { toast } from "@/hooks/use-toast";
import PPGSignalMeter from "@/components/PPGSignalMeter";
import { SettingsModal } from "@/components/SettingsModal";
import { ResultsModal } from "@/components/ResultsModal";
import { AIAnalysisModal } from "@/components/AIAnalysisModal";
import { DisclaimerModal } from "@/components/DisclaimerModal";
import { TelemedicineModal } from "@/components/TelemedicineModal";
import { resolveAcquisitionStatus } from "@/lib/acquisition/resolveAcquisitionStatus";
import { inferCameraRuntimeHints } from "@/lib/device/cameraDeviceProfile";
import { isNative } from "@/lib/device/platform";
import type { ContactState } from "@/types/signal";
import type { VitalSignsResult } from "@/modules/vital-signs/VitalSignsProcessor";
import { usePerfTelemetry } from "@/hooks/usePerfTelemetry";
import { triggerCalibrationCompleteHaptic } from "@/utils/haptics";
import { createLogger } from "@/utils/logger";

const log = createLogger('Index');

const Index = () => {
  // Canvas sincrónico (render-phase, fuera de effects)
  const cameraRef = useRef<CameraViewHandle>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const ppgMeterRef = useRef<import('@/components/PPGSignalMeter').PPGSignalMeterHandle>(null);

  if (!canvasRef.current && typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 240;
    canvasRef.current = c;
    ctxRef.current = c.getContext('2d', { willReadFrequently: !isNative(), alpha: false });
  }

  // Hooks de procesamiento
  const { 
    startProcessing, 
    stopProcessing, 
    lastSignal, 
    processFrame, 
    isProcessing: _isProcessing, 
    getRGBStats,
    getBackpressureState,
    getBackpressureConfig,
    currentStride,
    setSignalCallback,
    setCameraRuntimeHints,
  } = useSignalProcessor();

  const {
    processSignal: processHeartBeat,
    setFingerPlacementMode: setHeartBeatPlacementMode,
    setRuntimeHints: setHeartBeatRuntimeHints,
    reset: resetHeartBeat,
    reacquirePeaks: reacquireHeartPeaks,
  } = useHeartBeatProcessor();

  const { 
    processSignal: processVitalSigns,
    setPlacementMode: setVitalsPlacementMode,
    setRGBData,
    reset: resetVitalSigns,
    fullReset: fullResetVitalSigns,
    lastValidResults,
    startCalibration,
    forceCalibrationCompletion,
    getCalibrationProgress
  } = useVitalSignsProcessor();
  
  const { saveMeasurement } = useSaveMeasurement();
  const { analysis, isAnalyzing, analyzeVitals, clearAnalysis } = useHealthAnalysis();

  // Camera hints (shared)
  const cameraHintsRef = useRef(inferCameraRuntimeHints());
  const syncCameraHints = useCallback(() => {
    const d = cameraRef.current?.getDiagnostics?.() as Record<string, unknown> | undefined;
    if (!d?.active) return;
    cameraHintsRef.current = inferCameraRuntimeHints(d);
    setCameraRuntimeHints(d);
    setHeartBeatRuntimeHints(cameraHintsRef.current);
  }, [setCameraRuntimeHints, setHeartBeatRuntimeHints]);

  // Signal router (encapsula todo el routing de señal, throttling, latch, sanity)
  const router = useSignalRouter({
    processHeartBeat: {
      processSignal: processHeartBeat,
      setFingerPlacementMode: (mode) => { setHeartBeatPlacementMode(mode); },
      setRuntimeHints: setHeartBeatRuntimeHints,
      reacquirePeaks: reacquireHeartPeaks,
      reset: resetHeartBeat,
    },
    processVitalSigns: {
      processSignal: processVitalSigns,
      setPlacementMode: setVitalsPlacementMode,
      setRGBData,
      getRGBStats,
    },
    cameraHintsRef,
    ppgMeterRef,
  });

  // Frame loop
  const { startFrameLoop, stopFrameLoop } = useFrameLoop({
    cameraRef,
    canvasRef,
    ctxRef,
    processFrame,
  });

  // Session management
  const session = useMeasurementSession({
    cameraRef,
    startFrameLoop,
    stopFrameLoop,
    startProcessing,
    stopProcessing,
    startCalibration,
    forceCalibrationCompletion,
    resetVitalSigns,
    fullResetVitalSigns,
    resetHeartBeat,
    saveMeasurement,
    setCameraRuntimeHints,
    syncCameraHints,
    resetFingerContactSession: router.resetFingerContactSession,
    resetSessionRefs: router.resetSessionRefs,
    setShowResults: (v) => session.setLocalShowResults(v),
    setMeasurementSummary: (v) => session.setLocalMeasurementSummary(v),
    setHeartbeatSignal: (v) => router.setHeartbeatSignal(v),
    setBeatMarker: (v) => router.setBeatMarker(v),
    setRRIntervals: (v) => router.setRRIntervals(v),
    setVitalSigns: router.setVitalSigns,
    vitalSignsRef: router.vitalSignsRef,
    totalBeatsRef: router.totalBeatsRef,
    arrhythmiaBeatsRef: router.arrhythmiaBeatsRef,
    motionArtifactFramesRef: router.motionArtifactFramesRef,
    saturationFramesRef: router.saturationFramesRef,
    underexposedFramesRef: router.underexposedFramesRef,
    artifactCheckFramesRef: router.artifactCheckFramesRef,
    lastArrhythmiaData: router.lastArrhythmiaData,
    isMonitoringRef: router.isMonitoringRef,
    lastSignal,
    sanityProfileId: router.sanityProfileId,
    getBackpressureConfig,
    setHeartBeatRuntimeHints,
  });

  const setRouterIsMonitoringRef = router.setIsMonitoringRef;
  const setRouterVitalSigns = router.setVitalSigns;
  const setSessionResultsVisible = session.setLocalShowResults;

  // Conectar handleSignalRealtime al pipeline
  useEffect(() => {
    setSignalCallback(router.handleSignalRealtime);
    return () => setSignalCallback(null);
  }, [setSignalCallback, router.handleSignalRealtime]);

  // Sincronizar isMonitoringRef
  useEffect(() => {
    setRouterIsMonitoringRef(session.isMonitoring);
  }, [session.isMonitoring, setRouterIsMonitoringRef]);

  // Al estabilizarse el contacto, bloquear la exposición de la cámara a la
  // escena real del dedo iluminado. Frena la deriva del auto-exposure.
  const exposureLockedRef = useRef(false);
  const lastRawRedRef = useRef(0);
  if (typeof lastSignal?.rawRed === 'number') lastRawRedRef.current = lastSignal.rawRed;

  useEffect(() => {
    const cs = lastSignal?.contactState;
    if (cs === 'NO_CONTACT' || cs == null) {
      exposureLockedRef.current = false;
      return;
    }
    if (!exposureLockedRef.current && cs === 'STABLE_CONTACT') {
      exposureLockedRef.current = true;
      cameraRef.current?.optimizeForFinger?.(lastRawRedRef.current);
    }
  }, [lastSignal?.contactState]);

  // Sincronizar resultados post-medición
  useEffect(() => {
    if (lastValidResults && !session.isMonitoring) {
      setRouterVitalSigns(lastValidResults);
      setSessionResultsVisible(true);
    }
  }, [lastValidResults, session.isMonitoring, setRouterVitalSigns, setSessionResultsVisible]);

  // UI Modal states
  const [showAIAnalysis, setShowAIAnalysis] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTelemedicine, setShowTelemedicine] = useState(false);

  // Descargo de responsabilidad médica (persiste en localStorage)
  const [disclaimerAccepted, setDisclaimerAccepted] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem("disclaimer_accepted") === "true";
    }
    return false;
  });

  const handleAcceptDisclaimer = useCallback(() => {
    localStorage.setItem("disclaimer_accepted", "true");
    setDisclaimerAccepted(true);
  }, []);

  usePerfTelemetry({
    enabled: false,
    intervalMs: 15000,
    context: {
      getCamera: () => cameraRef.current?.getDiagnostics?.() ?? {},
      getPipeline: () => ({
        sqi: lastSignal?.quality ?? 0,
        fingerDetected: !!lastSignal?.fingerDetected,
        perfusionIndex: lastSignal?.perfusionIndex ?? 0,
        bpm: router.vitalSigns.heartRate.value,
        spo2: router.vitalSigns.spo2.value,
        confidence: router.vitalSigns.heartRate.status === 'VALID' ? 'HIGH' : 'INVALID',
        backpressure: getBackpressureState(),
      }),
    },
  });

  // Backpressure toast notification
  const prevStrideRef = useRef<number>(currentStride);
  useEffect(() => {
    if (session.isMonitoring && prevStrideRef.current === currentStride) return;
    const prev = prevStrideRef.current;
    prevStrideRef.current = currentStride;
    if (!session.isMonitoring || currentStride === prev) return;
    try {
      const cfg = getBackpressureConfig();
      if (typeof cfg.forceStride === 'number' || !cfg.enabled) return;
    } catch {
      log.warn('getBackpressureConfig failed');
      return;
    }
    if (currentStride > prev) {
      toast({
        title: "⚡ Modo ahorro activado",
        description: `Rendimiento bajo detectado (stride ${currentStride}).`,
        duration: 3000,
      });
    } else {
      toast({
        title: "✓ Rendimiento óptimo",
        description: `Muestreo completo restaurado.`,
        duration: 2500,
      });
    }
  }, [currentStride, session.isMonitoring, getBackpressureConfig]);

  // Adquisición status para UI
  const acquisitionStatusLabel = React.useMemo(() => {
    if (!lastSignal) return "WARMUP";
    const d = lastSignal.diagnostics as Record<string, unknown> | undefined;
    const sqm = d?.sqm as Record<string, number> | undefined;
    const cam = cameraRef.current?.getDiagnostics?.() as Record<string, unknown> | undefined;
    const cs: ContactState =
      lastSignal.contactState ??
      (lastSignal.fingerDetected ? "UNSTABLE_CONTACT" : "NO_CONTACT");
    return resolveAcquisitionStatus({
      contactState: cs,
      fingerDetected: !!lastSignal.fingerDetected,
      coverageRatio: (d?.coverageRatio as number) ?? 0,
      perfusionIndex: lastSignal.perfusionIndex ?? 0,
      motionScore: sqm?.motionScore ?? 0,
      saturationRatio: sqm?.saturationRatio ?? 0,
      underexposureRatio: sqm?.underexposureRatio ?? 0,
      fpsEffective: sqm?.fpsEffective ?? 30,
      frameDropRatio: sqm?.frameDropRatio ?? 0,
      timestampJitterMs: sqm?.timestampJitterMs ?? 0,
      torchActive: cam?.torchActive as boolean | undefined,
      torchSupported: cam?.torchSupported as boolean | undefined,
    });
  }, [lastSignal]);

  // Control de haptic al completar calibración
  useEffect(() => {
    if (!router.vitalSigns.isCalibrating) return;
    
    const interval = setInterval(() => {
      const currentProgress = getCalibrationProgress();
      if (currentProgress >= 100) {
        clearInterval(interval);
        void triggerCalibrationCompleteHaptic();
      }
    }, 500);

    return () => clearInterval(interval);
  }, [router.vitalSigns.isCalibrating, getCalibrationProgress]);

  // Toasts de error de cámara
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const errType = detail?.type;
      const titles: Record<string, string> = {
        permission_denied: "Permiso de cámara denegado",
        not_found: "No se encontró cámara trasera",
        not_readable: "Cámara en uso por otra aplicación",
        overconstrained: "Cámara no compatible",
        abort: "Inicio de cámara cancelado",
      };
      const descriptions: Record<string, string> = {
        permission_denied: "Concede el permiso en los ajustes de tu dispositivo.",
        not_found: "Asegúrate de que el dispositivo disponga de cámara trasera.",
        not_readable: "Cierra otras apps que utilicen la cámara e intenta de nuevo.",
        overconstrained: "Usando configuración compatible por defecto.",
        abort: "Intenta nuevamente.",
      };
      toast({
        title: titles[errType] || "Cámara trasera no disponible",
        description: descriptions[errType] || "Verifica los permisos de cámara e intenta nuevamente.",
        duration: 5000,
      });
    };
    window.addEventListener('camera-error', handler);
    return () => window.removeEventListener('camera-error', handler);
  }, []);

  const handleToggleMonitoring = () => {
    if (session.isMonitoring) {
      void session.finalizeMeasurement().catch(err => {
        log.error('Error finalizing measurement:', err);
      });
    } else {
      session.startMonitoring();
    }
  };

  const handleReset = () => {
    session.handleReset();
  };

  const handleCalibrationUpdated = useCallback((updatedSigns: Partial<VitalSignsResult>) => {
    router.setVitalSigns((prev) => ({
      ...prev,
      ...updatedSigns,
    }));
  }, [router]);

  return (
    <div className="fixed inset-0 flex flex-col bg-black" style={{ 
      height: '100svh',
      width: '100vw',
      maxWidth: '100vw',
      maxHeight: '100svh',
      overflow: 'hidden',
      touchAction: 'pan-y',
      overscrollBehavior: 'none',
      userSelect: 'none',
      WebkitTouchCallout: 'none',
      WebkitUserSelect: 'none'
    }}>
      {/* SPLASH / BOOT SCREEN — Portada de inicio limpia y profesional */}
      {!session.isFullscreen && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black animate-in fade-in duration-500 p-6">
          <div className="relative flex flex-col items-center max-w-sm text-center space-y-8">
            
            {/* Logo Pulsante con aura esmeralda suave */}
            <div className="relative">
              <div className="absolute inset-0 bg-emerald-500/20 blur-2xl rounded-full animate-pulse scale-150" />
              <div className="relative w-20 h-20 rounded-full border border-emerald-500/40 bg-emerald-950/20 flex items-center justify-center shadow-lg shadow-emerald-950/50">
                <Heart className="w-9 h-9 text-emerald-400 animate-pulse" fill="currentColor" />
              </div>
            </div>

            {/* Títulos limpios */}
            <div className="space-y-2">
              <h1 className="text-white text-xl font-bold tracking-[0.2em] uppercase">
                Bio-Beat Tracker
              </h1>
              <p className="text-emerald-400/80 text-xs font-medium tracking-wider">
                Monitor Fotopletismográfico de Pulso
              </p>
            </div>

            {/* Instrucción de uso rápida */}
            <div className="bg-zinc-950/80 border border-zinc-900 rounded-xl p-3.5 text-zinc-400 text-xs leading-relaxed max-w-xs">
              <p>
                Coloca la yema de tu dedo índice cubriendo suavemente la <span className="text-white font-medium">cámara trasera y el flash</span> para iniciar la lectura.
              </p>
            </div>

            {/* Botón de Entrada */}
            <button 
              onClick={session.enterFullScreen}
              className="w-full py-3.5 px-8 rounded-full bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white text-xs font-bold tracking-[0.2em] transition-all shadow-lg shadow-emerald-950/60"
            >
              INICIAR MONITOR
            </button>

            <p className="text-zinc-600 text-[9px] tracking-widest uppercase">
              Sensor Óptico PPG • Uso No Clínico
            </p>
          </div>
        </div>
      )}

      <div className="flex-1 relative">

        {/* CÁMARA TRASERA */}
        <div className="absolute inset-0">
          <CameraView 
            ref={cameraRef}
            onStreamReady={session.handleStreamReady}
            isMonitoring={session.isCameraOn}
          />
        </div>

        {/* BOTÓN AJUSTES */}
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          aria-label="Ajustes y Calibración"
          className="absolute top-3 right-3 z-30 p-2.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-zinc-300 hover:text-white hover:bg-black/80 hover:scale-105 active:scale-95 transition-all shadow-md"
        >
          <Sliders className="h-4 w-4" />
        </button>

        {/* BOTÓN TELEMEDICINA */}
        <button
          type="button"
          onClick={() => setShowTelemedicine(true)}
          aria-label="Telemedicina WebRTC"
          className="absolute top-3 right-14 z-30 p-2.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-emerald-400/90 hover:text-emerald-300 hover:bg-black/80 hover:scale-105 active:scale-95 transition-all shadow-md"
        >
          <Activity className="h-4 w-4" />
        </button>

        {/* MONITOR CARDÍACO Y CANVAS PPG */}
        <div className="relative z-10 h-full">
          <div className="flex-1 h-full">
            <PPGSignalMeter 
              ref={ppgMeterRef}
              value={router.heartbeatSignal}
              quality={lastSignal?.quality || 0}
              isFingerDetected={
                !!lastSignal?.fingerDetected &&
                lastSignal?.contactState !== 'NO_CONTACT'
              }
              onStartMeasurement={handleToggleMonitoring}
              onReset={handleReset}
              isMonitoring={session.isMonitoring}
              arrhythmiaStatus={router.vitalSigns.arrhythmia.value?.status ?? ''}
              rawArrhythmiaData={router.lastArrhythmiaData.current}
              preserveResults={session.showResults}
              isPeak={router.beatMarker === 1}
              bpm={router.vitalSigns.heartRate.value ?? null}
              spo2={router.vitalSigns.spo2.value || 0}
              arrhythmiaCount={router.vitalSigns.arrhythmia.value?.count ?? 0}
              rrIntervals={router.rrIntervals}
              elapsedTime={session.elapsedTime}
              perfusionIndex={lastSignal?.perfusionIndex || 0}
              pressure={{
                ...(router.vitalSigns.bloodPressure.value ?? { systolic: 0, diastolic: 0 }),
                confidence: router.vitalSigns.bloodPressure.status,
                featureQuality:
                  typeof router.vitalSigns.bloodPressure.diagnostics?.featureQuality === 'number'
                    ? router.vitalSigns.bloodPressure.diagnostics.featureQuality
                    : undefined,
              }}
              bpStatus={router.vitalSigns.bloodPressure.status}
              contactState={
                lastSignal?.contactState ??
                (lastSignal?.fingerDetected ? 'UNSTABLE_CONTACT' : 'NO_CONTACT')
              }
              acquisitionStatus={acquisitionStatusLabel}
              diagnostics={router.currentDiagnostics as unknown as import('@/components/PPGSignalMeter').PPGSignalMeterProps['diagnostics']}
            />
          </div>

          {/* MODAL: RESUMEN DE MEDICIÓN */}
          {session.showResults && session.measurementSummary && (
            <ResultsModal
              summary={session.measurementSummary}
              vitalSigns={router.vitalSigns}
              rrIntervals={router.rrIntervals}
              signalQuality={lastSignal?.quality || 0}
              isAnalyzing={isAnalyzing}
              onClose={() => {
                session.setLocalMeasurementSummary(null);
                session.setLocalShowResults(false);
              }}
              onAnalyzeAI={() => {
                analyzeVitals({ vitalSigns: router.vitalSigns, quality: lastSignal?.quality || 0 });
                setShowAIAnalysis(true);
              }}
            />
          )}

          {/* MODAL: ANÁLISIS AI */}
          <AIAnalysisModal
            isOpen={showAIAnalysis}
            isAnalyzing={isAnalyzing}
            analysis={analysis}
            onClose={() => {
              setShowAIAnalysis(false);
              clearAnalysis();
            }}
          />

          {/* MODAL: AJUSTES Y CALIBRACIÓN */}
          <SettingsModal
            isOpen={showSettings}
            onClose={() => setShowSettings(false)}
            lastValidResults={lastValidResults}
            onCalibrationUpdated={handleCalibrationUpdated}
          />

          {/* MODAL: TELEMEDICINA */}
          <TelemedicineModal
            isOpen={showTelemedicine}
            onClose={() => setShowTelemedicine(false)}
          />

          {/* MODAL: DESCARGO DE RESPONSABILIDAD MÉDICA */}
          <DisclaimerModal
            isOpen={!disclaimerAccepted}
            onAccept={handleAcceptDisclaimer}
          />

        </div>
      </div>
    </div>
  );
};

export default Index;
