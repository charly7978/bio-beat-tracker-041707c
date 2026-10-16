# Arquitectura — Bio Beat Tracker (PPG por cámara)

Documentación alineada al código en `main`. **No es validación clínica SaMD**; describe el pipeline técnico real, sus límites y trazabilidad.

## Resumen

Aplicación React/TypeScript que estima signos vitales a partir de **fotopletismografía (PPG)** con la cámara trasera del smartphone y el **flash (torch)**. Cada valor publicado lleva (o debe llevar) `status`, `confidence`, `reason` y métricas de calidad; **no se inventan números** cuando la señal es insuficiente.

## Flujo end-to-end

```
CameraView (MediaStream, torch, capabilities/settings)
    │ requestVideoFrameCallback + FPS/jitter reales
    │ torch verificado vía applyConstraints→getSettings
    ▼
useSignalProcessor → PPGSignalProcessor  ─┐
    │ ROI 5×5 tiling + pulsatility-fusion │  hoja de ruta Web Worker
    │ fingerSceneClassifier (hemoglobina  │  src/workers/ppgSignal.worker.ts
    │  + pulsatilidad CV + ensemble)      │  → PPGSignalProcessor en worker
    │ AC/DC preciso, Bandpass Butterworth│     (init/start/stop/processFrame/motion/
    │ 4º orden + Bessel 0.5–12 Hz morfo   │      setCameraRuntimeHints/setMeasurementMode)
    │ activeStabilizer + pulseAgc + SQI  │  Si worker no disponible (CSP/WebView):
    │ AdaptiveRuntimePolicy (roiScale/    │  FALLBACK main-thread REAL — el mismo
    │  bandLow/Hi, sourceHysteresis)      │  PPGSignalProcessor en el hilo principal
    ▼                                     │  con contrato idéntico (handleSignalReady)
ProcessedSignal (con splitter: hr/spo2/morph/resp/arr)
    ├─► useHeartBeatProcessor → HeartBeatProcessor
    │       PeakDetectionEnsemble (Elgendi MApeak/MAbeat + scorePeakCandidate)
    │       → BPM, RR, isPeak, ensembleDiagnostics, HampelOnline
    │       + GymMotionCancellation (AdaptiveNotch por cadencia 60–180 spm)
    └─► useVitalSignsProcessor → VitalSignsProcessor
            ├─ SpO2Calculator (Beer-Lambert ratio-of-ratios R/G, DEMA-DC)
            ├─ BloodPressureProcessor (PWA 74 features, b/a d/a AIx SI)
            ├─ respiratorySmartFusion (RIAV+RIIV+RIFV+ACC, Karlen 2013)
            └─ ArrhythmiaProcessor (RMSSD/pNN31/pNN50/Shannon/SampEn, deadband)
    ▼
Index.tsx → PPGSignalMeter (Canvas 2D Catmull-Rom + 3D ribbon)
          + DebugTelemetryPanel + Supabase (measurements + local encrypted)
          + useSignalRouter (throttle HR 80 ms / vitals 300 ms, latch, sanity)
          + useMeasurementSession (60 s, 60 s trend)
          + SplashScreen / SettingsPanel / MeasurementSummaryModal (extraídos)
Medición dual: finger (trasera+flash) vs gym (frontal POS Wang 2017, rPPG)
```

**Estructura de UI (2026-10-16):** `Index.tsx` quedó como orquestador (~1.1k
líneas); los tres bloques grandes se extrajeron a componentes de render puro con
props explícitas:

- `src/components/SplashScreen.tsx` — puerta de entrada (selector de modo + start);
  versión de build vía `__APP_VERSION__` (inyectada por `vite.config.ts` desde package.json).
- `src/components/measurement/MeasurementSummaryModal.tsx` — resumen post-medición
  (BPM/SpO2/PA, barras de ritmo, Poincaré, veredicto de `MeasurementWindowValidator`, CTA de análisis IA).
- `src/components/SettingsPanel.tsx` — panel de ajustes (perfil, calibración, historial, sync);
  `activeTab` es estado local del panel; `HistoricalMeasurement`/`ActiveUser` se exportan desde aquí.

**Fallback worker → main-thread (implementado 2026-10-15):** si `new Worker`
falla (CSP, WebView antiguo), `useSignalProcessor` instancia `PPGSignalProcessor`
en el hilo principal con el mismo pipeline y contrato (`onSignalReady` →
`handleSignalReady`, telemetría RGB/backpressure, hot-path callback). La
contrapresión drop-newest solo aplica al modo worker (en main-thread todo se
procesa sincrónico). Expuesto como `isFallbackMode` para diagnóstico. Nunca se
degrada a "señal inventada": si tampoco el main-thread inicia, el estado es
`ERROR` explícito.

## Fuentes de verdad (anti-duplicación)

