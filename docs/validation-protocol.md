# Protocolo de validación clínica — Bio-Beat Tracker (F6)

## Alcance
Validación del sistema de medición por cámara (FC, SpO2, PA estimada) frente a
referencias clínicas certificadas, siguiendo los criterios de ISO 81060-2:2018
(PA) y las recomendaciones de la AAMI/ESH/ISO para validación de dispositivos
de presión arterial no invasivos.

## Dispositivos de referencia
- **PA**: tensiómetro de brazo validado (auscultatorio o oscilométrico certificado).
- **SpO2**: pulsioxímetro de dedo certificado (ISO 80601-2-61).
- **FC**: ECG o pulsioxímetro de referencia (derivación de los intervalos RR).

## Protocolo de adquisición
1. Sujeto en reposo ≥5 min, sentado, brazo a la altura del corazón.
2. Captura dual (cara + dedo) con el sistema + referencia simultánea.
3. ≥3 mediciones por sujeto, separadas ≥1 min.
4. Registrar: estimación del sistema, referencia, SQI, PI, FPS, jitter, condiciones de luz.
5. Almacenar en el dataset de validación cifrado (`ValidationDataset`).

## Análisis estadístico
- **Bland–Altman**: sesgo (d̄), DE, límites de acuerdo (d̄ ± 1.96·DE), p5/p95.
- **Criterios ISO 81060-2:2018**: |sesgo| ≤ 5 mmHg, DE ≤ 8 mmHg (por brazo, sistólica y diastólica).
- **SpO2**: error RMS ≤ 3.5 % frente a referencia (ISO 80601-2-61).
- **FC**: error absoluto medio ≤ 5 bpm.

## Promoción de pesos del MLP (F5)
Solo se sustituyen los pesos sintéticos por pesos entrenados sobre datos públicos
cuando `evaluateBpWeightsPromotion` devuelve `promotable: true` con un informe
clínico válido (≥45 sujetos, dispositivo de referencia certificado, |sesgo| ≤ 5,
DE ≤ 8). Hasta entonces, los pesos permanecen como `formula_generated` /
`unvalidated` y el sistema se declara orientativo.

## Reproducibilidad
- Todos los cálculos (Bland–Altman, percentiles) usan utilidades compartidas
  (`robustPercentile`, `blandAltman`) sin duplicación de DSP.
- Los resultados se visualizan en el panel ESTUDIO de Ajustes.
- El pipeline de entrenamiento público está documentado en
  `training/train_bp_mlp_public.py` y `src/lib/vitals/bpTrainingDatasets.ts`.
PY