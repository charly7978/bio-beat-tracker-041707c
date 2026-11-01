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
| Corrección numérica del pipeline | 360 tests (Vitest), oráculos independientes para SQI y detector de picos | ✅ Verde (`npm run test`) |
| Anti-simulación | `npm run check:no-sim` + `check:no-sim:dist` (0 violaciones en `src/`) | ✅ Verde |
| Arquitectura / duplicación | `npm run check:architecture` (10 módulos canónicos), `check:orphans` (0 huérfanos) | ✅ Verde |
| Build producción | `npm run build` + guardrail dist | ✅ Verde |
| Banda fisiológica HR | 30–220 bpm, RR 270–2200 ms (`VITAL_THRESHOLDS.HR`) con rechazo, no clampeo | ✅ Implementado |
| SQI central único | `SignalQualityIndex.calculate` es el único motor (finger y gym; 2026-10-15 se eliminó la fórmula paralela del modo gym) | ✅ Implementado |
| Saturación | `saturationRatio` = fracción REAL de píxeles recortados del ROI (2026-10-15; antes binaria) + gate de rechazo >0.8 | ✅ Implementado |
| SpO2 sin piso forzado | Lectura cruda del modelo; fuera de [70,100] no se publica (`--`), nunca se ajusta a 75% (2026-10-15) | ✅ Implementado |
| Estado arritmia | Inicial/reset = `CALIBRANDO...`; sin RR válidos no se afirma ritmo (2026-10-15) | ✅ Implementado |
| Bases de los modelos SQI/picos | Elgendi 2016 (Bioengineering 3(4):21), Wang 2017 (IEEE TBME 64(7):1479 POS), Karlen 2013 (respiración) | ✅ Documentadas en código |
| HRV | RMSSD/SDNN/pNN50 sobre RR reales del ensemble | ⚠️ Implementado, sin validación clínica externa |

## 3. Qué validación NO existe (brechas conocidas y divulgadas)

1. **Sin comparación contra referencia clínica.** No se ha realizado estudio
   Bland–Altman vs ECG/pulsioxímetro/tensiómetro validado en sujetos reales.
   No existen métricas de error (MAE, límites de concordancia) publicadas.
2. **SpO2 (verde como proxy IR).** Modelo ratio-of-ratios con calibración
   empírica de smartphone (`SPO2.R_MODEL_A/B/C`, gamma de cámara d=2.2).
   Precisión no validada; **no presentar como saturación clínica**. El valor
   crudo del modelo se publica solo dentro de [70,100]; fuera de banda la UI
   muestra `--` (sin piso forzado desde 2026-10-15).
3. **PA.** Fusión Windkessel-PDA + MLP. El MLP (`mlpWeights.ts`) fue entrenado
   sobre datos **sintéticos** (fórmulas sobre features aleatorios, seed 42 —
   ver cabecera del archivo). Sin calibración individual el estado es
   `REQUIRES_CALIBRATION`. **No presentar como medición clínica**.
   La sustitución de esos pesos está **bloqueada por gate automático** hasta que
   exista un informe de validación conforme (ver punto 4 y
   `docs/mlp-weights-promotion.md`). Procedencia declarada y huella de los pesos:
   `src/lib/vitals/mlpWeightsProvenance.ts`.
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

### 4.5 Gate de sustitución de pesos del MLP de PA (implementado)

La regla anterior ya no depende de la disciplina del operador:

- `training/train_bp_mlp.py` **no sobrescribe** `src/lib/vitals/mlpWeights.ts`
  salvo con `--promote --validation-report <json>` que pase el gate
  (ISO 81060-2:2018 / ANSI-AAMI ES1: |sesgo| ≤ 5 mmHg y DE ≤ 8 mmHg por brazo;
  ≥ 30 sujetos; ≥ 3 pares válidos por sujeto; dataset `clinical_reference` con
  dispositivo de referencia certificado; huella del informe = huella de los
  pesos candidatos; informe no anterior a la generación de los pesos).
- La huella de los pesos (`fnv1a64:…`, float64 big-endian + FNV-1a 64) se
  declara en `MLP_WEIGHTS_PROVENANCE`. Si no coincide, `getMlpWeightsIntegrity()`
  marca los pesos como no verificados y el motor fija `wMlp = 0`: la estimación
  pasa a depender solo del modelo físico Windkessel-PDA.
- CI lo verifica en `src/lib/vitals/__tests__/mlpWeightsProvenance.test.ts`
  (huella, forma, y comportamiento del gate en ambos sentidos).
- Comprobación cruzada TS ↔ Python: `python training/check_weights_fingerprint.py`.

**Estado hoy:** no existe informe de validación en `training/validation-reports/`,
por tanto los pesos siguen siendo los mismos y su estado sigue siendo
`REQUIRES_CALIBRATION`.

## 5. Disclaimer obligatorio en UI

"Estas mediciones son estimaciones de bienestar basadas en la cámara y no
sustituyen equipos médicos ni diagnóstico clínico. Ante cualquier duda de
salud, consulta a un profesional."