| Dominio | Módulo canónico |
|--------|------------------|
| Contrato de medición | `src/types/measurements.ts` (`VitalMeasurement`, `PeakDetectionResult`) |
| Umbrales fisiológicos | `src/config/vitalThresholds.ts` (HR 30–220, RR 270–2200 ms, SQI, PLACEMENT) |
| DSP / picos (ventanas, BPM min/max) | `src/config/signalProcessing.ts` (PEAK_DETECTION_DEFAULTS, DSP_CONSTANTS) |
| Filtros y utilidades DSP | `src/modules/signal-processing/shared/dsp.ts` + `BandpassFilter.ts` (Butterworth 4º) / `BesselFilter.ts` (Bessel 4º fase lineal). Momentos de ventana (skewness/kurtosis en exceso) en `shared/dsp.ts:computeWindowMoments` |
| SQI central | `src/modules/signal-quality/SignalQualityIndex.ts` (skewness SQI óptimo Elgendi 2016, perfusión, PI) |
| Calibración | `src/modules/vital-signs/CalibrationManager.ts` (SPO2/BP antropométrico + offset por referencia) |
| Estado de adquisición | `src/lib/acquisition/resolveAcquisitionStatus.ts` + `AcquisitionStabilizer.ts` |
| Honestidad de onda | `src/lib/ui/waveHonesty.ts` (`realSignalStrength = perf×per` AND — prioridad no-lectura) |
| Backpressure | `src/lib/perf/backpressureConfig.ts` (stride 3↔4, checked 1 s, hysteresis) |
| Suavizado EMA adaptativo | `src/lib/measurement/adaptiveEma.ts` (núcleo único; wrappers: `displaySmoothing.ts` capa UI y `modules/vital-signs/DisplaySmoothing.ts` capa procesador) |
| Perfil de cámara (FPS/resolución por modo) | `src/lib/device/cameraDeviceProfile.ts` (CAMERA_TARGET_FPS/MIN_FPS/RESOLUTION; consumido por `CameraView.tsx`) |
| UI compartida (toasts) | `src/config/ui.ts` (TOAST_LIMIT, TOAST_REMOVE_DELAY; consumido por `use-toast.ts`) |
| Servidores ICE (telemetría P2P) | `src/config/webrtc.ts` (consumido por `WebrtcCallWidget.tsx`) |

CI ejecuta `npm run check:architecture` para impedir procesadores paralelos y rutas legacy.
`check:orphans` verifica 0 huérfanos; `check:no-sim` prohibe Math.random/mock/synthetic sin allowlist auditada.

## Cámara y flash

`CameraView` usa la API estándar:

- `getSupportedConstraints`, `getCapabilities`, `getSettings`, `applyConstraints`
- Informe `DeviceCapabilityReport`: resolución real, FPS efectivo, `timestampJitterMs`, `frameDropRatio`, torch soportado/activo

La medición **no asume** torch ni FPS solicitados: baja `confidence` o bloquea con estados técnicos (`TORCH_UNAVAILABLE`, `LOW_FPS`, etc.).

## ROI y contacto con el dedo

`PPGSignalProcessor` + `fingerSceneClassifier` / `fingerRoiPulsation`:

- ROI central y adaptativo, rechazo de saturación/subexposición
- **No se acepta dedo solo por color**: hace falta evidencia pulsátil (perfusión, estabilidad temporal)
- Estados: `NO_CONTACT`, `UNSTABLE_CONTACT`, `VALID_CONTACT`, saturación, movimiento, etc.

## Detección de picos

### Elgendi (`ElgendiPeakDetector.ts`)

Basado en medias móviles de evento (MApeak / MAbeat), offset adaptativo, un pico por bloque, distancia mínima según BPM máximo, prominencia y SQI.

### Ensemble (`PeakDetectionEnsemble.ts`)

1. Ejecuta `ElgendiPeakDetector` sobre la ventana PPG.
2. Puntuación de picos individual con `scorePeakCandidate` (SQI + perfusión + RR + acuerdo Elgendi).
3. Devuelve `PeakDetectionResult`: `peaks`, `peakTimes`, `peakScores`, `rrIntervalsMs`, `bpmInstant`, `confidence`, `agreement`, `diagnostics` (incluye `elgendiPeakTimes`, `elgendiConfidence`, `fusedPeakTimes` para UI).

`HeartBeatProcessor` es el **único** consumidor productivo del ensemble para BPM y emite `ensembleDiagnostics` hacia la UI.

## SQI y vitales

`SignalQualityIndex` calcula SQI a partir de perfusión, SNR (amplitud de modulación ×1000), periodicidad, skewness y kurtosis en exceso (Elgendi 2016), clipping, saturación, movimiento, FPS y jitter.

`enrichMetrics()` combina el SQI de frame con el acuerdo Elgendi para que SpO2, PA y respiración no traten como “buena” una señal con picos incoherentes.

Reglas típicas:

| Medición | Condición para `VALID` |
|----------|-------------------------|
| BPM | dedo, ventana, SQI, ensemble coherente, sin movimiento dominante |
| SpO2 | calibración vigente, canales estables, sin saturación |
| PA | **calibración individual vigente** (`REQUIRES_CALIBRATION` / `CALIBRATION_EXPIRED` si no) |
| Respiración | ventana mínima, SQI, BPM estable |
| Irregularidad | RR fiables del ensemble |

## UI de depuración

