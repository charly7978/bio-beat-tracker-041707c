# Arquitectura — Bio Beat Tracker (PPG por cámara)

Documentación del pipeline técnico actual. **No es validación clínica SaMD**; los estados `VALID` son estados internos del software y no demuestran exactitud clínica.

## Resumen

Aplicación React/TypeScript que estima signos vitales a partir de **fotopletismografía (PPG)** con la cámara trasera del smartphone y el **flash (torch)**. Cada valor publicado lleva (o debe llevar) `status`, `confidence`, `reason` y métricas de calidad; **no se inventan números** cuando la señal es insuficiente.

## Flujo end-to-end

```
CameraView (MediaStream, torch, capabilities/settings)
    │ requestVideoFrameCallback + FPS/jitter reales
    ▼
useSignalProcessor → PPGSignalProcessor
    │ ROI adaptativo, dedo (color + dinámica), AC/DC, bandpass, SQI frame
    │ procesamiento DSP en `src/workers/ppgSignal.worker.ts`
    ▼
ProcessedSignal
    ├─► useHeartBeatProcessor → HeartBeatProcessor
    │       PeakDetectionEnsemble (Elgendi optimizado)
    │       → BPM, RR, isPeak, ensembleDiagnostics
    └─► useVitalSignsProcessor → VitalSignsProcessor
            ├─ SpO2 (ratio-of-ratios + calibración)
            ├─ BloodPressureProcessor (morfología + calibración individual)
            ├─ respiración (modulación PPG)
            └─ ArrhythmiaProcessor (RR + HRV)
    ▼
Index.tsx → PPGSignalMeter + DebugTelemetryPanel + Supabase
```

## Fuentes de verdad (anti-duplicación)

| Dominio | Módulo canónico |
|--------|------------------|
| Contrato de medición | `src/types/measurements.ts` (`VitalMeasurement`, `PeakDetectionResult`) |
| Umbrales fisiológicos | `src/config/vitalThresholds.ts` |
| DSP / picos (ventanas, BPM min/max) | `src/config/signalProcessing.ts` |
| Filtros y utilidades DSP | `src/modules/signal-processing/shared/dsp.ts` |
| SQI central | `src/modules/signal-quality/SignalQualityIndex.ts` |
| Calibración | `src/modules/vital-signs/CalibrationManager.ts` |
| Estado de adquisición | `src/lib/acquisition/resolveAcquisitionStatus.ts` |

CI ejecuta `npm run check:architecture` para impedir procesadores paralelos y rutas legacy.

## Cámara y flash

`CameraView` usa la API estándar:

- `getSupportedConstraints`, `getCapabilities`, `getSettings`, `applyConstraints`
- Informe `DeviceCapabilityReport`: resolución real, FPS efectivo, `timestampJitterMs`, `frameDropRatio`, torch soportado/activo

La medición **no asume** torch ni FPS solicitados: baja `confidence` o bloquea con estados técnicos (`TORCH_UNAVAILABLE`, `LOW_FPS`, etc.).

### Fotometría y bloqueo del ISP

- **Lock secuencial**: `stabilizeTrack` deja AE/AWB en `continuous` durante la colocación; al entrar en `STABLE_CONTACT`, `optimizeForFinger` aplica `focusMode`, `whiteBalanceMode` y `exposureMode` en llamadas `advanced` separadas (modo primero, valor después) porque Chrome ignora el valor de exposición enviado junto al cambio de modo y un entry fallido bloquea los siguientes. La verificación se hace leyendo `getSettings()`, no la constraint enviada.
- **Recuperación antes del lock**: la fotometría incluye tejido y fracción recortada incluso cuando el ROI todavía no puede confirmar pulso. Si el recorte de un dedo sellado persiste, se reduce compensación EV sólo con AE automático y controles/rango/valor reales disponibles. Hay dwell, cooldown, límite de intentos y verificación de settings/respuesta de imagen. La operación termina antes de fijar el ISP; no convierte píxeles saturados en señal válida.
- **Valores fijados**: foco a distancia mínima, WB manual con `colorTemperature` actual (único valor WB expuesto por la API web) e ISO/tiempo de exposición hacia rojo ≈180 (sin clipping; el ROI rechaza R ≥ 250). El tiempo de integración se fija explícitamente porque en exposición manual es significativo y una ventana larga actúa como low-pass sobre la AC.
- **Límite conocido del web**: el tone mapping adaptativo de Android (`toneMappingMode` de Camera2) no es accesible desde `getUserMedia`; bloquear AE/AWB y evitar la saturación reduce su variación, pero no se declara linealidad fotométrica ni se usa para cocientes clínicos.
- **Timestamps**: `resolveFrameClock` usa `captureTime` (captura real del sensor) con `presentationTime` como respaldo y `now` solo como último recurso; `mediaTime` identifica frames pero no es reloj. `captureTime` y `presentationTime` comparten la base de `performance.now()`; una desviación > 250 ms se trata como otra época y se descarta.
- **Co-ubicación lente↔flash**: escaneo de 500 ms con torch; `lens-covered-dark` solo se emite con torch confirmado por `getSettings()` (diagnóstico de colocación, nunca gate de medición).

