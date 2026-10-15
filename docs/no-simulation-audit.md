# Auditoría Anti-Simulación — Pipeline PPG

**Fecha de auditoría:** 2026-05-09 — **RE-VERIFICADA y ampliada: 2026-10-15** (auditoría exhaustiva)
**Alcance:** cámara → procesamiento → BPM → SpO₂ → Presión Arterial → Arritmias → UI
**Resultado:** ✅ **Sin simulaciones, sin valores artificiales, sin generadores aleatorios en `src/`.**

> **Delta de la re-verificación 2026-10-15** (todo el pipeline cambió sustancialmente
> desde mayo: commits `04591fd` honest-ppg, `11807bc`, `d64b9ab`, `5620f38`…):
> - ✅ Re-verificados: detección de dedo por píxeles, ROI→ceros sin tiles válidos,
>   filtros sin reset "plausible", BPM=0 sin picos reales, SpO2=0 sin señal,
>   PA `{0,0,INSUFFICIENT}` + `REQUIRES_CALIBRATION`, `waveHonesty` perf×per.
> - ⚠️ **Corregido claim obsoleto:** arritmias ya no arrancan en `"SIN ARRITMIAS|0"`;
>   el estado inicial es ahora `CALIBRANDO...` → `APRENDIENDO RITMO...` →
>   `RITMO NORMAL`/`ARRITMIA DETECTADA` con confirmación temporal
>   (`arrhythmia-processor.ts`). Sin contadores sembrados: solo RR reales.
> - ⚠️ **Corregido claim obsoleto:** el suavizado EMA doble cambió
>   (`VITAL_EMA_SECONDARY` permanece; las constantes STABLE/DYNAMIC se eliminaron
>   en `d64b9ab`). Sigue siendo display-only.
> - ➕ **Añadido 2026-10-15:** `training/generate_synthetic_ppg.py` es un generador
>   sintético de EJEMPLO para entrenamiento OFFLINE: nunca se importa desde
>   `src/` ni se empaqueta en la app (verificado: 0 referencias en `src/`).
>   El MLP de PA (`mlpWeights.ts`) se entrenó con datos sintéticos — procedencia
>   divulgada en su cabecera y en `docs/medical-validation.md`.
> - ➕ **Añadido 2026-10-15:** el término de kurtosis del SQI se alimenta ahora
>   con EXCESO de kurtosis (β₂−3) vía `computeWindowMoments` (`shared/dsp.ts`),
>   alineado con los umbrales `KURTOSIS_SQI_*` y con `utils/stats.ts`.
>   Antes se entregaba β₂ cruda → el término saturaba (+6) en cualquier ventana,
>   incluido ruido puro (hallazgo de auditoría, corregido y con test).


## Búsquedas ejecutadas

| Patrón | Comando | Resultado |
|---|---|---|
| `Math.random` | `rg "Math\.random" src/` | **0 coincidencias** |
| `simulate / mock / fake / dummy / stub` | `rg -i "simulat\|mock\|fake\|dummy\|stub"` | Solo `placeholder=` en `<input>` HTML de Auth (legítimo) |
| Generadores sintéticos (`sine/cosine wave / synthetic / generate signal / seed`) | `rg -i "synthet\|sine.*wave\|generate.*signal\|seed"` | **0 coincidencias** |
| `Math.sin / Math.cos / Math.tan` en pipeline | `rg "Math\.(sin\|cos\|tan)"` | Solo en `BandpassFilter.ts`/`BesselFilter.ts` (coefs Butterworth/Bessel IIR, bilinear) + `ica.ts` (`Math.tanh` para FastICA) — **operación matemática legítima**; rPPG POS usa solo álgebra lineal (Wang 2017) |
| Valores clínicos hardcoded (`120/80`, `98%`, baseline fijos) | `rg "120/80\|return.*spo2.*9[0-9]"` | Solo en **comentarios explicativos** ("SIN BASE FIJA 120/80") |

## Garantías por capa

### 1. Captura de cámara (`CameraView.tsx`)
- Toda la señal proviene de píxeles reales del `MediaStream` con flash activo.
- `requestVideoFrameCallback` para captura sincronizada al sensor.
- Si la cámara o el torch fallan: degradación a estado de error explícito, **nunca** se inyecta señal sintética.

### 2. Detección de dedo (`PPGSignalProcessor.updateContactState`)
- Clasificación por píxel (luma + chroma + pureza roja + clipping). Sin contacto → `state="finger-missing"`, `filtered=0`, `quality=0`.
- Histéresis estricta: requiere firma real de hemoglobina (red dominance > 20, RG ratio > 1.2, coverage > 35%).

### 3. Extracción ROI (`PPGSignalProcessor.extractROI`)
- Promedios calculados sobre tiles válidos del frame. Si no hay tiles válidos → devuelve **ceros**, no defaults.