- **PPGSignalMeter**: onda 2 s, picos ▲ Elgendi, picos de latido (audio/háptico).
- **DebugTelemetryPanel**: SQI, PI, FPS, jitter, acuerdo, torch, estado de adquisición.

## Supabase

Se conservan intentos y mediciones con metadatos de calidad; **no** se deben persistir lecturas inválidas como resultados clínicos finales sin `status`/`reason`. El edge function `secure-proxy` fue **eliminado** (dead code: sin referencias en el cliente); el único invocado desde `src/` es `analyze-vitals`.

### Persistencia (`measurements`) — cableado 2026-10-16

La fila final ahora escribe trazabilidad real además de los valores básicos:

| Columna | Origen |
|---|---|
| `algorithm_version` | `__APP_VERSION__` inyectada en build (null en tests/node) |
| `measurement_confidence` | `VitalSignsResult.measurementConfidence` (`HIGH`/`MEDIUM`/`LOW`/`INVALID`, misma política que el gate de estabilidad) |
| `measurement_window_seconds` | Reloj real de la sesión (`elapsedTime` al finalizar) |
| `signal_quality_index` | SQI redondeado usado por la política de guardado |

Esquema: migraciones idempotentes `20260606014823` (duplicaba `measurement_attempts`),
`20260925000001` (columnas extra de `measurements`) y `20260925000002`
(FK `perf_snapshots.user_id → auth.users` con `ON DELETE CASCADE`).
`analyze-vitals` valida rangos fisiológicos alineados al canónico de la app
(HR 30–220, SpO2 75–100, sistólica 20–280, diastólica 40–130) y requiere
`LOVABLE_API_KEY` en el entorno del edge.

### Secretos y almacenamiento local (auditado 2026-10-15)

- `.env` **eliminado del control de versiones** (`git rm --cached .env`, 2026-10-15):
  seguía trackeado desde commits antiguos pese a `.gitignore`. El archivo local
  se conserva para desarrollo. Si el repo fue público, la anon/publishable key
  debe rotarse (RLS verificado en las 7 migraciones: `auth.uid() = user_id`).
- Ninguna `service_role` key en `src/` (verificado: 0 coincidencias).
- Mediciones locales y dataset de validación se guardan **cifrados** con
  `src/lib/storage/localEncryptedStorage.ts` (AES-GCM, clave en dispositivo).
  Semántica honesta documentada en el módulo: **ofuscación local, no
  almacenamiento seguro** — sin `crypto.subtle` (HTTP no seguro) el sistema
  NO escribe en plano, degrada a no-guardar.

## Tests y CI

```bash
npm run check:all
# lint + typecheck + check:orphans + check:no-sim + test + build + check:no-sim:dist
npm run check:architecture
```

Tests relevantes: `Detectors.test.ts`, `PPGSignalProcessor.test.ts`, `fingerRoiPulsation.test.ts`, `resolveAcquisitionStatus.test.ts`.

## Ejecución y concurrencia

- **Worker disponible**: `src/workers/ppgSignal.worker.ts` mueve `PPGSignalProcessor` fuera del main thread
  (postMessage ImageData → ProcessedSignal). Backpressure stride 3→4 se negocia vía `setBackpressureConfig`.
  Fallback automático a main thread si `Worker` no disponible o `?worker` bloqueado por CSP.
- **Main thread optimizado**: ring buffers `RingF32` (Float32Array, O(1) push, sin `Array.shift`),
  `CircularBuffer` para `PPGDataPoint` con isArrhythmia, scratch `Float32Array(120)` reutilizable,
  LUTs de teselado, throttling de periodicidad cada 4 frames, coalescing de SQI/skew cada 8 frames.
- **Hooks**: `useSignalRouter` centraliza throttles (`HR 80 ms, vitals 300 ms, signal 16 ms`) y
  evita rerenders por frame; `useFrameLoop` con `requestVideoFrameCallback` preferente.

## Limitaciones explícitas

- Estimaciones **orientativas** sin calibración de usuario (especialmente SpO2 y PA).
- Variabilidad entre dispositivos (sensor RG-Bayer, torch, FPS, AE/WB).
- No sustituye un pulsioxímetro ni un tensiómetro certificado.
- SpO2 usa verde como proxy IR (Beer–Lambert) — requiere calibración para uso clínico.
- BP estimado por PWA solo orientativo sin referencia de tensiómetro; `REQUIRES_CALIBRATION` si no hay perfil vigente. **El regresor MLP se entrenó sobre datos sintéticos (fórmulas sobre features aleatorios, `training/train_bp_mlp.py`); precisión clínica no validada — ver `docs/medical-validation.md`.**
- rPPG frontal (gym) MAE competitivo 4–5 bpm (POS-SSA Wang 2026 JAIT 17(4):788) pero sensible a iluminación/movimiento facial.

## Referencias internas

- `docs/medical-validation.md` — estado de validación por métrica (qué existe, qué NO existe, procedimiento Bland–Altman pendiente)
- `docs/repository-cleanup.md` — depuración previa y mapa histórico
- `docs/no-simulation-audit.md` — política anti-simulación en runtime
- `training/README.md` — pipelines de entrenamiento (solo el MLP de PA está integrado)
