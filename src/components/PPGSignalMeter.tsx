import React, { useEffect, useRef, useCallback, useState, useLayoutEffect, useImperativeHandle } from 'react';
import { CircularBuffer } from '../utils/CircularBuffer';
import { isNative } from '@/lib/device/platform';
import { calculateHRV, isPhysiologicalRR } from '../utils/physio';
import {
  TARGET_FPS,
  BUFFER_SIZE,
  TREND_WINDOW_MS,
  TREND_MAX_POINTS,
  PpgLayout,
  PpgRenderProps,
  PpgRenderState,
  drawBackground,
  drawHeader,
  drawMetricsBar,
  drawECGGrid,
  drawPressureGauge,
  drawSignal,
  drawAcquisitionOverlay,
  drawTrendStrip,
  drawFooter,
} from '@/lib/ui/ppgCanvasRenderer';
import { drawGrid3DBackdrop, drawGrid3DLines, drawPreviewWell3D } from '@/lib/ui/ppg3dProjection';
import { usePpg3dSettings } from '@/store/ppg3dSettings';
import { realSignalStrength } from '@/lib/ui/waveHonesty';
import { PulseIndicator } from './PulseIndicator';
import { ActionButtons } from './ActionButtons';
import { MonitorControls } from './MonitorControls';
import { useMonitorViewport } from '@/hooks/useMonitorViewport';
import { PressureCoach } from './PressureCoach';
import { computeMonitorLayout, splitMorphologyPlot } from '@/lib/ui/monitorLayout';
import { drawPulseMorphology } from '@/lib/ui/pulseMorphologyRenderer';
import { drawEstimatedEcg } from '@/lib/ui/estimatedEcgRenderer';
import type { EcgEstimate } from '@/types/signal';
import { Info } from 'lucide-react';
import { EcgModelInfo } from './EcgModelInfo';

export interface PPGSignalMeterProps {
  value: number;
  quality: number;
  isFingerDetected: boolean;
  onStartMeasurement: () => void;
  onReset: () => void;
  isMonitoring?: boolean;
  arrhythmiaStatus?: string;
  rawArrhythmiaData?: {
    timestamp: number;
    rmssd: number;
    rrVariation: number;
  } | null;
  preserveResults?: boolean;
  isPeak?: boolean;
  bpm?: number | null;
  spo2?: number;
  respirationRate?: number;
  respirationStatus?: string;
  rrIntervals?: number[];
  elapsedTime?: number;
  perfusionIndex?: number;
  pressure?: { systolic: number; diastolic: number; confidence?: string; featureQuality?: number };
  bpStatus?: string | undefined;
  arrhythmiaCount?: number;
  contactState?: string;
  acquisitionStatus?: string;
  /** Contrato único del renderer (evita duplicar el tipo de diagnósticos). */
  diagnostics?: PpgRenderProps['diagnostics'];
}

export interface PPGSignalMeterHandle {
  pushSignal: (value: number, timestamp: number, sourceValue?: number) => void;
  pushEcgEstimate: (estimate: EcgEstimate) => void;
  clearBuffer: () => void;
}

function getSafeAreaBottom(): number {
  if (typeof document === 'undefined') return 0;
  const div = document.createElement('div');
  div.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  document.body.appendChild(div);
  const offset = parseInt(window.getComputedStyle(div).paddingBottom, 10) || 0;
  document.body.removeChild(div);
  return offset;
}

