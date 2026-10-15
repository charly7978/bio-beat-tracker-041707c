# Validación médica y estados de precisión — Bio Beat Tracker

**Fecha de apertura:** 2026-10-15 (auditoría exhaustiva)
**Alcance:** BPM/HR, SpO2, presión arterial (PA), frecuencia respiratoria, arritmias/HRV.

## 1. Naturaleza del producto

Bio-Beat Tracker es un producto de **bienestar general**, no un dispositivo médico.
No está certificado como SaMD y **no sustituye** pulsioxímetro, tensiómetro ni ECG.
Toda lectura debe interpretarse como **orientativa** y presentada con su estado
(`status`), confianza y calidad de señal; cuando la señal no es válida la app
muestra `--` (regla "prioridad a *sin lectura* sobre lectura falsa").

## 2. Qué validación existe hoy (verificable en el repo)

| Dimensión | Evidencia | Estado |
|---|---|---|
| Corrección numérica del pipeline | 353 tests (Vitest), oráculos independientes para SQI y detector de picos | ✅ Verde (`npm run test`) |
| Anti-simulación | `npm run check:no-sim` + `check:no-sim:dist` (0 violaciones en `src/`) | ✅ Verde |
| Arquitectura / duplicación | `npm run check:architecture` (10 módulos canónicos), `check:orphans` (0 huérfanos) | ✅ Verde |
| Build producción | `npm run build` + guardrail dist | ✅ Verde |
| Banda fisiológica HR | 30–220 bpm, RR 270–2200 ms (`VITAL_THRESHOLDS.HR`) con rechazo, no clampeo | ✅ Implementado |
| Bases de los modelos SQI/picos | Elgendi 2016 (Bioengineering 3(4):21), Wang 2017 (IEEE TBME 64(7):1479 POS), Karlen 2013 (respiración) | ✅ Documentadas en código |
| HRV | RMSSD/SDNN/pNN50 sobre RR reales del ensemble | ⚠️ Implementado, sin validación clínica externa |

## 3. Qué validación NO existe (brechas conocidas y divulgadas)

1. **Sin comparación contra referencia clínica.** No se ha realizado estudio
   Bland–Altman vs ECG/pulsioxímetro/tensiómetro validado en sujetos reales.
   No existen métricas de error (MAE, límites de concordancia) publicadas.
2. **SpO2 (verde como proxy IR).** Modelo ratio-of-ratios con calibración
   empírica de smartphone (`SPO2.R_MODEL_A/B/C`, gamma de cámara d=2.2).
   Precisión no validada; **no presentar como saturación clínica**.
3. **PA.** Fusión Windkessel-PDA + MLP. El MLP (`mlpWeights.ts`) fue entrenado
   sobre datos **sintéticos** (fórmulas sobre features aleatorios, seed 42 —
   ver cabecera del archivo). Sin calibración individual el estado es
   `REQUIRES_CALIBRATION`. **No presentar como medición clínica**.
4. **Arritmias.** Detección sobre RR reales con confirmación temporal
   (integrador con fugas) y deadband aprendido; sin validación frente a
   Holter/ECG. Informativa, no diagnóstica.
5. **Modelos ONNX/NN** (`peak_scorer`, `sqi_refiner`, `denoiser`): **no
   integrados** en la app (ver `training/README.md`).

## 4. Procedimiento para mejorar el estado de validación

Para pasar una métrica de "orientativa" a "validada" se requiere:

1. Adquisición simultánea con dispositivo de referencia certificado (mismo
   sujeto, mismas condiciones), N ≥ 30 sujetos representativos.
2. Cálculo de error absoluto medio, desviación y límites de acuerdo
   Bland–Altman (bias ± 1.96σ) por métrica y por rango fisiológico.
3. Registro de dataset con metadatos de calidad (SQI, PI, FPS, dispositivo)
   — la infraestructura de registro ya existe (`ValidationDataset.ts`,
   `savePolicy.ts` conserva `status`/`confidence`/artefacts).
4. Actualización de este documento con resultados y fecha; los coeficientes de
   modelo solo se ajustan con evidencia nueva (regla del proyecto: prohibido
   inventar constantes fisiológicas).

## 5. Disclaimer obligatorio en UI

"Estas mediciones son estimaciones de bienestar basadas en la cámara y no
sustituyen equipos médicos ni diagnóstico clínico. Ante cualquier duda de
salud, consulta a un profesional."
