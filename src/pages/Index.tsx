import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Heart, AlertTriangle, Activity, X, Shield, Clock, CheckCircle2, XCircle, Brain, Loader2, Sliders, User, Check } from "lucide-react";
import CameraView, { CameraViewHandle } from "@/components/CameraView";
import { CalibrationManager } from "@/modules/vital-signs/CalibrationManager";
import type { VitalSignsResult } from "@/modules/vital-signs/VitalSignsProcessor";
import { supabase } from "@/integrations/supabase/client";
import { useSignalProcessor } from "@/hooks/useSignalProcessor";
import { useHeartBeatProcessor } from "@/hooks/useHeartBeatProcessor";
import { useVitalSignsProcessor } from "@/hooks/useVitalSignsProcessor";
import { useSaveMeasurement, decryptLocalMeasurements } from "@/hooks/useSaveMeasurement";
import { toast } from "@/hooks/use-toast";
import { healthBridge } from "@/lib/capacitor/healthBridge";
import { useHealthAnalysis } from "@/hooks/useHealthAnalysis";
import { useFrameLoop } from "@/hooks/useFrameLoop";
import { useSignalRouter } from "@/hooks/useSignalRouter";
import { useMeasurementSession } from "@/hooks/useMeasurementSession";
import PPGSignalMeter from "@/components/PPGSignalMeter";
import { PoincarePlot } from "@/components/PoincarePlot";
import { WebrtcCallWidget } from "@/components/WebrtcCallWidget";
import { resolveAcquisitionStatus } from "@/lib/acquisition/resolveAcquisitionStatus";
import { inferCameraRuntimeHints } from "@/lib/device/cameraDeviceProfile";
import type { ContactState } from "@/types/signal";
import { usePerfTelemetry } from "@/hooks/usePerfTelemetry";
import { triggerCalibrationCompleteHaptic } from "@/utils/haptics";
import { createLogger } from "@/utils/logger";

const log = createLogger('Index');

interface ActiveUser {
  id: string;
  email?: string;
}

