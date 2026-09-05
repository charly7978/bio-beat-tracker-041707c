# Contexto del proyecto bio-beat-tracker para skills de dominio

## Gates sagrados (preservar siempre)

- **Hemodinámica viva**: toda métrica deriva de píxeles reales + flash; sin contacto → `filtered=0`, `quality=0`, `status NO_FINGER`, UI `--`. Nunca inventar BPM/SpO2/PA.
- **Skewness SQI óptimo** (Elgendi 2016): `SKEWNESS_SQI_LOW -0.3`, `HIGH 0.2`, `FLOOR 0.55` en `vitalThresholds.ts` — penalización suave de confianza, no bloqueo duro.
- **Wave honesty**: `src/lib/ui/waveHonesty.ts:22` → `perf*per` AND; ver test `objeto MOVIDO <0.1`.
- **RR fisiológico**: `PHYSIOLOGICAL_RR_MIN_MS 270 / MAX 2200` solo en `vitalThresholds.ts`; resto importa.
- **BPM solo vía pico validado**: `HeartBeatProcessor.processSignal` + `PeakDetectionEnsemble` (Elgendi + scorePeakCandidate + periodicity), nunca `setTimeout`/`Math.random`.

## Rutas reales (verificar contra disco)

- `src/config/vitalThresholds.ts` — umbrales clínicos (HR, SPO2, BP, QUALITY, ACQUISITION, STABILIZATION, TILE_FUSION, ARRHYTHMIA, FINGER)
- `src/config/signalProcessing.ts` — `PEAK_DETECTION_DEFAULTS`, `DSP_CONSTANTS` (BUFFER 300, SOURCE 120)
- `src/types/measurements.ts` — `VitalMeasurement<T>`, `PeakDetectionResult`, `MeasurementStatus`
- `src/modules/signal-processing/PPGSignalProcessor.ts` — ROI 5×5, fingerSceneClassifier, AC/DC preciso, Bandpass+Bessel, activeStabilizer, tileFusion
- `src/modules/HeartBeatProcessor.ts` — circular Float64, SQI skewness, predictive Kalman-like BPM
- `src/modules/signal-processing/detectors/ElgendiPeakDetector.ts` + `PeakDetectionEnsemble.ts`
- `src/modules/signal-processing/shared/BesselFilter.ts` + `BandpassFilter.ts` + `dsp.ts`
- `src/modules/signal-quality/SignalQualityIndex.ts` — `calculate()`, `enrichMetrics()`, `resolveDiagnosticDisplayStatus()`
- `src/lib/measurement/` — `peakScoring`, `detectorCalibration`, `peakEmitPolicy`, `signalStabilization`
- `src/lib/ui/waveHonesty.ts` + `ppgMonitorClinical.ts` + `ppgCanvasRenderer.ts`
- `src/workers/ppgSignal.worker.ts` — off-main con fallback
- `docs/no-simulation-audit.md` + `docs/ARCHITECTURE.md` — auditorías vivas
- `scripts/check-no-simulation.mjs` (+ `.dist`) + `check-architecture.mjs` + `check-orphan-imports.mjs`

## Comandos verificación (package.json)

```
npm run lint
npm run typecheck
npm run check:orphans
npm run check:architecture
npm run check:no-sim
npm run test
npm run build
npm run check:no-sim:dist
npm run check:all  # todo lo anterior en orden
```

## Antipatrones prohibidos

- `Math.random`, `mock/fake/dummy/synthetic/simulate` en `src/` sin `// anti-sim-allow: reason="..." ref="..."`
- `Math.sin/cos/tan` fuera de filtros IIR; `120/80`/`98%` hardcodeado; baseline fijo
- Procesador duplicado `*V2`/`FinalProcessor`; export `ElgendiPeakDetector` fuera de `detectors/`
- Publicar vital `VALID` con SQI < umbral o sin RR fisiológico