## ROI y contacto con el dedo

`PPGSignalProcessor` + `adaptivePixelRoi` / `fingerSceneClassifier`:

- Ventana de búsqueda adaptativa que sigue el centroide de la máscara; el ROI publicado es el bounding box de los píxeles válidos, no un cuadrado fijo.
- Máscara **Beer-Lambert diferencial** por píxel: densidad óptica temporal en verde, AC/DC en [0.1%, 3%], exclusión estricta de saturación (R ≥ 250) y subexposición (R ≤ 15).
- Agregación ponderada por pulsatilidad OD y actividad |ΔOD| — sin promedio estático ni fusión fija por celdas.
- **Anti-jitter espacial**: correlación Jaccard de la máscara entre `t` y `t−1` + desplazamiento de centroide; la señal se atenúa antes de entrar al detector de latidos y el movimiento se fusiona con el IMU.
- La política de contacto es común a todas las marcas. FPS y jitter observados pueden ampliar la tolerancia temporal; el user agent no acredita calidad ni cambia umbrales.
- Los cuadros se deduplican por identidad de vídeo, nunca por brillo: dos cuadros nuevos pueden contener píxeles iguales. Los timestamps repetidos o invertidos no entran al DSP; pausas mayores de 250 ms abren una ventana nueva en PPG y latidos.
- Las fuentes de pulso son R, G y R–G ponderadas. La proyección POS no compite en PPG por contacto: en el caso de regresión con modulación RGB común elevaba cuantización y deformaba la onda. La histéresis de selección usa el reloj de captura.
- **No se acepta dedo solo por color**: hace falta evidencia pulsátil (perfusión, estabilidad temporal).
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

`SignalQualityIndex` calcula SQI a partir de perfusión, SNR, periodicidad, clipping, saturación, movimiento, FPS y jitter.

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

Se conservan intentos y mediciones con metadatos de calidad; **no** se deben persistir lecturas inválidas como resultados clínicos finales sin `status`/`reason`.

## Historial local

El respaldo de mediciones se cifra con AES-GCM, pero la clave y el texto cifrado están en `localStorage`; esto no protege contra scripts ejecutados en el mismo origen ni contra el acceso al perfil del navegador. Las lecturas, escrituras y la limpieza se coordinan con un Web Lock exclusivo por origen. Si `navigator.locks` no está disponible, las operaciones locales fallan explícitamente sin modificar los datos. Si el descifrado falla, los datos locales se conservan y la carga del historial de Supabase continúa.

## Tests y CI

```bash
npm run check:all
# lint + typecheck + check:orphans + check:no-sim + test + build + check:no-sim:dist
npm run check:architecture
```

Tests relevantes: `Detectors.test.ts`, `PPGSignalProcessor.test.ts`, `adaptivePixelRoi.test.ts`, `resolveAcquisitionStatus.test.ts`.

## Limitaciones explícitas

- Estimaciones **orientativas** sin calibración de usuario (especialmente SpO2 y PA).
- Los pesos BP versionados se generan desde `training/train_bp_mlp.py`, cuyo conjunto es sintético; no hay evidencia de validación clínica en este repositorio.
- Variabilidad entre dispositivos (sensor RG-Bayer, torch, FPS).
- El DSP PPG corre en Web Worker; React y el enrutamiento/vitales se ejecutan en el hilo principal.
- No sustituye un pulsioxímetro ni un tensiómetro certificado.

## Referencias internas

- `docs/repository-cleanup.md` — depuración previa y mapa histórico
- `docs/no-simulation-audit.md` — política anti-simulación en runtime