### 4. Filtrado y normalización (`BandpassFilter.ts`)
- Biquad Butterworth Direct Form I con `fs` real estimado del frame timing.
- Reset de estados internos a `0` en overflow numérico — no se inyecta valor "plausible".

### 5. BPM y picos (`HeartBeatProcessor.ts`)
- Solo emite BPM cuando hay picos reales detectados sobre la señal filtrada.
- Sin contacto / mala calidad → `bpm=0` y se renderiza `--` en UI.
- **Sin extrapolación** ni suavizado de "BPM previo" cuando se pierde la señal (regla `Medical Philosophy` del proyecto).

### 6. SpO₂ (`VitalSignsProcessor` / SpO2 head)
- Calculado vía ratio R/G real (AC/DC). Si SQI insuficiente → `spo2=0` → UI muestra `--`.
- Sin floor `90%`, sin clamping fisiológico forzado.

### 7. Presión arterial (`BloodPressureProcessor.ts`)
- Modelo de regresión PWA sobre 74 features morfológicos reales (APG b/a, d/a, AIx, SI, dicrotic notch).
- Si features insuficientes → `{systolic:0, diastolic:0, confidence:'INSUFFICIENT'}` → UI muestra `--/--`.
- Sin base fija 120/80 — verificado por comentario explícito en el código.
- Sin calibración manual ni offsets sintéticos (calibration wizard eliminado).

### 8. Arritmias (`arrhythmia-processor.ts`)
- Detectadas exclusivamente desde RR-intervals reales obtenidos de los picos del HeartBeatProcessor.
- Estados: `CALIBRANDO...` → `APRENDIENDO RITMO...` (8–18 s) → `RITMO NORMAL` / `ARRITMIA DETECTADA`. El contador de confirmación exige evidencia SOSTENIDA (integrador con fugas); no se incrementa sin evento RR genuino ni contador sembrado.

### 9. Capa de UI (`Index.tsx`, `PPGSignalMeter.tsx`, `ppgCanvasRenderer.ts`, `waveHonesty.ts`)
- Todos los componentes muestran `--` cuando el valor es `0` o `null` proveniente del pipeline.
- `waveHonesty.realSignalStrength = perf×per` (AND) — sin periodicidad cardíaca la onda queda plana; evita "ondas hermosas" de ruido bandpass (verificada en `waveHonesty.test.ts` — objeto movido sin periodicidad → <0.1).
- Redondeo a entero **solo en presentación** (`Math.round(heartRate)`); precisión float preservada en cálculos internos.
- Suavizado EMA (`VITAL_THRESHOLDS.QUALITY.VITAL_EMA_SECONDARY`) solo para estabilidad visual, nunca para enmascarar pérdida de señal (tras el commit `d64b9ab` solo permanece el secundario; las variantes STABLE/DYNAMIC se eliminaron).
- `ppgCanvasRenderer` usa `RingF32`/`CircularBuffer` con honestidad de rango (transform `pow 1.05`) y Catmull-Rom sin extrapolación.

### 10. Edge function de IA (`supabase/functions/analyze-vitals`)
- Recibe únicamente los valores ya validados del pipeline; si llegan en `0` los reporta como tal en el prompt al modelo.

## Excepciones legítimas

| Ubicación | Uso de constante numérica | Justificación |
|---|---|---|
| `BandpassFilter`/`BesselFilter.compute*` | `Math.sin`, `Math.cos`, `Math.tan` | Diseño analítico coefs Butterworth/Bessel 4º orden (bilinear). Refs: Abramowitz & Stegun §19.6, Zverev, Williams & Taylor Ch.11, Proakis/ Manolakis. |
| `src/utils/ica.ts` | `Math.tanh` | FastICA no-linealidad `g(u)=tanh(u)` — separación ciega, no generación. |
| `waveHonesty.ts` | `realSignalStrength = perf×per` (AND) | Honestidad visual — producto estricto evita onda de objeto inerte con movimiento (ver comentario en src). |
| `PPGSignalProcessor` — pesos de fuentes | constantes `0.45 / 0.40 / 0.15`… | Parámetros heurísticos del modelo de selección competitiva, no datos. |
| `rPPG POS` (`GymFaceTracker`/`GymMotionCancellation`) | álgebra `X,Y,α` | Proyección Wang 2017 IEEE TBME 64(7):1479 + POS-SSA Wang 2026 JAIT 17(4):788 — sin síntesis. |

## Conclusión

El pipeline cumple estrictamente la regla **`Medical Philosophy`** del proyecto: *"Prioritize 'no reading' over false reading"*. Todas las métricas se derivan exclusivamente de píxeles reales capturados con flash; cuando la señal es insuficiente, la app muestra `--` y conserva `confidence='INSUFFICIENT'` en lugar de inventar valores.