const PPGSignalMeter = React.forwardRef<PPGSignalMeterHandle, PPGSignalMeterProps>(({
  value,
  quality,
  isFingerDetected,
  onStartMeasurement,
  onReset,
  isMonitoring = false,
  arrhythmiaStatus,
  rawArrhythmiaData,
  preserveResults = false,
  isPeak = false,
  bpm = null,
  spo2 = 0,
  respirationRate = 0,
  respirationStatus,
  rrIntervals = [],
  elapsedTime = 0,
  perfusionIndex = 0,
  pressure,
  bpStatus,
  arrhythmiaCount = 0,
  contactState,
  acquisitionStatus,
  diagnostics,
}, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number | null>(null);
  const isRunningRef = useRef(false);
  const dataBufferRef = useRef<CircularBuffer | null>(null);
  const ecgBufferRef = useRef<CircularBuffer | null>(null);
  const ecgEstimateRef = useRef<EcgEstimate>();
  const ecgInspectionRef = useRef<{ buffer: CircularBuffer; estimate?: EcgEstimate }>();
  /** <video> de la cámara cacheado para el pozo 3D (se re-resuelve si se desmonta). */
  const videoWellRef = useRef<HTMLVideoElement | null>(null);

  const propsRef = useRef({
    value, quality, isFingerDetected, isMonitoring, arrhythmiaStatus,
    arrhythmiaCount, preserveResults, isPeak, bpm, spo2, respirationRate, respirationStatus, rrIntervals,
    rawArrhythmiaData, elapsedTime, perfusionIndex, pressure, bpStatus,
    contactState, acquisitionStatus, diagnostics,
  });

  const sweepPulseRef = useRef(0);
  const lastPeakTimeRef = useRef(0);
  const lastPeakProcessedRef = useRef(0);
  const arrActiveUntilRef = useRef(0);
  /** Latch: la onda se revela solo cuando la adquisición llega a READY (señal estable). */
  const traceRevealedRef = useRef(false);
  const [showPulse, setShowPulse] = useState(false);
  const [hasSamples, setHasSamples] = useState(false);
  const hasSamplesRef = useRef(false);
  const waveVisibilityRef = useRef({ strength: 0, traceRevealed: false });

  const lastArrhythmiaCountRef = useRef(0);
  const beatHistoryRef = useRef<{ isArrhythmia: boolean; time: number; rr: number }[]>([]);

  const amplitudeStatsRef = useRef({ min: -50, max: 50, range: 100 });

  const ibiDisplayRef = useRef<number>(0);
  const hrvDisplayRef = useRef<{ sdnn: number; rmssd: number; pnn50: number; cv: number }>({ sdnn: 0, rmssd: 0, pnn50: 0, cv: 0 });
  const bpmStatsRef = useRef<{ min: number; max: number; sum: number; n: number }>({ min: 0, max: 0, sum: 0, n: 0 });
  const bpmTrendRef = useRef<{ t: number; bpm: number; isArr: boolean }[]>([]);
  const lastBpmSampleRef = useRef<number>(0);
  const pendingTrendArrRef = useRef(false);
  const smoothedBpmRef = useRef<number>(0);
  const displayBpmRef = useRef(0);
  const displaySpo2Ref = useRef(0);
  const displaySysRef = useRef(0);
  const displayDiaRef = useRef(0);
  const waveGainRef = useRef(4.2);
  // Una única traslación de reloj conserva los intervalos de captura originales.
  const clockOffsetRef = useRef<number | null>(null);

  useImperativeHandle(ref, () => ({
    pushSignal: (val: number, timestampMs: number, sourceValue?: number) => {
      if (!dataBufferRef.current) return;
      if (!hasSamplesRef.current) { hasSamplesRef.current = true; setHasSamples(true); }
      const scaledValue = val * waveGainRef.current;
      const now = Date.now();
      const perfNow = typeof performance !== 'undefined' ? performance.now() : 0;
      clockOffsetRef.current ??= now - perfNow;
      // El procesador entrega reloj monotónico de captura; lo convertimos al
      // dominio de pared usado por el renderer sin volver a fechar al recibirlo.
      const sampleTime = Number.isFinite(timestampMs)
        ? (timestampMs > 100_000_000_000 || perfNow === 0
          ? timestampMs
          : timestampMs + clockOffsetRef.current)
        : now;
      const isArrhythmia = now < arrActiveUntilRef.current;
      dataBufferRef.current.push({
        time: sampleTime,
        value: scaledValue,
        sourceValue,
        isArrhythmia
      });
    },
    pushEcgEstimate: (estimate: EcgEstimate) => {
      ecgEstimateRef.current = estimate;
      if (estimate.status !== 'AVAILABLE') {
        ecgBufferRef.current?.clear();
        return;
      }
      const offset = clockOffsetRef.current ?? Date.now() - performance.now();
      for (const sample of estimate.samples) {
        if (!Number.isFinite(sample.value) || !Number.isFinite(sample.timestamp)) continue;
        ecgBufferRef.current?.push({
          time: sample.timestamp > 100_000_000_000 ? sample.timestamp : sample.timestamp + offset,
          value: sample.value,
          isArrhythmia: false,
        });
      }
    },
    clearBuffer: () => {
      dataBufferRef.current?.clear();
      ecgBufferRef.current?.clear();
      ecgEstimateRef.current = undefined;
      clockOffsetRef.current = null;
      hasSamplesRef.current = false; setHasSamples(false);
    }
  }));

  const layoutRef = useRef<PpgLayout>({
    width: 0, height: 0,
    header: { x: 0, y: 0, w: 0, h: 0 },
    metrics: { x: 0, y: 0, w: 0, h: 0 },
    plot: { x: 0, y: 0, w: 0, h: 0, centerY: 0 },
    trend: { x: 0, y: 0, w: 0, h: 0 },
    footer: { x: 0, y: 0, w: 0, h: 0 },
  });

  useEffect(() => {
    propsRef.current = {
      value, quality, isFingerDetected, isMonitoring, arrhythmiaStatus,
      arrhythmiaCount, preserveResults, isPeak, bpm, spo2, respirationRate, respirationStatus, rrIntervals,
      rawArrhythmiaData, elapsedTime, perfusionIndex, pressure, bpStatus,
      contactState, acquisitionStatus, diagnostics,
    };

    if (rrIntervals && rrIntervals.length >= 2) {
      const last = rrIntervals[rrIntervals.length - 1];
      if (isPhysiologicalRR(last)) {
        ibiDisplayRef.current = Math.round(last);
      }
      const hrv = calculateHRV(rrIntervals);
      hrvDisplayRef.current = {
        sdnn: Math.round(hrv.sdnn),
        rmssd: Math.round(hrv.rmssd),
        pnn50: Math.round(hrv.pnn50 * 100),
        cv: Number(hrv.cv.toFixed(3)),
      };
    }

    const nowMs = Date.now();

    if (bpm != null && bpm > 0) {
      displayBpmRef.current = bpm;
      smoothedBpmRef.current = bpm;
    }

    const pi = perfusionIndex ?? 0;
    const q = quality ?? 0;
    const weakTarget =
      4.2 *
      (pi < 0.0025 ? 2.1 : pi < 0.005 ? 1.65 : pi < 0.01 ? 1.35 : 1.08) *
      (q < 20 ? 1.4 : q < 40 ? 1.2 : 1);
    waveGainRef.current = waveGainRef.current * 0.40 + weakTarget * 0.60;

    if (bpm != null && bpm > 30 && bpm < 220 && nowMs - lastBpmSampleRef.current > 500) {
      lastBpmSampleRef.current = nowMs;
      const s = bpmStatsRef.current;
      const valToRecord = Math.round(smoothedBpmRef.current);

      if (s.n === 0) { s.min = valToRecord; s.max = valToRecord; }
      else {
        if (valToRecord < s.min) s.min = valToRecord;
        if (valToRecord > s.max) s.max = valToRecord;
      }
      s.sum += valToRecord; s.n += 1;

      bpmTrendRef.current.push({ t: nowMs, bpm: valToRecord, isArr: pendingTrendArrRef.current });
      pendingTrendArrRef.current = false;

      const cutoff = nowMs - TREND_WINDOW_MS;
      while (bpmTrendRef.current.length > 0 && bpmTrendRef.current[0].t < cutoff) {
        bpmTrendRef.current.shift();
      }
      if (bpmTrendRef.current.length > TREND_MAX_POINTS) {
        bpmTrendRef.current = bpmTrendRef.current.slice(-TREND_MAX_POINTS);
      }
    }
    if (!isFingerDetected && !preserveResults) {
      bpmStatsRef.current = { min: 0, max: 0, sum: 0, n: 0 };
      bpmTrendRef.current = [];
      pendingTrendArrRef.current = false;
      smoothedBpmRef.current = 0;
    }

    if (!isFingerDetected && !preserveResults) {
      displayBpmRef.current = 0;
      displaySpo2Ref.current = 0;
      displaySysRef.current = 0;
      displayDiaRef.current = 0;
    }
  }, [
    value, quality, isFingerDetected, arrhythmiaStatus, preserveResults,
    isPeak, bpm, spo2, respirationRate, respirationStatus, rrIntervals, rawArrhythmiaData, elapsedTime,
    perfusionIndex, pressure, bpStatus, arrhythmiaCount, isMonitoring,
    contactState, acquisitionStatus, diagnostics,
  ]);

  useEffect(() => {
    if (isPeak && isFingerDetected) {
      const now = Date.now();
      if (now - lastPeakTimeRef.current > 250) {
        lastPeakTimeRef.current = now;
        setShowPulse(true);
        const t = window.setTimeout(() => setShowPulse(false), 120);
        return () => window.clearTimeout(t);
      }
    }
  }, [isPeak, isFingerDetected]);

  useEffect(() => {
    if (!dataBufferRef.current) {
      dataBufferRef.current = new CircularBuffer(BUFFER_SIZE);
      ecgBufferRef.current = new CircularBuffer(BUFFER_SIZE);
    }
  }, []);

  useEffect(() => {
    if (preserveResults && !isFingerDetected) {
      dataBufferRef.current?.clear();
      ecgBufferRef.current?.clear();
      hasSamplesRef.current = false; setHasSamples(false);
    }
  }, [preserveResults, isFingerDetected]);

  const [layoutUi, setLayoutUi] = useState(layoutRef.current);
  const [hybrid, setHybrid] = useState(true);
  const [analysisMode, setAnalysisMode] = useState<'ecg' | 'derivatives'>('derivatives');
  const analysisModeRef = useRef<'ecg' | 'derivatives'>('derivatives');
  const [showModelInfo, setShowModelInfo] = useState(false);
  const toggleAnalysisMode = useCallback(() => {
    analysisModeRef.current = analysisModeRef.current === 'ecg' ? 'derivatives' : 'ecg';
    setAnalysisMode(analysisModeRef.current);
  }, []);
  const hybridRef = useRef(true);
  const toggleHybrid = useCallback(() => {
    hybridRef.current = !hybridRef.current;
    setHybrid(hybridRef.current);
  }, []);
  const viewport = useMonitorViewport(dataBufferRef, amplitudeStatsRef, layoutRef, waveVisibilityRef);
  const viewportRef = viewport.view;
  useLayoutEffect(() => {
    if (!viewport.inspecting) { ecgInspectionRef.current = undefined; return; }
    const points = ecgBufferRef.current?.getPoints() ?? [];
    const copy = new CircularBuffer(Math.max(1, points.length));
    for (const point of points) copy.push({ ...point });
    ecgInspectionRef.current = { buffer: copy, estimate: ecgEstimateRef.current };
  }, [viewport.inspecting]);
  const reducedMotionRef = useRef(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { reducedMotionRef.current = media.matches; };
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const recomputeLayout = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    // Mantener nitidez en pantallas densas, con un presupuesto total de píxeles.
    const maxDpr = Math.max(1, Math.min(3, Math.sqrt(8_000_000 / Math.max(1, rect.width * rect.height))));
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const cssW = Math.max(320, Math.floor(rect.width));
    const cssH = Math.max(320, Math.floor(rect.height));
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    layoutRef.current = computeMonitorLayout(cssW, cssH, getSafeAreaBottom(), viewportRef.current.focus);
    setLayoutUi(layoutRef.current);
  }, [viewportRef]);

  useLayoutEffect(() => {
    recomputeLayout();
    const ro = new ResizeObserver(() => recomputeLayout());
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener('orientationchange', recomputeLayout);
    return () => {
      ro.disconnect();
      window.removeEventListener('orientationchange', recomputeLayout);
    };
  }, [recomputeLayout, viewport.focus]);

  useEffect(() => {
    if (isRunningRef.current) return;
    isRunningRef.current = true;

    // En Android, 30 fps de renderizado bastan para una captura PPG de ~30 Hz
    // y liberan tiempo de CPU para cámara y Worker. Escritorio conserva 60 fps.
    const targetFps = isNative() || window.matchMedia('(pointer: coarse)').matches ? 30 : TARGET_FPS;
    const frameTime = 1000 / targetFps;
    let lastRenderTime = 0;
    const initialClockOffset = Date.now() - performance.now();

    const render = (rafTimestamp: number) => {
      if (!isRunningRef.current) return;
      const canvas = canvasRef.current;
      const buffer = dataBufferRef.current;
      if (!canvas || !buffer) {
        animationRef.current = requestAnimationFrame(render);
        return;
      }
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) {
        animationRef.current = requestAnimationFrame(render);
        return;
      }
      // RAF provee un reloj monotónico para evitar jitter por Date.now().
      if (rafTimestamp - lastRenderTime < frameTime - 0.25) {
        animationRef.current = requestAnimationFrame(render);
        return;
      }
      lastRenderTime = rafTimestamp;
      const now = rafTimestamp + (clockOffsetRef.current ?? initialClockOffset);

      const p = propsRef.current;
      const fingerOn = p.isFingerDetected;
      const preserve = p.preserveResults;
      const targetBpm = !fingerOn && !preserve ? 0 : Math.max(0, p.bpm ?? 0);
      const targetSpo2 = fingerOn || preserve ? p.spo2 ?? 0 : 0;
      const targetSys = fingerOn || preserve ? p.pressure?.systolic ?? 0 : 0;
      const targetDia = fingerOn || preserve ? p.pressure?.diastolic ?? 0 : 0;
      // Already filtered by the router: render directly, regardless of canvas FPS.
      displayBpmRef.current = Math.round(targetBpm);
      displaySpo2Ref.current = Math.round(targetSpo2);
      displaySysRef.current = Math.round(targetSys);
      displayDiaRef.current = Math.round(targetDia);

      // La onda se muestra SIEMPRE, con altura honesta (signalStrength). El latch
      // solo controla el indicador fino de progreso (barra), que desaparece al
      // estabilizar (READY). No se oculta ni se limpia el trazo → onda continua.
      const diagRec = p.diagnostics as
        | { acquisitionStage?: string; sqm?: { periodicity?: number } }
        | undefined;
      const acqStage = diagRec?.acquisitionStage;
      if (!fingerOn && !preserve) {
        traceRevealedRef.current = false;
      } else if (!traceRevealedRef.current && acqStage === 'READY') {
        traceRevealedRef.current = true;
      }
      // Fuerza pulsátil real → comprime la altura de la onda (inerte → plana).
      const periodicityNow =
        typeof diagRec?.sqm?.periodicity === 'number' ? diagRec.sqm.periodicity : 0;
      const signalStrengthNow = fingerOn
        ? realSignalStrength(p.perfusionIndex ?? 0, periodicityNow)
        : 0;

      waveVisibilityRef.current = { strength: signalStrengthNow, traceRevealed: traceRevealedRef.current };
      const threeDState = usePpg3dSettings.getState();

      const renderState: PpgRenderState = {
        layout: layoutRef.current,
        props: {
          value: p.value, quality: p.quality, isFingerDetected: p.isFingerDetected,
          isMonitoring: p.isMonitoring, isPeak: p.isPeak ?? false, preserveResults: p.preserveResults,
          bpm: p.bpm, spo2: p.spo2 ?? 0, respirationRate: fingerOn || preserve ? p.respirationRate : 0, respirationStatus: p.respirationStatus, rrIntervals: p.rrIntervals ?? [],
          elapsedTime: p.elapsedTime ?? 0, perfusionIndex: p.perfusionIndex ?? 0,
          pressure: p.pressure, bpStatus: p.bpStatus,
          arrhythmiaStatus: p.arrhythmiaStatus, arrhythmiaCount: p.arrhythmiaCount ?? 0,
          contactState: p.contactState, acquisitionStatus: p.acquisitionStatus,
          diagnostics: p.diagnostics,
        },
        now,
        windowMs: viewportRef.current.windowMs,
        inspection: viewportRef.current.inspection,
        reducedMotion: reducedMotionRef.current,
        showAnnotations: viewportRef.current.annotations,
        displayBpm: displayBpmRef.current,
        displaySpo2: displaySpo2Ref.current,
        displaySys: displaySysRef.current,
        displayDia: displayDiaRef.current,
        hrv: hrvDisplayRef.current,
        bpmStats: bpmStatsRef.current,
        bpmTrend: bpmTrendRef.current,
        beatHistory: beatHistoryRef.current,
        amplitudeStats: amplitudeStatsRef.current,
        waveGain: waveGainRef.current,
        sweepPulse: sweepPulseRef.current,
        ibiDisplay: ibiDisplayRef.current,
        buffer: dataBufferRef.current,
        lastArrhythmiaCount: lastArrhythmiaCountRef.current,
        pendingTrendArr: pendingTrendArrRef.current,
        lastPeakProcessedTime: lastPeakProcessedRef.current,
        arrActiveUntil: arrActiveUntilRef.current,
        traceRevealed: traceRevealedRef.current,
        signalStrength: signalStrengthNow,
        threeD: { enabled: threeDState.enabled && !viewportRef.current.inspection, intensity: threeDState.intensity },
      };

      drawBackground(ctx, layoutRef.current.width, layoutRef.current.height);
      drawHeader(ctx, renderState);
      drawMetricsBar(ctx, renderState);
      const fullLayout = renderState.layout;
      const channels = splitMorphologyPlot(fullLayout.plot, hybridRef.current);
      renderState.layout = { ...fullLayout, plot: channels.main };
      if (renderState.threeD?.enabled) {
        drawGrid3DBackdrop(ctx, renderState);
        drawGrid3DLines(ctx, renderState);
      } else {
        drawECGGrid(ctx, renderState);
      }
      drawSignal(ctx, renderState);
      // Guía de presión SIEMPRE visible (2D y 3D): bucle visual cerrado con el
      // háptico. Va DESPUÉS de la onda — antes quedaba debajo y no se veía.
      drawPressureGauge(ctx, renderState);
      drawAcquisitionOverlay(ctx, renderState);
      if (!videoWellRef.current || !videoWellRef.current.isConnected) {
        videoWellRef.current = document.querySelector('video');
      }
      const mainLayout = renderState.layout;
      if (channels.morphology.h > 0) {
        renderState.layout = { ...fullLayout, plot: channels.morphology };
        if (analysisModeRef.current === 'ecg') {
          const frozen = renderState.inspection ? ecgInspectionRef.current : undefined;
          drawEstimatedEcg(ctx, renderState,
            renderState.inspection ? frozen?.buffer ?? null : ecgBufferRef.current,
            renderState.inspection ? frozen?.estimate : ecgEstimateRef.current,
          );
        } else {
          drawPulseMorphology(ctx, renderState);
        }
      }
      // En horizontal, la guía ocupa una columna propia y conserva su altura.
      const capture = fullLayout.capturePreview;
      renderState.layout = capture ? { ...fullLayout, plot: { ...capture, centerY: capture.y + capture.h / 2 } } : mainLayout;
      drawPreviewWell3D(ctx, renderState, videoWellRef.current, p.contactState);
      renderState.layout = fullLayout;
      if (layoutRef.current.trend.h > 0) drawTrendStrip(ctx, renderState);
      if (layoutRef.current.footer.h > 0) drawFooter(ctx, renderState);

      sweepPulseRef.current = renderState.sweepPulse;
      lastPeakProcessedRef.current = renderState.lastPeakProcessedTime;
      arrActiveUntilRef.current = renderState.arrActiveUntil;
      lastArrhythmiaCountRef.current = renderState.lastArrhythmiaCount;
      pendingTrendArrRef.current = renderState.pendingTrendArr;
      beatHistoryRef.current = renderState.beatHistory;
      amplitudeStatsRef.current = renderState.amplitudeStats;

      animationRef.current = requestAnimationFrame(render);
    };

    animationRef.current = requestAnimationFrame(render);

    return () => {
      isRunningRef.current = false;
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [viewportRef]);

  const returnLive = viewport.returnLive;
  const handleReset = useCallback(() => {
    returnLive();
    dataBufferRef.current?.clear();
    ecgBufferRef.current?.clear();
    ecgEstimateRef.current = undefined;
    ecgInspectionRef.current = undefined;
    clockOffsetRef.current = null;
    hasSamplesRef.current = false; setHasSamples(false);
    amplitudeStatsRef.current = { min: -50, max: 50, range: 100 };
    beatHistoryRef.current = [];
    lastArrhythmiaCountRef.current = 0;
    lastPeakProcessedRef.current = 0;
    arrActiveUntilRef.current = 0;
    ibiDisplayRef.current = 0;
    hrvDisplayRef.current = { sdnn: 0, rmssd: 0, pnn50: 0, cv: 0 };
    bpmStatsRef.current = { min: 0, max: 0, sum: 0, n: 0 };
    bpmTrendRef.current = [];
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas!.width, canvas!.height);
    }
    onReset();
  }, [onReset, returnLive]);

  return (
    <div ref={containerRef} className="monitor-shell fixed inset-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        className="monitor-canvas absolute inset-0 w-full h-full"
        role="img" tabIndex={0} aria-label="Monitor de señal óptica PPG interactivo" aria-describedby="monitor-gestures"
        {...viewport.canvasHandlers}
      />
      <dl className="sr-only" aria-label="Valores del monitor">
        <dt>Pulso</dt><dd>{isFingerDetected || preserveResults ? bpm || 'Sin lectura' : 'Sin lectura'} BPM</dd>
        <dt>Saturación estimada</dt><dd>{isFingerDetected || preserveResults ? spo2 || 'Sin lectura' : 'Sin lectura'} %</dd>
        <dt>Presión estimada</dt><dd>{(isFingerDetected || preserveResults) && pressure?.systolic && pressure?.diastolic ? `${pressure.systolic}/${pressure.diastolic} mmHg` : 'Sin lectura'} · {bpStatus}</dd>
        <dt>Respiración estimada</dt><dd>{(isFingerDetected || preserveResults) && respirationRate > 0 ? `${Math.round(respirationRate)} rpm` : 'Sin lectura'} · {respirationStatus}</dd>
      </dl>
      <PulseIndicator showPulse={showPulse} />
      {/* Guía de colocación: vive DENTRO de la ventana de previsualización
          (canvas). Aquí sólo queda el anuncio accesible: la tarjeta flotante
          tapaba la ventana y era el "cartel" que el usuario pidió retirar. */}
      <PressureCoach
        srOnly
        evidence={
          diagnostics?.placementEvidence as
            | import('@/lib/finger/fingerPlacementEvidence').FingerPlacementEvidence
            | undefined
        }
        isMonitoring={isMonitoring}
      />
      <MonitorControls viewport={viewport} layout={layoutUi} quality={quality} isMonitoring={isMonitoring} hasSamples={hasSamples} hybrid={hybrid} onToggleHybrid={toggleHybrid} analysisMode={analysisMode} onToggleAnalysisMode={toggleAnalysisMode} />
      {hybrid && analysisMode === 'ecg' && splitMorphologyPlot(layoutUi.plot, true).morphology.h > 0 && <button type="button" className="monitor-model-info" aria-label="Ver evaluación del modelo PPG a ECG" title="Resultados reales de evaluación del modelo" onClick={() => setShowModelInfo(true)} style={{ top: splitMorphologyPlot(layoutUi.plot, true).morphology.y, left: layoutUi.plot.x + layoutUi.plot.w - 36 }}><Info size={16}/></button>}
      {showModelInfo && <EcgModelInfo onClose={() => setShowModelInfo(false)}/>}
      <div className="sr-only" role="status" aria-live="polite">
        <div><span className="monitor-eyebrow">{viewport.inspecting ? 'VISTA DE ANÁLISIS' : isMonitoring ? 'CONTACTO Y ADQUISICIÓN' : 'LISTO PARA COMENZAR'}</span>
          <p>{viewport.inspecting ? (isMonitoring ? 'Explora el registro; la medición sigue activa.' : 'Explora el registro de la sesión.') : isMonitoring ? diagnostics?.placementEvidence?.guidance?.headline || 'Apoya la yema suavemente sobre la cámara.' : 'Apoya la mano. Inicia cuando estés cómodo.'}</p></div>
        <span className="monitor-seal">{Math.round((diagnostics?.placementEvidence?.seal ?? 0) * 100)}<small>% cobertura</small></span>
      </div>
      <ActionButtons
        isMonitoring={isMonitoring}
        onStartMeasurement={onStartMeasurement}
        onReset={handleReset}
      />
    </div>
  );
});

export default PPGSignalMeter;