interface HistoricalMeasurement {
  id: string;
  heart_rate: number;
  spo2: number;
  systolic: number;
  diastolic: number;
  arrhythmia_count: number;
  quality: number;
  measured_at: string;
  isCloud?: boolean;
}

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
    ctxRef.current = c.getContext('2d', { willReadFrequently: true, alpha: false });
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
    resetProcessor,
    measurementMode,
    setMeasurementMode,
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
    setLastValidResults,
    startCalibration,
    forceCalibrationCompletion,
    syncAnthropometric,
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

  const processHeartBeatApi = useMemo(() => ({
    processSignal: processHeartBeat,
    setFingerPlacementMode: (mode: import('@/types/signal').FingerPlacementMode) => { setHeartBeatPlacementMode(mode); },
    setRuntimeHints: setHeartBeatRuntimeHints,
    reacquirePeaks: reacquireHeartPeaks,
    reset: resetHeartBeat,
  }), [processHeartBeat, setHeartBeatPlacementMode, setHeartBeatRuntimeHints, reacquireHeartPeaks, resetHeartBeat]);

  const processVitalSignsApi = useMemo(() => ({
    processSignal: processVitalSigns,
    setPlacementMode: setVitalsPlacementMode,
    setRGBData,
    getRGBStats,
  }), [processVitalSigns, setVitalsPlacementMode, setRGBData, getRGBStats]);

  // Signal router (encapsula todo el routing de señal, throttling, latch, sanity)
  const router = useSignalRouter({
    processHeartBeat: processHeartBeatApi,
    processVitalSigns: processVitalSignsApi,
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
    resetProcessor,
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

  // Conectar handleSignalRealtime al pipeline
  useEffect(() => {
    setSignalCallback(router.handleSignalRealtime);
    return () => setSignalCallback(null);
  }, [setSignalCallback, router.handleSignalRealtime]);

  // Sincronizar isMonitoringRef
  useEffect(() => {
    router.setIsMonitoringRef(session.isMonitoring);
  }, [session.isMonitoring, router]);

  // Al estabilizarse el contacto, bloquear la exposición de la cámara a la
  // escena real del dedo iluminado. Frena la deriva del auto-exposure (causa del
  // arranque errático de ~25-30 s). Se re-arma al perder el contacto.
  const exposureLockedRef = useRef(false);
  // Ref con el último rojo medido: el effect de abajo lo lee en la transición a
  // STABLE_CONTACT sin depender de él (no re-ejecuta por frame ni queda obsoleto).
  const lastRawRedRef = useRef(0);
  if (typeof lastSignal?.rawRed === 'number') lastRawRedRef.current = lastSignal.rawRed;
  useEffect(() => {
    const cs = lastSignal?.contactState;
    if (cs === 'NO_CONTACT' || cs == null) {
      exposureLockedRef.current = false;
      return;
    }
    if (!exposureLockedRef.current && cs === 'STABLE_CONTACT' && measurementMode !== 'gym') {
      exposureLockedRef.current = true;
      // Acción concreta sobre el hardware: foco cercano + WB bloqueado + exposición
      // auto-optimizada según el nivel REAL del rojo del dedo (no un valor fijo).
      cameraRef.current?.optimizeForFinger?.(lastRawRedRef.current);
    }
  }, [lastSignal?.contactState, measurementMode]);

  // Sincronizar resultados post-medición
  const { setVitalSigns: routerSetVitalSigns } = router;
  const { setLocalShowResults: sessionSetLocalShowResults } = session;
  useEffect(() => {
    if (lastValidResults && !session.isMonitoring) {
      routerSetVitalSigns(lastValidResults);
      sessionSetLocalShowResults(true);
    }
  }, [lastValidResults, session.isMonitoring, routerSetVitalSigns, sessionSetLocalShowResults]);

  // UI states
  const [showAIAnalysis, setShowAIAnalysis] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTelemedicine, setShowTelemedicine] = useState(false);
  const [webgpuAvail, setWebgpuAvail] = useState<'checking' | 'yes' | 'no'>('checking');
  const [healthAvail, setHealthAvail] = useState<'checking' | 'yes' | 'no'>('checking');
  const [encryptionReady, setEncryptionReady] = useState(false);
  const [riskResult, setRiskResult] = useState<string | null>(null);
  const [age, setAge] = useState<string>("35");
  const [height, setHeight] = useState<string>("172");
  const [weight, setWeight] = useState<string>("70");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [refSys, setRefSys] = useState<string>("");
  const [refDia, setRefDia] = useState<string>("");
  const [refSpo2, setRefSpo2] = useState<string>("");

  // --- PRODUCTION AND COMMERCIAL FEATURES ---
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

  const [activeTab, setActiveTab] = useState<'profile' | 'calibration' | 'history' | 'account'>('profile');
  const [history, setHistory] = useState<HistoricalMeasurement[]>([]);
  const [currentUser, setCurrentUser] = useState<ActiveUser | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');

  const fetchHistory = useCallback(async () => {
    try {
      const localData = await decryptLocalMeasurements();
      const typedLocal = localData as HistoricalMeasurement[];
      const formattedLocal = typedLocal.map((m: HistoricalMeasurement) => ({
        ...m,
        isCloud: false,
      }));

      const { data: { user } } = await supabase.auth.getUser();
      let cloudData: HistoricalMeasurement[] = [];
      if (user) {
        const { data, error } = await supabase
          .from("measurements")
          .select("*")
          .eq("user_id", user.id)
          .order("measured_at", { ascending: false });
        if (!error && data) {
          cloudData = data.map((m: HistoricalMeasurement) => ({
            ...m,
            isCloud: true,
          }));
        }
      }

      const combined = [...formattedLocal, ...cloudData].sort(
        (a, b) => new Date(b.measured_at).getTime() - new Date(a.measured_at).getTime()
      );
      setHistory(combined);
    } catch (err) {
      log.error("Error fetching history:", err);
    }
  }, []);

  const handleClearHistory = useCallback(() => {
    if (window.confirm("¿Estás seguro de que quieres borrar el historial local de este dispositivo?")) {
      localStorage.removeItem("local_measurements");
      localStorage.removeItem("bb-crypto-key");
      fetchHistory();
    }
  }, [fetchHistory]);

  const handleExportCSV = useCallback(() => {
    if (history.length === 0) {
      alert("No hay mediciones en el historial para exportar.");
      return;
    }
    // RFC 4180: comillas dobles escapadas como "" y campos siempre entrecomillados.
    const esc = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`;
    // 0 = métrica no disponible (nunca se exporta como medición clínica).
    const vitalsCell = (v: number | null | undefined): string =>
      v != null && v > 0 ? String(Math.round(v)) : 'no disponible';
    const rows: string[] = [
      'Fecha,Origen,Pulso (bpm),SpO2 (%),Presion Sistolica (mmHg),Presion Diastolica (mmHg),Latidos Irregulares',
    ];

    history.forEach((m) => {
      const date = new Date(m.measured_at).toISOString();
      const origin = m.isCloud ? "Nube" : "Local";
      const hr = vitalsCell(m.heart_rate);
      const spo2 = vitalsCell(m.spo2);
      const sys = vitalsCell(m.systolic);
      const dia = vitalsCell(m.diastolic);
      const arr = m.arrhythmia_count ?? 0;
      rows.push([esc(date), esc(origin), hr, spo2, sys, dia, String(arr)].join(','));
    });
    // Nota de honestidad: las estimaciones no equivalen a medición clínica.
    rows.push(esc('NOTA: SpO2/PA son estimaciones experimentales de bienestar, no mediciones clinicas. "no disponible" = sin senal suficiente o sin referencia vigente.'));

    // BOM UTF-8 para que Excel/libros abran tildes correctamente.
    const csvContent = '﻿' + rows.join('\r\n') + '\r\n';
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `historial_bio_beat_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, [history]);

  const handleAuth = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      alert("Por favor rellene todos los campos.");
      return;
    }
    setAuthLoading(true);
    try {
      if (authMode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        alert("Sesión iniciada correctamente.");
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
        });
        if (error) throw error;
        alert("Registro completado. Por favor revisa tu correo electrónico para confirmar la cuenta.");
      }
      setEmail("");
      setPassword("");
    } catch (error: unknown) {
      const err = error as Error;
      alert(err.message || "Error al procesar la autenticación");
    } finally {
      setAuthLoading(false);
    }
  }, [email, password, authMode]);

  const handleSignOut = useCallback(async () => {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      alert("Sesión cerrada.");
    } catch (error: unknown) {
      const err = error as Error;
      alert(err.message || "Error al cerrar sesión");
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setCurrentUser(session?.user ?? null);
      fetchHistory();
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setCurrentUser(session?.user ?? null);
      fetchHistory();
    });

    return () => subscription.unsubscribe();
  }, [fetchHistory]);

  useEffect(() => {
    if (showSettings) {
      fetchHistory();
    }
  }, [showSettings, fetchHistory]);

  // Check WebGPU availability
  useEffect(() => {
    if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gpu = (navigator as any).gpu;
      if (gpu) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        gpu.requestAdapter().then((adapter: any) => {
          setWebgpuAvail(adapter ? 'yes' : 'no');
        }).catch(() => setWebgpuAvail('no'));
      } else {
        setWebgpuAvail('no');
      }
    } else {
      setWebgpuAvail('no');
    }
  }, []);

  // Check Health Connect availability
  useEffect(() => {
    healthBridge.checkAvailability().then(avail => {
      setHealthAvail(avail ? 'yes' : 'no');
    }).catch(() => setHealthAvail('no'));
  }, []);

  // Check if encryption key exists (means crypto was initialized)
  useEffect(() => {
    const check = () => setEncryptionReady(localStorage.getItem('bb-crypto-key') !== null);
    check();
    window.addEventListener('storage', check);
    return () => window.removeEventListener('storage', check);
  }, []);

  // Análisis de ritmo solo desde pulso MEDIDO (HR VALID): las estimaciones
  // experimentales (SpO2/PA) nunca alimentan puntuaciones de riesgo.
  useEffect(() => {
    if (
      lastValidResults &&
      lastValidResults.heartRate.status === 'VALID' &&
      (lastValidResults.heartRate.value || 0) > 0
    ) {
      import('@/lib/ml/riskAnalyzer').then(({ healthRiskAnalyzer }) => {
        const risk = healthRiskAnalyzer.analyze(lastValidResults);
        setRiskResult(risk.timeline);
      }).catch((err) => {
        log.warn('Risk analysis evaluation failed:', err);
      });
    } else {
      setRiskResult(null);
    }
  }, [lastValidResults]);

  // Cargar datos antropométricos desde CalibrationManager al montar
  useEffect(() => {
    const profile = CalibrationManager.getInstance().getAnthropometric();
    if (profile) {
      setAge(profile.ageYears.toString());
      setHeight(profile.heightCm.toString());
      setWeight(profile.weightKg.toString());
      setGender(profile.isMale ? "male" : "female");
    }
  }, []);

  const handleSaveProfile = useCallback(() => {
    const ageVal = parseInt(age, 10);
    const heightVal = parseInt(height, 10);
    const weightVal = parseInt(weight, 10);

    if (isNaN(ageVal) || ageVal < 1 || ageVal > 120) {
      alert("Por favor introduce una edad válida");
      return;
    }
    if (isNaN(heightVal) || heightVal < 50 || heightVal > 250) {
      alert("Por favor introduce una altura válida");
      return;
    }
    if (isNaN(weightVal) || weightVal < 10 || weightVal > 300) {
      alert("Por favor introduce un peso válido");
      return;
    }

    const profile = {
      ageYears: ageVal,
      heightCm: heightVal,
      weightKg: weightVal,
      isMale: gender === 'male',
    };
    CalibrationManager.getInstance().setAnthropometric(profile);
    syncAnthropometric();
    
    toast({
      title: "Perfil Guardado",
      description: "Parámetros antropométricos aplicados al motor hemodinámico.",
    });
  }, [age, height, weight, gender, syncAnthropometric]);

  const handleCalibrateReference = useCallback(() => {
    const sysVal = parseInt(refSys, 10);
    const diaVal = parseInt(refDia, 10);
    const spo2Val = parseInt(refSpo2, 10);
    const calib = CalibrationManager.getInstance();

    let calibratedBP = false;
    let calibratedSpo2 = false;

    if (sysVal && diaVal) {
      if (sysVal < 70 || sysVal > 220 || diaVal < 40 || diaVal > 130) {
        alert("Los valores de presión arterial están fuera de los rangos lógicos (Sistólica: 70-220, Diastólica: 40-130).");
        return;
      }
      
      const lastBP = lastValidResults?.bloodPressure.value;
      if (lastBP) {
        const activeBp = calib.getActiveProfile('BP');
        const prevSbpOff = activeBp?.coefficients?.sbpOffset ?? activeBp?.coefficients?.systolicOffset ?? 0;
        const prevDbpOff = activeBp?.coefficients?.dbpOffset ?? activeBp?.coefficients?.diastolicOffset ?? 0;
        const rawSys = lastBP.systolic - prevSbpOff;
        const rawDia = lastBP.diastolic - prevDbpOff;
        const sbpOffset = sysVal - rawSys;
        const dbpOffset = diaVal - rawDia;
        
        calib.addProfile({
          id: `bp_${Date.now()}`,
          type: 'BP',
          deviceId: 'camera_ppg',
          modelName: 'Bio-PWA 2026 Engine',
          coefficients: { sbpOffset, dbpOffset },
          referenceValues: { systolic: sysVal, diastolic: diaVal },
          createdAt: Date.now(),
          expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
          method: 'cuff_reference'
        });
        calibratedBP = true;
      }
    }

    if (spo2Val) {
      if (spo2Val < 70 || spo2Val > 100) {
        alert("El valor de SpO2 debe estar entre 70 y 100.");
        return;
      }

      const lastSpo2 = lastValidResults?.spo2.value;
      if (lastSpo2) {
        const activeSpo2 = calib.getActiveProfile('SPO2');
        const prevSpo2Off = activeSpo2?.coefficients?.spo2Offset ?? 0;
        const rawSpo2 = lastSpo2 - prevSpo2Off;
        const spo2Offset = spo2Val - rawSpo2;
        
        calib.addProfile({
          id: `spo2_${Date.now()}`,
          type: 'SPO2',
          deviceId: 'camera_ppg',
          modelName: 'Beer-Lambert Camera Proxy',
          coefficients: { spo2Offset },
          referenceValues: { spo2: spo2Val },
          createdAt: Date.now(),
          expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
          method: 'oximeter_reference'
        });
        calibratedSpo2 = true;
      }
    }

    if (calibratedBP || calibratedSpo2) {
      alert("Calibración completada con éxito. Los offsets han sido guardados y se aplicarán de inmediato.");
      setRefSys("");
      setRefDia("");
      setRefSpo2("");
      
      // Forzar renderizado y recargar los valores en pantalla y en lastValidResults
      if (lastValidResults) {
        const updatedBP = (sysVal && diaVal)
          ? { systolic: sysVal, diastolic: diaVal }
          : lastValidResults.bloodPressure.value;

        const updatedSpo2 = spo2Val ?? lastValidResults.spo2.value;

        const newVitals: VitalSignsResult = {
          ...lastValidResults,
          bloodPressure: (calibratedBP && updatedBP)
            ? {
                ...lastValidResults.bloodPressure,
                value: updatedBP,
                status: 'VALID',
                calibration: calib.getCalibrationInfo('BP')
              }
            : lastValidResults.bloodPressure,
          spo2: (calibratedSpo2 && updatedSpo2 != null)
            ? {
                ...lastValidResults.spo2,
                value: updatedSpo2,
                status: 'VALID',
                calibration: calib.getCalibrationInfo('SPO2')
              }
            : lastValidResults.spo2
        };

        setLastValidResults(newVitals);
        router.setVitalSigns(newVitals);
      }
    } else {
      alert("Introduce valores de referencia para calibrar.");
    }
  }, [refSys, refDia, refSpo2, lastValidResults, router, setLastValidResults]);

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
        title: "✓ Rendimiento restaurado",
        description: `Muestreo completo (stride ${currentStride}).`,
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
      (lastSignal.fingerDetected || lastSignal.faceDetected ? "UNSTABLE_CONTACT" : "NO_CONTACT");
    return resolveAcquisitionStatus({
      contactState: cs,
      fingerDetected: !!lastSignal.fingerDetected,
      faceDetected: !!lastSignal.faceDetected,
      mode: measurementMode,
      coverageRatio: (d?.coverageRatio as number) ?? 0,
      perfusionIndex: lastSignal.perfusionIndex ?? 0,
      motionScore: sqm?.motionScore ?? 0,
      saturationRatio: sqm?.saturationRatio ?? 0,
      underexposureRatio: sqm?.underexposureRatio ?? 0,
      fpsEffective: sqm?.fpsEffective ?? 30,
      frameDropRatio: sqm?.frameDropRatio ?? 0,
      timestampJitterMs: sqm?.timestampJitterMs ?? 0,
      torchActive: measurementMode === 'gym' ? undefined : (cam?.torchActive as boolean | undefined),
      torchSupported: measurementMode === 'gym' ? undefined : (cam?.torchSupported as boolean | undefined),
    });
  }, [lastSignal, measurementMode]);

  // CONTROL DE CALIBRACIÓN
  useEffect(() => {
    if (!router.vitalSigns.isCalibrating) return;
    
    const interval = setInterval(() => {
      const currentProgress = getCalibrationProgress();

      if (currentProgress >= 100) {
        clearInterval(interval);
        triggerCalibrationCompleteHaptic().catch(() => undefined);
      }
    }, 500);

    return () => clearInterval(interval);
  }, [router.vitalSigns.isCalibrating, getCalibrationProgress]);

  // Camera error toast
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
        timeout: "La cámara no responde",
        interrupted: "Medición interrumpida",
      };
      const descriptions: Record<string, string> = {
        permission_denied: "Concede el permiso en Ajustes > Aplicaciones > Bio-Beat Tracker > Permisos.",
        not_found: "Asegúrate de que el dispositivo tenga cámara trasera.",
        not_readable: "Cierra otras apps que usen la cámara e intenta de nuevo.",
        overconstrained: "Usando configuración por defecto.",
        abort: "Intenta nuevamente.",
        timeout: "La cámara no presentó imagen a tiempo. Reintenta con buena luz.",
        interrupted: "La pestaña se ocultó: la sesión se descartó sin guardar.",
      };
      toast({
        title: titles[errType] || "Cámara trasera no disponible",
        description: descriptions[errType] || "Verifica los permisos de cámara e intenta nuevamente.",
        duration: 6000,
      });
    };
    const interruptedHandler = () => {
      toast({
        title: "Medición interrumpida",
        description: "La pestaña se ocultó: pistas liberadas y sesión descartada sin guardar.",
        duration: 5000,
      });
    };
    window.addEventListener('camera-error', handler);
    window.addEventListener('camera-interrupted', interruptedHandler);
    return () => {
      window.removeEventListener('camera-error', handler);
      window.removeEventListener('camera-interrupted', interruptedHandler);
    };
  }, []);

  const handleToggleMonitoring = () => {
    if (session.isMonitoring) {
      session.finalizeMeasurement();
    } else {
      session.startMonitoring();
    }
  };

  const handleReset = () => {
    session.handleReset();
  };

  return (
    <div className="fixed inset-0 flex flex-col bg-black" style={{ 
      height: '100svh',
      width: '100vw',
      maxWidth: '100vw',
      maxHeight: '100svh',
      overflow: 'hidden',
      // pan-y permite el scroll vertical dentro de modales/paneles con overflow-y-auto
      // (touchAction:'none' lo bloqueaba en todos los descendientes); overscroll-none
      // evita el rebote/pull-to-refresh de la vista inmersiva.
      touchAction: 'pan-y',
      overscrollBehavior: 'none',
      userSelect: 'none',
      WebkitTouchCallout: 'none',
      WebkitUserSelect: 'none'
    }}>
      {/* SPLASH / BOOT SCREEN — Puerta de entrada a pantalla completa inmersiva */}
      {!session.isFullscreen && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-gradient-to-b from-zinc-950 via-black to-zinc-950 animate-in fade-in duration-700">
          <div className="relative flex flex-col items-center max-w-xs text-center space-y-10 px-4">
            
            {/* Logo Pulsante / Anillos Biomédicos */}
            <div className="relative flex items-center justify-center">
              <div className="absolute inset-0 bg-emerald-500/20 blur-3xl rounded-full animate-ripple scale-150" />
              <div className="absolute w-32 h-32 rounded-full border border-emerald-500/20 animate-spin duration-1000" style={{ animationDuration: '8s' }} />
              <div className="relative w-24 h-24 rounded-full glass-card border border-emerald-500/40 flex items-center justify-center shadow-2xl shadow-emerald-950/60 glow-emerald">
                <Heart className="w-10 h-10 text-emerald-400 animate-cardiac drop-shadow-[0_0_12px_rgba(16,185,129,0.8)]" fill="currentColor" />
              </div>
            </div>

            <div className="space-y-3">
              <h1 className="text-white text-3xl font-extrabold tracking-[0.18em] font-heading bg-gradient-to-r from-white via-zinc-200 to-emerald-300 bg-clip-text text-transparent">
                BIO-BEAT
              </h1>
              <div className="flex items-center justify-center gap-2">
                <span className="h-[1px] w-6 bg-emerald-500/40" />
                <p className="text-emerald-400/80 text-[10px] font-bold tracking-[0.25em] uppercase font-mono">
                  Monitor de Grado Clínico
                </p>
                <span className="h-[1px] w-6 bg-emerald-500/40" />
              </div>
            </div>

            {/* Selector de Modo Pre-Inicio */}
            <div className="flex items-center gap-1.5 p-1 bg-black/40 backdrop-blur-md rounded-2xl border border-white/10">
              <button
                type="button"
                onClick={() => { setMeasurementMode('finger'); resetProcessor(); }}
                className={`px-3.5 py-1.5 rounded-xl text-[10px] font-mono font-bold tracking-wider transition-all duration-200 flex items-center gap-1.5 ${
                  measurementMode === 'finger'
                    ? 'bg-emerald-500 text-black shadow-lg shadow-emerald-500/30'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Heart className="w-3 h-3" />
                CLÍNICO (DEDO)
              </button>
              <button
                type="button"
                onClick={() => { setMeasurementMode('gym'); resetProcessor(); }}
                className={`px-3.5 py-1.5 rounded-xl text-[10px] font-mono font-bold tracking-wider transition-all duration-200 flex items-center gap-1.5 ${
                  measurementMode === 'gym'
                    ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/30'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Activity className="w-3 h-3" />
                MODO GYM (FACIAL)
              </button>
            </div>

            <button 
              onClick={() => {
                session.enterFullScreen();
                session.startMonitoring();
              }}
              className="group relative px-8 py-3.5 overflow-hidden rounded-2xl transition-all duration-300 active:scale-95 shadow-xl shadow-emerald-950/40"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-500 opacity-90 group-hover:opacity-100 transition-opacity" />
              <div className="absolute inset-0 border border-emerald-300/40 rounded-2xl" />
              <span className="relative text-white text-xs font-bold tracking-[0.2em] uppercase font-mono flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-200" />
                INICIAR SISTEMA
              </span>
            </button>

            <div className="pt-6 grid grid-cols-2 gap-x-6 gap-y-4 opacity-90 animate-in slide-in-from-bottom-6 duration-700 delay-200 fill-mode-both">
              <div className="text-left space-y-1 glass-card p-2.5 rounded-xl border border-white/5">
                <p className="text-zinc-400 text-[8px] font-bold tracking-widest uppercase font-mono">Pipeline</p>
                <p className="text-emerald-300 text-[9px] font-mono leading-tight font-bold">ZERO-ALLOCATION<br/>ULTRA LOW LATENCY</p>
              </div>
              <div className="text-left space-y-1 glass-card p-2.5 rounded-xl border border-white/5">
                <p className="text-zinc-400 text-[8px] font-bold tracking-widest uppercase font-mono">Engine</p>
                <p className="text-cyan-300 text-[9px] font-mono leading-tight font-bold">PPG-RG FIDELITY<br/>PWA IMMERSIVE</p>
              </div>
              <div className="text-left space-y-1 glass-card p-2.5 rounded-xl border border-white/5">
                <p className="text-zinc-400 text-[8px] font-bold tracking-widest uppercase font-mono">Analytics</p>
                <p className="text-emerald-300 text-[9px] font-mono leading-tight font-bold">HRV CLINICAL<br/>RMSSD / PNN50</p>
              </div>
              <div className="text-left space-y-1 glass-card p-2.5 rounded-xl border border-white/5">
                <p className="text-zinc-400 text-[8px] font-bold tracking-widest uppercase font-mono">Security</p>
                <p className="text-indigo-300 text-[9px] font-mono leading-tight font-bold">ANTI-SIM GUARD<br/>DATA INTEGRITY</p>
              </div>
            </div>

            <div className="pt-4 space-y-1 opacity-50 text-center font-mono text-[8px] text-zinc-400 uppercase tracking-widest">
              <p>Hardware: WebRTC Optical Sensor</p>
              <p>Engine v4.0.2 • Build 2026.SOTA</p>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 relative">

        {/* CÁMARA */}
        <div className="absolute inset-0">
          <CameraView 
            ref={cameraRef}
            onStreamReady={session.handleStreamReady}
            isMonitoring={session.isCameraOn}
            measurementMode={measurementMode}
            faceDetected={lastSignal?.faceDetected}
          />
        </div>

        {/* BARRA SUPERIOR CLÍNICA UNIFICADA (Glassmorphism, non-overlapping) */}
        <div className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between px-3.5 h-11 glass-panel border-b border-white/10 shadow-lg">
          {/* Lado Izquierdo: Branding & Estado de Monitorización */}
          <div className="flex items-center gap-2">
            <div className="relative flex items-center justify-center">
              {session.isMonitoring && (
                <div className="absolute w-5 h-5 rounded-full bg-rose-500/30 animate-ping pointer-events-none duration-700" />
              )}
              <div className={`p-1.5 rounded-xl transition-colors ${session.isMonitoring ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40 glow-rose' : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'}`}>
                <Heart className={`w-3.5 h-3.5 ${session.isMonitoring ? 'animate-cardiac fill-current' : ''}`} />
              </div>
            </div>
            <div className="flex flex-col">
              <span className="text-[11px] font-bold tracking-wider font-heading text-white leading-none">BIO-BEAT</span>
              <span className={`text-[8px] font-mono font-semibold tracking-wider uppercase leading-none mt-0.5 ${session.isMonitoring ? 'text-emerald-400 animate-pulse' : 'text-zinc-500'}`}>
                {session.isMonitoring ? 'MONITOREANDO' : 'EN ESPERA'}
              </span>
            </div>
          </div>

          {/* Lado Derecho: SQI Badge + Modo Switcher + Acciones Rápidas */}
          <div className="flex items-center gap-1.5">
            {/* Calidad de Señal SQI */}
            <div className={`px-2 py-0.5 rounded-full border text-[8px] font-mono font-bold tracking-wider flex items-center gap-1 ${
              (lastSignal?.quality || 0) > 60
                ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30 glow-emerald'
                : (lastSignal?.quality || 0) > 30
                ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                : 'bg-zinc-900/60 text-zinc-500 border-zinc-800/60'
            }`}>
              <div className={`w-1.5 h-1.5 rounded-full ${
                (lastSignal?.quality || 0) > 60 ? 'bg-emerald-400 animate-pulse' : (lastSignal?.quality || 0) > 30 ? 'bg-amber-400' : 'bg-zinc-600'
              }`} />
              <span>SQI {Math.round(lastSignal?.quality || 0)}%</span>
            </div>

            {/* Toggle Rápido de Modo Clínico / GYM */}
            <button
              type="button"
              onClick={() => {
                const nextMode = measurementMode === 'gym' ? 'finger' : 'gym';
                // Cambio de sensor (frontal↔trasera): la sesión anterior queda
                // invalidada. Reset completo si medía; si no, reset DSP para no
                // arrastrar baselines del otro modo. Las pistas previas las
                // libera CameraView al remontar con el nuevo modo.
                if (session.isMonitoring) {
                  session.handleReset();
                } else {
                  resetProcessor();
                }
                setMeasurementMode(nextMode);
                toast({
                  title: nextMode === 'gym' ? "MODO GYM ACTIVADO" : "MODO CLÍNICO ACTIVADO",
                  description: nextMode === 'gym'
                    ? "Cámara frontal + algoritmo POS + filtro biomecánico activados."
                    : "Cámara trasera con flash para máxima precisión de laboratorio.",
                  duration: 2500,
                });
              }}
              aria-label="Cambiar Modo"
              title={measurementMode === 'gym' ? "Cambiar a Modo Clínico (Dedo)" : "Cambiar a Modo GYM (Facial rPPG)"}
              className={`px-2 py-0.5 rounded-full border text-[8px] font-mono font-bold tracking-wider flex items-center gap-1 transition-all duration-200 ${
                measurementMode === 'gym'
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/50 shadow-[0_0_8px_rgba(245,158,11,0.4)]'
                  : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/25'
              }`}
            >
              {measurementMode === 'gym' ? (
                <>
                  <Activity className="w-2.5 h-2.5 text-amber-400" />
                  <span>GYM</span>
                </>
              ) : (
                <>
                  <Heart className="w-2.5 h-2.5 text-emerald-400" />
                  <span>CLÍNICO</span>
                </>
              )}
            </button>

            {/* TELEMEDICINA */}
            <button
              type="button"
              onClick={() => setShowTelemedicine(true)}
              aria-label="Telemedicina"
              title="Telemedicina P2P WebRTC"
              className="p-1.5 rounded-xl bg-white/5 hover:bg-emerald-500/20 text-emerald-400/90 hover:text-emerald-300 active:scale-95 transition-all duration-150 border border-white/10 hover:border-emerald-500/40"
            >
              <Activity className="h-3.5 w-3.5" />
            </button>

            {/* AJUSTES */}
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              aria-label="Ajustes"
              title="Ajustes y Calibración"
              className="p-1.5 rounded-xl bg-white/5 hover:bg-white/15 text-zinc-300 hover:text-white active:scale-95 transition-all duration-150 border border-white/10 hover:border-white/20"
            >
              <Sliders className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* TELEMEDICINA DIALOG */}
        {showTelemedicine && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md animate-fade-in p-4">
            <div className="glass-panel border border-white/15 rounded-3xl max-w-sm w-full shadow-2xl flex flex-col max-h-[85vh] overflow-hidden animate-in zoom-in-95 duration-200">
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                    <Activity className="w-4 h-4 text-emerald-400" />
                  </div>
                  <div>
                    <h3 className="text-white text-sm font-bold font-heading">Telemedicina P2P</h3>
                    <p className="text-[9px] text-zinc-400 font-mono">WebRTC Secure Telemetry Bridge</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowTelemedicine(false)}
                  className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                <p className="text-zinc-400 text-[10px] leading-relaxed">
                  Conexión directa P2P encriptada. Copia tu descriptor de sesión (SDP) para enlazar en vivo con el médico.
                </p>
                <WebrtcCallWidget vitals={router.vitalSigns} />
              </div>
            </div>
          </div>
        )}

        <div className="relative z-10 h-full">
          <div className="flex-1 h-full">
            <PPGSignalMeter 
              ref={ppgMeterRef}
              value={router.heartbeatSignal}
              quality={lastSignal?.quality || 0}
              isFingerDetected={
                measurementMode === 'gym'
                  ? !!lastSignal?.faceDetected
                  : (!!lastSignal?.fingerDetected && lastSignal?.contactState !== 'NO_CONTACT')
              }
              measurementMode={measurementMode}
              faceDetected={lastSignal?.faceDetected}
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
                (lastSignal?.fingerDetected || lastSignal?.faceDetected ? 'UNSTABLE_CONTACT' : 'NO_CONTACT')
              }
              acquisitionStatus={acquisitionStatusLabel}
              getVideoElement={() => cameraRef.current?.getVideoElement() ?? canvasRef.current ?? null}
              webgpuAvail={webgpuAvail}
              encryptionReady={encryptionReady}
              healthAvail={healthAvail}
              riskResult={riskResult}
              diagnostics={router.currentDiagnostics as unknown as import('@/components/PPGSignalMeter').PPGSignalMeterProps['diagnostics']}
            />
          </div>

          {/* RESUMEN ESTADÍSTICO POST-MEDICIÓN */}
          {session.showResults && session.measurementSummary && (() => {
            const { totalBeats, arrhythmiaBeats, normalPercent } = session.measurementSummary;
            const normalBeats = totalBeats - arrhythmiaBeats;
            const avgBpm = (router.vitalSigns.heartRate.value ?? 0) > 0 ? Math.round(router.vitalSigns.heartRate.value!) : '--';
            const statusColor = normalPercent >= 95 ? 'emerald' : normalPercent >= 80 ? 'yellow' : 'red';
            const statusText = normalPercent >= 95 ? 'RITMO NORMAL' : normalPercent >= 80 ? 'LEVE IRREGULARIDAD' : 'IRREGULARIDAD DETECTADA';
            const statusIcon = normalPercent >= 95 ? CheckCircle2 : normalPercent >= 80 ? AlertTriangle : XCircle;
            const bgClass = statusColor === 'emerald' ? 'bg-emerald-500/10' : statusColor === 'yellow' ? 'bg-yellow-500/10' : 'bg-red-500/10';
            const textClass = statusColor === 'emerald' ? 'text-emerald-400' : statusColor === 'yellow' ? 'text-yellow-400' : 'text-red-400';
            const strokeClass = statusColor === 'emerald' ? 'stroke-emerald-400' : statusColor === 'yellow' ? 'stroke-yellow-400' : 'stroke-red-400';
            const StatusIcon = statusIcon;
            
            return (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md animate-fade-in p-4">
                <div className="glass-panel border border-white/15 rounded-3xl max-w-sm w-full shadow-2xl flex flex-col max-h-[85vh] overflow-hidden animate-in zoom-in-95 duration-200">
                  
                  {/* Header con estado */}
                  <div className={`flex-none px-5 py-4 ${bgClass} border-b border-white/10`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-2xl bg-black/40 border border-white/10 shadow-inner">
                          <StatusIcon className={`w-5 h-5 ${textClass}`} />
                        </div>
                        <div>
                          <h3 className="text-white text-sm font-bold font-heading tracking-wide">
                            {session.validationVerdict && !session.validationVerdict.accepted ? 'SESIÓN NO VÁLIDA' : 'MEDICIÓN COMPLETADA'}
                          </h3>
                          <p className={`${textClass} text-[10px] font-semibold tracking-wider uppercase font-mono`}>{statusText}</p>
                        </div>
                      </div>
                      <button 
                        onClick={() => {
                          session.setLocalMeasurementSummary(null);
                          session.setLocalShowResults(false);
                        }}
                        className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Métricas principales */}
                  <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    
                    {/* BPM y SpO2 en fila */}
                    <div className="grid grid-cols-2 gap-2.5">
                      <div className="glass-card rounded-2xl p-3 text-center border border-white/5 shadow-lg">
                        <Heart className="w-4 h-4 text-rose-400 mx-auto mb-1 animate-cardiac" fill="currentColor" />
                        <div className="text-white text-2xl font-extrabold font-mono leading-none tracking-tight">{avgBpm}</div>
                        <div className="text-zinc-400 text-[9px] mt-1 font-mono uppercase tracking-wider">BPM PROMEDIO</div>
                      </div>
                      <div className="glass-card rounded-2xl p-3 text-center border border-white/5 shadow-lg">
                        <Activity className="w-4 h-4 text-cyan-400 mx-auto mb-1" />
                        <div className="text-white text-2xl font-extrabold font-mono leading-none tracking-tight">
                          {router.vitalSigns.spo2.value != null && router.vitalSigns.spo2.value > 0 ? Math.round(router.vitalSigns.spo2.value) : '--'}
                          <span className="text-sm text-cyan-300/70 ml-0.5">%</span>
                        </div>
                        <div className="text-zinc-400 text-[9px] mt-1 font-mono uppercase tracking-wider">SpO₂ · experimental</div>
                        <div className="mt-1.5 flex justify-center">
                          {router.vitalSigns.spo2.value != null && router.vitalSigns.spo2.value > 0 ? (
                            router.vitalSigns.spo2.calibration?.available ? (
                              <span className="text-[7px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">CALIBRADO</span>
                            ) : (
                              <span className="text-[7px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">ESTIMADO</span>
                            )
                          ) : (
                            <span className="text-[7px] font-bold px-2 py-0.5 rounded-full bg-zinc-500/20 text-zinc-300 border border-zinc-500/30">NO DISPONIBLE</span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Presión arterial */}
                    {router.vitalSigns.bloodPressure.value && router.vitalSigns.bloodPressure.value.systolic > 0 && (
                      <div className="glass-card rounded-2xl p-3.5 border border-white/5 flex items-center gap-3 shadow-lg">
                        <div className="p-2 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
                          <Shield className="w-4 h-4 text-indigo-400" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center justify-between mb-0.5">
                            <div className="text-zinc-400 text-[9px] font-mono uppercase tracking-wider">PRESIÓN ARTERIAL</div>
                            {router.vitalSigns.bloodPressure.calibration?.available ? (
                              <span className="text-[7px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">CALIBRADO</span>
                            ) : (
                              <span className="text-[7px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">ESTIMADO</span>
                            )}
                          </div>
                          <div className="text-white text-lg font-bold font-mono">
                            {Math.round(router.vitalSigns.bloodPressure.value.systolic)}/{Math.round(router.vitalSigns.bloodPressure.value.diastolic)}
                            <span className="text-xs text-zinc-400 ml-1 font-sans">mmHg</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Barras de ritmo */}
                    <div className="glass-card rounded-2xl p-3.5 border border-white/5 space-y-2 shadow-lg">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-zinc-300 text-[10px] font-bold font-mono tracking-wider uppercase">ANÁLISIS DE RITMO</span>
                        <div className="flex items-center gap-1 text-zinc-400 text-[9px] font-mono">
                          <Clock className="w-3 h-3 text-zinc-500" />
                          <span>60s</span>
                        </div>
                      </div>
                      
                      {/* Latidos normales */}
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <span className="text-emerald-400 text-[9px] font-mono">■ Latidos Normales</span>
                          <span className="text-white text-xs font-bold font-mono">{normalBeats}</span>
                        </div>
                        <div className="w-full h-2 bg-black/40 rounded-full overflow-hidden p-0.5 border border-white/5">
                          <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-1000 ease-out"
                               style={{ width: `${totalBeats > 0 ? (normalBeats / totalBeats) * 100 : 0}%` }} />
                        </div>
                      </div>
                      
                      {/* Arritmias */}
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <span className="text-rose-400 text-[9px] font-mono">■ Arrítmicos / Ectópicos</span>
                          <span className="text-white text-xs font-bold font-mono">{arrhythmiaBeats}</span>
                        </div>
                        <div className="w-full h-2 bg-black/40 rounded-full overflow-hidden p-0.5 border border-white/5">
                          <div className={`h-full rounded-full transition-all duration-1000 ease-out ${arrhythmiaBeats > 0 ? 'bg-gradient-to-r from-rose-600 to-red-500' : 'bg-zinc-800'}`}
                               style={{ width: `${totalBeats > 0 ? (arrhythmiaBeats / totalBeats) * 100 : 100}%` }} />
                        </div>
                      </div>
                    </div>

                    {/* Poincaré Plot de HRV */}
                    {router.rrIntervals && router.rrIntervals.length >= 2 && (
                      <div className="flex justify-center my-1 animate-in fade-in zoom-in-95 duration-500">
                        <PoincarePlot rrIntervals={router.rrIntervals} width={200} height={200} />
                      </div>
                    )}

                    {/* Porcentaje circular visual */}
                    <div className="glass-card rounded-2xl p-3 border border-white/5 flex items-center justify-center gap-4">
                      <div className="relative w-14 h-14">
                        <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                          <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                                fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
                          <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                                fill="none"
                                className={strokeClass}
                                strokeWidth="3"
                                strokeDasharray={`${normalPercent}, 100`}
                                strokeLinecap="round" />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className={`text-xs font-bold font-mono ${textClass}`}>
                            {normalPercent}%
                          </span>
                        </div>
                      </div>
                      <div>
                        <div className="text-white text-xs font-bold font-heading">Regularidad de Ritmo</div>
                        <div className="text-zinc-400 text-[9px] font-mono">{totalBeats} latidos registrados</div>
                        <div className={`text-[10px] font-bold mt-0.5 font-mono ${textClass}`}>
                          {statusText}
                        </div>
                      </div>
                    </div>

                    {/* Tarjeta de Validación Clínica (MeasurementWindowValidator) */}
                    {session.validationVerdict && (
                      <div className={`glass-card rounded-2xl p-3 border ${session.validationVerdict.accepted ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'} space-y-1.5 shadow-lg`}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            {session.validationVerdict.accepted ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                            )}
                            <span className={`text-[10px] font-bold font-mono tracking-wider uppercase ${session.validationVerdict.accepted ? 'text-emerald-400' : 'text-amber-400'}`}>
                              {session.validationVerdict.accepted ? 'VENTANA CLÍNICA VALIDADA' : 'CALIDAD DE SEÑAL SUBÓPTIMA'}
                            </span>
                          </div>
                          <span className="text-[9px] font-mono text-zinc-400">
                            SQI {Math.round(session.validationVerdict.qualitySummary.sqiMedian)}% · {Math.round(session.validationVerdict.qualitySummary.fpsMedian)} FPS
                          </span>
                        </div>
                        {!session.validationVerdict.accepted && session.validationVerdict.rejectionReasons.length > 0 && (
                          <p className="text-[9px] font-mono text-amber-300/80 leading-tight">
                            {session.validationVerdict.rejectionReasons[0]}
                          </p>
                        )}
                        {!session.validationVerdict.accepted && avgBpm === '--' && (
                          <p className="text-[9px] font-mono text-amber-300/80 leading-tight">
                            Sin pulso válido: no genera fila de historial (BPM en --).
                          </p>
                        )}
                        <p className="text-[8px] font-mono text-zinc-500 leading-tight">
                          SpO₂/PA son estimaciones experimentales de bienestar, no mediciones clínicas.
                        </p>
                      </div>
                    )}

                    {/* Botón Análisis AI */}
                    <button
                      onClick={() => {
                        analyzeVitals({ vitalSigns: router.vitalSigns, quality: lastSignal?.quality || 0 });
                        setShowAIAnalysis(true);
                      }}
                      disabled={isAnalyzing}
                      className="w-full mt-1 flex items-center justify-center gap-2 py-3 px-4 rounded-2xl bg-gradient-to-r from-purple-600 via-indigo-600 to-purple-700 hover:from-purple-500 hover:to-indigo-500 text-white font-bold text-xs font-mono uppercase tracking-wider transition-all active:scale-[0.98] shadow-xl shadow-purple-950/40 disabled:opacity-50 border border-purple-400/30"
                    >
                      {isAnalyzing ? (
                        <><Loader2 className="w-4 h-4 animate-spin" /> Analizando...</>
                      ) : (
                        <><Brain className="w-4 h-4 text-purple-200" /> Análisis AI de Salud</>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* MODAL ANÁLISIS AI */}
          {showAIAnalysis && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 animate-fade-in">
              <div className="bg-black border border-slate-700/50 rounded-2xl max-w-sm w-[92%] max-h-[80vh] shadow-2xl overflow-hidden flex flex-col">
                <div className="px-4 py-3 bg-purple-500/10 border-b border-zinc-900 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Brain className="w-5 h-5 text-purple-400" />
                    <h3 className="text-white text-sm font-bold">Análisis AI de Salud</h3>
                  </div>
                  <button
                    onClick={() => { setShowAIAnalysis(false); clearAnalysis(); }}
                    className="p-1.5 rounded-full bg-zinc-900 hover:bg-slate-700 transition-colors"
                  >
                    <X className="w-4 h-4 text-zinc-400" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-4">
                  {isAnalyzing ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-3">
                      <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
                      <p className="text-zinc-400 text-sm">Analizando tus signos vitales...</p>
                    </div>
                  ) : analysis ? (
                    <div className="text-slate-300 text-xs leading-relaxed whitespace-pre-wrap">
                      {analysis}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 gap-3">
                      <p className="text-zinc-500 text-sm">No se pudo generar el análisis.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* PANEL DE AJUSTES Y CALIBRACIÓN */}
          {showSettings && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md animate-fade-in p-4">
              <div className="glass-panel border border-white/15 rounded-3xl max-w-sm w-full shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-200">
                
                {/* Header */}
                <div className="px-5 pt-4 bg-gradient-to-b from-white/5 to-transparent border-b border-white/10 flex flex-col">
                  <div className="flex items-center justify-between pb-3">
                    <div className="flex items-center gap-2.5">
                      <div className="p-2 rounded-2xl bg-emerald-500/10 border border-emerald-500/20">
                        <Sliders className="w-4 h-4 text-emerald-400" />
                      </div>
                      <div>
                        <h3 className="text-white text-sm font-bold font-heading tracking-wide uppercase">Ajustes del Sistema</h3>
                        <p className="text-zinc-400 text-[8px] font-mono tracking-wider uppercase">Monitorización y calibración clínica</p>
                      </div>
                    </div>
                    <button 
                      onClick={() => setShowSettings(false)}
                      className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  
                  {/* Tabs Selector */}
                  <div className="flex gap-1 p-1 bg-black/40 rounded-2xl border border-white/5 text-[9px] font-bold font-mono mb-2">
                    <button 
                      onClick={() => setActiveTab('profile')}
                      className={`flex-1 py-1.5 px-2 text-center rounded-xl transition-all duration-200 ${
                        activeTab === 'profile'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-md'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      PERFIL
                    </button>
                    <button 
                      onClick={() => setActiveTab('calibration')}
                      className={`flex-1 py-1.5 px-2 text-center rounded-xl transition-all duration-200 ${
                        activeTab === 'calibration'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-md'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      CALIBRACIÓN
                    </button>
                    <button 
                      onClick={() => setActiveTab('history')}
                      className={`flex-1 py-1.5 px-2 text-center rounded-xl transition-all duration-200 ${
                        activeTab === 'history'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-md'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      HISTORIAL
                    </button>
                    <button 
                      onClick={() => setActiveTab('account')}
                      className={`flex-1 py-1.5 px-2 text-center rounded-xl transition-all duration-200 ${
                        activeTab === 'account'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-md'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      SYNC
                    </button>
                  </div>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-4">
                  
                  {/* TAB 1: PERFIL */}
                  {activeTab === 'profile' && (
                    <div className="space-y-4 animate-in fade-in duration-200">
                      {/* Sección 1: Perfil Fisiológico */}
                      <div className="space-y-3">
                        <div className="flex items-center gap-1.5 text-zinc-400 text-[10px] font-bold uppercase tracking-wider">
                          <User className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Perfil Fisiológico (PA Neuronal)</span>
                        </div>
                        
                        <div className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-3.5 space-y-3.5">
                          {/* Edad y Género */}
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Edad (años)</label>
                              <input 
                                type="number" 
                                value={age}
                                onChange={(e) => setAge(e.target.value)}
                                className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors" 
                                placeholder="35"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Sexo Biológico</label>
                              <div className="grid grid-cols-2 gap-1 bg-black p-0.5 rounded-lg border border-zinc-900">
                                <button 
                                  type="button"
                                  onClick={() => setGender('male')}
                                  className={`py-1 text-[10px] font-bold rounded ${gender === 'male' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'text-zinc-500 hover:text-white'}`}
                                >
                                  MASC
                                </button>
                                <button 
                                  type="button"
                                  onClick={() => setGender('female')}
                                  className={`py-1 text-[10px] font-bold rounded ${gender === 'female' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'text-zinc-500 hover:text-white'}`}
                                >
                                  FEM
                                </button>
                              </div>
                            </div>
                          </div>

                          {/* Altura y Peso */}
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Altura (cm)</label>
                              <input 
                                type="number" 
                                value={height}
                                onChange={(e) => setHeight(e.target.value)}
                                className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors" 
                                placeholder="172"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Peso (kg)</label>
                              <input 
                                type="number" 
                                value={weight}
                                onChange={(e) => setWeight(e.target.value)}
                                className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors" 
                                placeholder="70"
                              />
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={handleSaveProfile}
                            className="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[11px] transition-colors flex items-center justify-center gap-1.5"
                          >
                            <Check className="w-3.5 h-3.5" /> GUARDAR PERFIL
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* TAB 1b: CALIBRACIÓN */}
                  {activeTab === 'calibration' && (
                    <div className="space-y-4 animate-in fade-in duration-200">
                      {/* Sección 2: Calibración Cruzada */}
                      <div className="space-y-3">
                        <div className="flex items-center gap-1.5 text-zinc-400 text-[10px] font-bold uppercase tracking-wider">
                          <Activity className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Calibración con Dispositivo Médico</span>
                        </div>

                        <div className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-3.5 space-y-3.5">
                          {lastValidResults ? (
                            <>
                              <div className="bg-black/60 rounded-lg p-2.5 border border-zinc-900/40 text-[10px] space-y-1">
                                <span className="text-zinc-500 font-semibold block uppercase">Última medición registrada:</span>
                                <div className="flex justify-between text-white font-bold">
                                  <span>PA: {lastValidResults.bloodPressure.value ? `${Math.round(lastValidResults.bloodPressure.value.systolic)}/${Math.round(lastValidResults.bloodPressure.value.diastolic)} mmHg` : 'No detectada'}</span>
                                  <span>SpO₂: {lastValidResults.spo2.value ? `${Math.round(lastValidResults.spo2.value)}%` : 'No detectado'}</span>
                                </div>
                              </div>

                              <div className="space-y-2.5">
                                <div className="grid grid-cols-2 gap-3">
                                  <div className="space-y-1">
                                    <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Ref. Sistólica (mmHg)</label>
                                    <input 
                                      type="number" 
                                      value={refSys}
                                      onChange={(e) => setRefSys(e.target.value)}
                                      className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors" 
                                      placeholder="120"
                                    />
                                  </div>
                                  <div className="space-y-1">
                                    <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Ref. Diastólica (mmHg)</label>
                                    <input 
                                      type="number" 
                                      value={refDia}
                                      onChange={(e) => setRefDia(e.target.value)}
                                      className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors" 
                                      placeholder="80"
                                    />
                                  </div>
                                </div>

                                <div className="space-y-1">
                                  <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Ref. SpO₂ (%)</label>
                                  <input 
                                    type="number" 
                                    value={refSpo2}
                                    onChange={(e) => setRefSpo2(e.target.value)}
                                    className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors" 
                                    placeholder="98"
                                  />
                                </div>

                                <button
                                  type="button"
                                  onClick={handleCalibrateReference}
                                  className="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[11px] transition-colors flex items-center justify-center gap-1.5"
                                >
                                  <Activity className="w-3.5 h-3.5" /> CALIBRAR DISPOSITIVO
                                </button>
                              </div>
                            </>
                          ) : (
                            <div className="text-center py-4 space-y-2">
                              <AlertTriangle className="w-6 h-6 text-amber-500 mx-auto" />
                              <p className="text-zinc-400 text-[10px] font-semibold leading-relaxed">
                                Realiza al menos una medición completa para poder calibrar los sensores ópticos con tus valores de referencia.
                              </p>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Sección 3: Estado de Calibraciones */}
                      <div className="space-y-3">
                        <div className="flex items-center gap-1.5 text-zinc-400 text-[10px] font-bold uppercase tracking-wider">
                          <Shield className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Calibraciones Activas</span>
                        </div>

                        <div className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-3.5 space-y-2 text-[10px] font-semibold text-zinc-400">
                          <div className="flex justify-between items-center py-1 border-b border-zinc-900/50">
                            <span>Presión Arterial (BP)</span>
                            {CalibrationManager.getInstance().getCalibrationInfo('BP').available ? (
                              <span className="text-emerald-400 font-bold uppercase">Activo (Válido)</span>
                            ) : (
                              <span className="text-slate-600 uppercase">Sin calibrar</span>
                            )}
                          </div>
                          <div className="flex justify-between items-center py-1">
                            <span>Oxígeno en Sangre (SpO2)</span>
                            {CalibrationManager.getInstance().getCalibrationInfo('SPO2').available ? (
                              <span className="text-emerald-400 font-bold uppercase">Activo (Válido)</span>
                            ) : (
                              <span className="text-slate-600 uppercase">Sin calibrar</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* TAB 2: HISTORIAL DE MEDICIONES */}
                  {activeTab === 'history' && (
                    <div className="space-y-4 animate-in fade-in duration-200">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={handleExportCSV}
                          className="flex-1 py-2 rounded-xl bg-zinc-950 border border-zinc-900 hover:bg-zinc-900 text-white font-bold text-xs transition-all flex items-center justify-center gap-2"
                        >
                          <Activity className="w-4 h-4 text-cyan-400" /> EXPORTAR CSV
                        </button>
                        <button
                          type="button"
                          onClick={handleClearHistory}
                          className="px-4 py-2 rounded-xl bg-red-950/20 border border-red-900/40 text-red-400 hover:bg-red-950/40 font-bold text-xs transition-all"
                        >
                          LIMPIAR
                        </button>
                      </div>

                      <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
                        {history.length > 0 ? (
                          history.map((m: HistoricalMeasurement) => {
                            const dateStr = new Date(m.measured_at).toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit'
                            });
                            return (
                              <div key={m.id} className="bg-zinc-950/60 border border-zinc-900/40 rounded-xl p-3 space-y-2 relative">
                                <div className="flex justify-between items-center">
                                  <span className="text-[10px] text-zinc-500 font-bold uppercase">{dateStr}</span>
                                  {m.isCloud ? (
                                    <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400">NUBE</span>
                                  ) : (
                                    <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-zinc-900 text-zinc-400">LOCAL</span>
                                  )}
                                </div>
                                <div className="grid grid-cols-3 gap-2 text-center">
                                  <div className="bg-black/40 rounded-lg py-1 border border-zinc-950">
                                    <span className="text-zinc-500 text-[8px] block font-bold">PULSO</span>
                                    <span className="text-white text-xs font-bold">{m.heart_rate || '--'} <span className="text-[8px] text-zinc-400">bpm</span></span>
                                  </div>
                                  <div className="bg-black/40 rounded-lg py-1 border border-zinc-950">
                                    <span className="text-zinc-500 text-[8px] block font-bold">SpO₂ <span className="text-amber-400/80">·EXP</span></span>
                                    <span className="text-white text-xs font-bold">{m.spo2 || '--'}<span className="text-[8px] text-zinc-400">%</span></span>
                                  </div>
                                  <div className="bg-black/40 rounded-lg py-1 border border-zinc-950">
                                    <span className="text-zinc-500 text-[8px] block font-bold">PRESIÓN <span className="text-amber-400/80">·EXP</span></span>
                                    <span className="text-white text-xs font-bold">
                                      {m.systolic && m.diastolic ? `${m.systolic}/${m.diastolic}` : '--'}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <div className="text-center py-10 space-y-2 border border-dashed border-zinc-900 rounded-xl">
                            <Activity className="w-8 h-8 text-slate-700 mx-auto animate-pulse" />
                            <p className="text-zinc-500 text-[10px] font-semibold">Aún no hay mediciones guardadas en este dispositivo.</p>
                          </div>
                        )}
                        {history.length > 0 && (
                          <p className="text-zinc-600 text-[8px] font-mono leading-tight px-1">
                            ·EXP = estimación experimental de bienestar, no medición clínica. «--» = no disponible (sin señal suficiente o sin referencia vigente).
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* TAB 3: SINCRONIZACIÓN EN LA NUBE */}
                  {activeTab === 'account' && (
                    <div className="space-y-4 animate-in fade-in duration-200">
                      {currentUser ? (
                        <div className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-4 space-y-4 text-center">
                          <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto">
                            <Check className="w-6 h-6 text-emerald-400" />
                          </div>
                          <div className="space-y-1">
                            <h4 className="text-white text-xs font-bold">SESIÓN INICIADA</h4>
                            <p className="text-zinc-400 text-[10px] font-mono">{currentUser.email}</p>
                          </div>
                          <p className="text-zinc-500 text-[9px] leading-relaxed">
                            Tus signos vitales se guardarán automáticamente en la nube y se sincronizarán en todos tus dispositivos.
                          </p>
                          <button
                            type="button"
                            onClick={handleSignOut}
                            className="w-full py-2 rounded-xl bg-red-950/20 border border-red-900/40 text-red-400 hover:bg-red-950/40 font-bold text-xs transition-all"
                          >
                            CERRAR SESIÓN
                          </button>
                        </div>
                      ) : (
                        <form onSubmit={handleAuth} className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-4 space-y-4">
                          <div className="text-center space-y-1 pb-2">
                            <h4 className="text-white text-xs font-bold uppercase">Sincronización en la Nube</h4>
                            <p className="text-zinc-500 text-[9px] font-medium leading-relaxed">
                              Crea una cuenta para guardar tu historial en internet de forma permanente y segura.
                            </p>
                          </div>

                          <div className="space-y-2.5">
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Correo Electrónico</label>
                              <input 
                                type="email" 
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors" 
                                placeholder="tu@correo.com"
                                required
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Contraseña</label>
                              <input 
                                type="password" 
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors" 
                                placeholder="••••••••"
                                required
                              />
                            </div>
                          </div>

                          <div className="pt-2 space-y-3">
                            <button
                              type="submit"
                              disabled={authLoading}
                              className="w-full py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-indigo-600 hover:from-emerald-500 hover:to-indigo-500 text-white font-bold text-xs tracking-wider transition-all disabled:opacity-50"
                            >
                              {authLoading ? "Procesando..." : (authMode === 'signin' ? "INICIAR SESIÓN" : "CREAR CUENTA")}
                            </button>

                            <div className="text-center">
                              <button
                                type="button"
                                onClick={() => setAuthMode(prev => prev === 'signin' ? 'signup' : 'signin')}
                                className="text-emerald-400 hover:text-emerald-300 text-[10px] font-bold"
                              >
                                {authMode === 'signin' ? "¿No tienes cuenta? Regístrate aquí" : "¿Ya tienes cuenta? Inicia sesión"}
                              </button>
                            </div>
                          </div>
                        </form>
                      )}
                    </div>
                  )}

                </div>
              </div>
            </div>
          )}

          {/* DESCARGO DE RESPONSABILIDAD MÉDICA */}
          {!disclaimerAccepted && (
            <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/95 backdrop-blur-md animate-fade-in p-4 overflow-y-auto">
              <div className="bg-black border border-zinc-900/80 rounded-2xl max-w-sm w-full shadow-2xl p-5 space-y-5 animate-in zoom-in-95 duration-300 max-h-[90vh] flex flex-col">
                <div className="text-center space-y-2">
                  <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto">
                    <AlertTriangle className="w-6 h-6 text-red-500" />
                  </div>
                  <h3 className="text-white text-base font-bold tracking-wide uppercase">DESCARGO DE RESPONSABILIDAD MÉDICA</h3>
                  <p className="text-red-400 text-[10px] font-bold tracking-wider uppercase">IMPORTANTE LEER ANTES DE USAR</p>
                </div>

                <div className="flex-1 overflow-y-auto text-zinc-400 text-[11px] leading-relaxed space-y-3.5 pr-1 border-y border-zinc-950 py-4">
                  <p>
                    Esta aplicación utiliza fotopletismografía (PPG) a través de la cámara y el flash de su smartphone para estimar el pulso, la variabilidad de la frecuencia cardíaca, la saturación de oxígeno ($SpO_2$) y la presión arterial.
                  </p>
                  <p className="font-semibold text-white">
                    Esta aplicación NO es un dispositivo médico y NO ha sido certificada por la FDA, EMA ni ninguna entidad reguladora de salud.
                  </p>
                  <p>
                    Los resultados mostrados son aproximaciones con fines informativos y de bienestar personal. No deben utilizarse para autodiagnóstico, prevención o tratamiento de ninguna condición médica.
                  </p>
                  <p>
                    Si usted tiene antecedentes de hipertensión, arritmia u otras afecciones cardiovasculares, debe utilizar dispositivos clínicos de grado médico validados y consultar con su médico antes de tomar cualquier decisión clínica.
                  </p>
                  <p>
                    Al hacer clic en "Aceptar y Continuar", usted confirma que comprende y acepta que el uso de esta app es bajo su propio riesgo y discreción.
                  </p>
                </div>

                <button
                  onClick={handleAcceptDisclaimer}
                  className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-indigo-600 hover:from-emerald-500 hover:to-indigo-500 text-white font-bold text-xs tracking-wider transition-all hover:scale-[1.02] active:scale-[0.98]"
                >
                  ACEPTAR Y CONTINUAR
                </button>
                <p className="text-center text-zinc-500 text-[10px] leading-relaxed">
                  Al continuar acepta los{" "}
                  <a href="/terms.html" target="_blank" rel="noopener noreferrer" className="text-emerald-400 underline">
                    Términos de Uso
                  </a>{" "}
                  y la{" "}
                  <a href="/privacy.html" target="_blank" rel="noopener noreferrer" className="text-emerald-400 underline">
                    Política de Privacidad
                  </a>
                  . Producto de bienestar: no es dispositivo médico.
                </p>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};

export default Index;
