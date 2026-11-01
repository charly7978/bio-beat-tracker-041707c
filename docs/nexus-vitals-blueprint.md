# NEXUS-VITALS — Blueprint del sistema de próxima generación (2026)

**Presión arterial y oxigenación por cámara: multisitio × multimodal × verificable.**
Documento de diseño alineado al estado del arte vigente (2022–2026) y a los recursos reales del repositorio. Todos los valores de precisión citados de la literatura son de sus estudios originales; los de este sistema, cuando existan, serán objetivos medidos con el plan de verificación del capítulo 13. **Nada de este documento simula resultados: los objetivos se declaran como objetivos y se demuestran con datos.**

---

## 1. Misión y criterios de éxito medibles

**Objetivo en una frase:** convertir el smartphone en un monitor de presión arterial (PA) y saturación de oxígeno (SpO2) del mayor alcance posible, obteniendo precisión de clase líder en la literatura científica publicada, dentro de los recursos que un teléfono ya tiene hoy (cámaras, flash, IMU, cómputo).

**Criterios de éxito verificables:**

| # | Criterio | Meta (objetivo declarado) | Cómo se demuestra |
|---|----------|---------------------------|-------------------|
| 1 | Exactitud de PA en modo NEXUS (cara+dedo, calibración personal vigente) | MAE sistólica ≤ 5 mmHg y diastólica ≤ 4 mmHg en pares (estimación, referencia de tensiómetro) | Registro de pares en el panel Bland-Altman + estudio con voluntarios documentado en `docs/medical-validation.md` |
| 2 | Exactitud PA modo dedo (calibración vigente) | Mantener calidad PWA actual y elevarla con fusión | Mismo protocolo |
| 3 | SpO2 tras calibración personal | Error dentro de banda de incertidumbre declarada por medición (intervalo p5–p95) | Pares contra pulsioxímetro de referencia |
| 4 | Integridad | `check:no-sim`, `check:orphans`, `check:architecture`, tests y build en verde en cada fase | CI del repo |
| 5 | Cobertura de dispositivos | Modo degradado elegante en cada salto multimodal (una sola cámara, sin flash, sin IMU) | Tests de estados de adquisición |

---

## 2. Estado del arte (hallazgos con fuentes, 2022–2026)

### 2.1 PA sin manguito (cuffless) por PPG/rPPG

- **PTT entre dos sitios con un solo smartphone (opción elegida como columna vertebral):** IEEE EMBC 2025, "Smartphone Dual-Camera based Blood Pressure Screening Using Pulse Transit Time Between Ear and Finger": PPG sincronizado de oreja y dedo con las dos cámaras del teléfono, PTT intra-sujeto + HR + HRV, regresión personalizada (random forest). Resultado del estudio: **MAE sistólica 3.74 mmHg, diastólica 2.73 mmHg, r=0.877/0.868** (15 participantes, comparado con manguito). Fuente: PubMed PMID 41337391.
- **PTT cámara+IMU validado como instrumento:** "AlwaysBP" (JMIR mHealth 2023), estimación SBP/DBP por PTT calculado con cámara e IMU del propio smartphone; estudio de validación publicado (PubMed 37694382).
- **Tendencia de la investigación:** transformers especializados PPG→PA: *TransfoRhythm* (arXiv 2404.15352, 2024), *GPT-PPG* (arXiv 2503.08015), *DMT* (condicionamiento demográfico + morfología, arXiv 2606.11125), y comparativa directa PPG→PA con mediar por ECG (arXiv 2607.23406). Marco metodológico para generalización fuera de distribución: benchmark público AI4HealthUOL/ppg-ood-generalization (Universidad de Cambridge, 2025).
- **Revisión sistémica cuffless:** Sensors (MDPI), "Beyond the Cuff: State-of-the-Art on Cuffless Blood Pressure" (2026): el rPPG es una variante sin contacto habilitada y la línea de trabajo consolidada pasa por PTT + análisis de onda de pulso (PWA) + personalización.
- **Marco de confianza IA:** npj Digital Medicine, "Towards trustworthy AI-driven cuffless blood pressure monitoring" (2026): el estándar emergente exige incertidumbre explícita y validación por sujeto.

### 2.2 SpO2 por cámara

- **Cámara RGB sin modificar, con hipoxemia inducida:** Universidad de Washington, npj Digital Medicine 2022, "Smartphone camera oximetry in an induced hypoxemia study": primer sistema no modificado que caracteriza SpO2 **por debajo de 85%**, con **MAE = 5.00%** y sensibilidad de desaturación (SpO2<90%) de 81%. Demuestra que el canal RGB + aprendizaje puede detectar hipoxemia moderada (no reemplaza un pulsioxímetro: lo complementa con verificación).
- **Contacto flash-finger:** estudios posteriores con la luz del flash atravesando el dedo y decodificación por aprendizaje (reportes de grupo global, 2023).
- **rPPG facial para SpO2:** Bioengineering (MDPI) 2024, "Contactless Blood Oxygen Saturation Estimation from Facial Video": modelos de aprendizaje aplicados a video de rostro en línea de dos longitudes de onda (rojo/verde como pseudo-IR).
- **Regla de oro clásica (base física):** SpO2 exige dos longitudes de onda y Beer–Lambert; con cámara tenemos R/G/B → aproximación dual/triple + calibración personal (coherente con nuestra `SpO2Calculator` actual).

### 2.3 rPPG (señal de pulso por cámara)

- Revisiones 2025 (Electronics MDPI "Advancements in rPPG"; PMC 12181896): en reposo y buena iluminación, rPPG logra MAE ~2–4 bpm; PPG de contacto por dedo es hasta mejor (MAE ~1–3 bpm). Condiciones de bajo contraste iluminativo siguen siendo el caso operativo más exigente (npj Digital Medicine 2025, fiabilidad en baja luz).
- **Leer los dos juntos:** la señal de dedo (contacto, flash) da SNR alto y morfología rica; la señal facial da el sitio proximal para el tránsito. **El diseño NEXUS usa ambos sincronizados.**

### 2.4 Fundamentos fisiológicos y físicos que sostienen el diseño

- **PTT↔PA (relación inversa):** la velocidad de propagación del pulso mejora con la presión (arteria más tensada contra capa de músculo) — formalizado por Moens–Korteweg: `c ∝ √(E·h/(ρ·d))`, donde la presión eleva E (rigidez tangente). Por eso SBP/DBP se estiman con formas tipo `k1/PTT² + k2` con `(k1,k2)` **personales** (calibración obligatoria). Consistente con EMBC 2025 y AlwaysBP.
- **Windkessel de 3 elementos** (ya implementado en `pwaPhysiologicalBpEngine`): MAP = Q̄·Rp + CVP, PP = SV/C·(1+RI) → el motor actual ya genera PA por fisiología pura. NEXUS lo integra como una fuente N dentro de la fusión (capítulo 7).
- **Beer–Lambert** para el par óptico R/G(/B) de SpO2 con DC pulsátil (ya implementado); NEXUS añade control de la fuente de luz (capítulo 8).
- **Morfología APG/PDA** (a,b,c,d,e; W1/W2, ΔT_reflejo, SI) — ya implementadas; aportan covariables y covarianzas a la fusión.

---

## 3. Diagnóstico del sistema hoy (fortalezas reales sobre las que se apoya NEXUS)

El repositorio ya tiene una base rara y valiosa — la mayoría de los "apps de pulso" no tienen ni la mitad:

- **Cadena de captura honesta:** `CameraView` con FPS/jitter reales, torch verificado, estados técnicos explícitos (`TORCH_UNAVAILABLE`, `LOW_FPS`, …), sin capturas falsas.
- **DSP de nivel productivo:** Butterworth 4º 0.5–12 Hz + Bessel fase lineal, ROI 5×5 con fusión de teselas, estabilizador activo + AGC de pulso, SQI de Elgendi (2016) con asimetría/kurtosis, ensemble de picos Elgendi + scoring, cancelación de movimiento en gimnasio (notch por cadencia), worker con backpressure y fallback honesto al hilo principal.
- **Motores de signos vitales:** `SpO2Calculator` (Beer-Lambert R/G con DC-DEMA), `BloodPressureProcessor` (PWA de 74 features con filtrado de ciclos por medianas), `pwaPhysiologicalBpEngine` (PDA + Windkessel 3-elementos + APG + fusión bayesiana con MLP), `respiratorySmartFusion` (RIAV/RIIV/RIFV/ACC, Karlen 2013), `ArrhythmiaProcessor` (RMSSD/pNN31/pNN50/Shannon/SampEn).
- **Calibración y datos:** `CalibrationManager` (SpO2/BP antropométrico + offsets por referencia), persistencia Supabase con trazabilidad (versión de algoritmo, confianza, ventana, SQI), almacenamiento local cifrado.
- **Guardarraíles de verdad:** `check:no-sim` (prohíbe Math.random/mock/synthetic en src), `check:orphans`, `check:architecture`, `waveHonesty` (prioridad de "no lectura" sobre apariencia),MLP con **procedencia y huella** verificable (los pesos no verificados no pesan en la fusión).

**Conclusión del diagnóstico:** el sistema actual es un *estimador de un solo sitio* (dedo o cara) con calibración de usuario. NEXUS es el *siguiente salto de arquitectura*: dos sitios sincronizados + más modos + fusión N-fuentes con verificación continua.

---

## 4. Tesis del diseño

> **La precisión de la PA sin manguito no nace de un solo truco, sino de la fusión de varios estimadores FÍSICAMENTE INDEPENDIENTES bien calibrados, cada uno con su incertidumbre, y de la verificabilidad en cada punto.**

NEXUS se apoya en 7 innovaciones (A–G):

| Innovación | Qué añade | Estado del arte que lo valida |
|---|---|---|
| A. **CSTT** — PTT cara→dedo por cámara dual | reloj hemodinámico personal | EMBC 2025 (MAE 3.74/2.73) |
| B. **Captura dual sincronizada** (web + nativa) | señal multisitio real | recursos Android/iOS (Capacitor) |
| C. **Motor de fusión N-fuentes** (KKF) | incertidumbre optimizada por calidad | npj 2026 "trustworthy" |
| D. **SpO2 nex-gen** (ratio triple + torch modulado) | proximidad óptica real | UW npj 2022; contactless 2024 |
| E. **Deep NEXUS** (pesos de datos públicos reales) | regresor de clase líder | TransfoRhythm, OOD benchmark |
| F. **Contrato de calibración clínica guiada** + panel Bland-Altman vivo | el usuario calibra; el sistema se honestiza | AlwaysBP (instrumento validado) |
| G. **Adjudicador de coherencia multisitio** | degradación elegante, cero trampas | diseño de robustez del repo |

---

## 5. Innovación A — CSTT: PTT cara→dedo (Cross-Site Transit Time)

### 5.1 Idea

En el mismo instate de medición (o alternado si el hardware no da vía dual), NEXUS captura:
- **Señal distal:** PPG del dedo con cámara trasera + flash (canal existente; SNR alto, morfología rica).
- **Señal proximal-ish:** rPPG facial con cámara frontal (POS/Wang 2017 ya implementado en el modo "gym").

Se calcula el retardo de llegada del frente sistólico del pulso de la cara al del dedo: `τ = t_onset(dedo) − t_onset(cara)`. Este retardo (`IRT` — interleaved raise-to-air telegram)... se corrige: es el **tiempo de tránsito inter-sitio** con anclaje personal: `A, B` fit por calibración (3+ referencias de tensiómetro). Covariables: HR, RMSSD, fase respiratoria (de `respiratorySmartFusion`) y temperatura periférica percibida por el R (canal propio como confusión de perfusión).

### 5.2 Matemática del estimador (del papel al test)

1. Por sitio: normalización z-score de la serie PPG bien filtrada (Butterworth 0.5–5 Hz para PTT; 4º orden existente).
2. **Estimación grosera:** correlación cruzada generalizada (GCC-PHAT): `R(τ) = Σ [X_f * conj(X_d) / |X_f conj(X_d)|]` sobre el espectro de la ventana (8–12 s) — robusta a color del canal y la fase; máximo |R| con refinamiento parabólico sub-muestra.
3. **Estimación fina (morfología):** por latido (pico del ensemble en la cara), construir el pie de onda: punto de máxima pendiente del ascendente sistólico (intersección de la tangente con la línea base) en ambas series → mediana de `τ_beat`.
4. **Fusión temporal de estimaciones:** mediana de `τ_beat` por latido con filtro de Hampel + `τ_GCC` como prior; si el GC discrepa >15 ms → añadir marcador de baja coherencia.
5. **Validación fisiológica jornada:** `τ` solo válido si `τ ∈ [10, 350] ms`, HR cara ≈ HR dedo (Δ < 3%), coherencia de fase por latido alta (r_pic > 0.7). Fuera → rechazo (sin cl bookings: "no lectura" con motivo técnico).

### 5.3 Relación con la PA

Con calibración personal vigente (capítulo 10):
`SBP = A·(1/τ²) + B + cov(teros: respiración, HR)`; variante equivalente `SBP = k1/τ + k2` ajustada en la sesión de calibración por mínimos cuadrados con regularización ridge. El resultado ingresa a la fusión (capítulo 7) con varianza estimada a partir de: dispersión de τ por latido, SQI de ambas señales, edad de calibración.

---

## 6. Innovación B — captura dual sincronizada (el "desafío hardware", resuelto con diseño)

**Recursos disponibles:** HTTPS `getUserMedia` smartphones modernos (Chrome Android permite 2 streams transversales con estrés moderado); iOS requiere sesiones nativas (`AVCaptureMultiCamSession`) o captura alternada. Tenemos Capacitor 8 ya instalado.

**Plan por capas (cada capa tiene fallback explícito y razonado):**

| Capa | Escenario | Implementación | Fallback |
|---|---|---|---|
| L0 | Solo dedo (mode actual) | pipeline existente | — |
| L1 | Dedo + cara alternado (chiplet de 60–120 fps con doble ROI temporal) | `requestVideoFrameCallback` con cámara trasera + overlay frontal cuando el usuario interpone`/0`... no viable sin dual real | L0 |
| L2 | Dedo + cara concurrentes en web | dos `getUserMedia` simultáneos (Android Chrome moderno) | L1 |
| L3 | Dedo + cara concurrentes nativas | plugin Capacitor nuevo `dual-camera`: Android (Camera2 dual-concurrent) e iOS (`AVCaptureMultiCamSession`) | L2 |
| L4 | Alta velocidad (60–240 fps para PTT fino) | capacidades del dispositivo (`getCapabilities()` con `framerate.max`, o streams de alta velocidad nativos) | L3 a 30 fps |

**Contrato de sincronización:** timestamps reales por frame (ya captura FPS/jitter el repo); ventana común τ-align por coste mínimo de interpolación (cubic – existente utilidades). Jitter declarado afecta directamente la incertidumbre de τ (σ_τ = σ_jitter + σ筛查).

**Instalación técnica del modo dual en L2/L3:** (a) `dualCameraBridge.ts` — negociación de permisos, resolución, FPS, photosensor budget; (b) worker recibe 2 streams separados, cada uno con su PPGSignalProcessor (o el mismo con canal discriminado "sitio=this|dedo"); (c) el fusionCore recibe 2 series alineadas.

---

## 7. Innovación C — Motor de fusión N-fuentes (NexusFusionCore, KKF)

**Estado caminante:** `x = [MAP, PP]` con proceso `x(t+1) = x(t) + w`, `w ~ N(0, Q)`.
**Observaciones por ventana (1 Hz–4 Hz de actualización):**

| Fuente | Modelo | Varianza R_i |
|---|---|---|
| Windkessel+PDA (existente) | físico, sin calibración | var por calidad de morph + antropometría |
| CSTT (calibrado) | A/τ²+B | σ_τ² dispersión + edad calibración |
| MLP Deep NEXUS | regresor | var via incoherenciapropagada (provenance gate) |
| HRV-proxy (modulación barorangora) | covariado | var alta |
| Referencia directa del usuario (tensiómetro) | entrada de calibración | var pequeña (drive del KF en sesiones de calibración) |

- **Optimización de calidad:** cada observación llega con su `R_i` (distinto por medición) — la pesabalance por calidad con `R_i` es exactamente el marco "trustworthy".
- **Salida:** SBP = MAP + 2/3·PP, DBP = MAP − 1/3·PP (relación fisiológica estándar REAL: MMAP = viajera), con banda p5–p95 desde la covarianza de x.
- **Comportamiento degradado:** si solo hay 1 fuente con calidad, el KKF se vuelve "LLM?? no, estimador de una fuente" y la banda se ensancha; el nivel de confianza verbal (HIGH/MEDIUM/LOW) deriva de la banda y del SQI — **nada se inventa si nadie habla**.
- **Archivo:** `src/lib/vitals/nexusFusionCore.ts` (nuevo, puro, typecheck estricto, sin `any`), con tests que cubren: convergencia, pesos not-live, bandas correctas, degradación por calidad, monotonicidad cambnaras.

---

## 8. Innovación D — SpO2 nex-generación (más allá del ratio simples)

Lo que ya hay: `SpO2Calculator` Beer-Lambert R/G con DC-DEMA + calibración. NEXUS suma tres avances encadenados:

1. **Ratio triple R/G/B:** usar además el canal azul como pseudo-segundo cromóforo (B absorción de HbO2/Hb distinta de R y G) → features `(R/G, R/B, B/G)` + sus derivadas AC/DC → el regresor personal gana señales espectrales extra reales.
2. **Modulación controlada del flash (TMDS):** alternar la intensidad del torch dentro de la ventana de medición entre 2 niveles conocidos (`0.6×` y `1.0×`) en pulsos de ≥2 s → diferencial espectral que cancela la luz ambiental y el ruido de exposición: `ΔDC_λ = DC_λ(hi) − k·DC_λ(lo)`, con k=proporción declarada. Esto reduce el error sistémico (incluido el de la auto-fluorescencia y clipping GOPGO). **Nota técnica:** elegir tasas lentas (≥1 Hz período) para no meter line frequency en la banda del pulso; el mapaорами ya separa pulsátil vs DC.
3. **Regresión personal con banda de incertidumbre:** en vez de una fórmula fija, ajuste por usuario de `SpO2 = f(RR features, dimorf... demographics, SQI, TMDS-differentials)` (ridge + Kalman 1D) contra el pulsioxímetro de referencia del usuario (capítulo 10), con **predicción de intervalo p5–p95 por medición**. Sin calibración: modo orientativo con etiqueta explícita (como hoy).

**Meta de clase (objetivo declarado):** detección consistente de desaturaciones moderadas (<92%) tras calibración, manteniendo falsepositivos bajos (threshold basado en OWA i.e., se evalúa en el estudio del capítulo 13).

---

## 9. Innovación E — Deep NEXUS: pesos entrenados con datos reales públicos

**Cambios doctrinales:** hoy el MLP del repo fue entrenado sobre datos sintéticos (documentado en `docs/medical-validation.md`); NEXUS lo reemplaza por un pipeline real:

1. **Datasets públicos (gratuitos, verificados):**
   - PA: **VitalDB** (PPG + ABP invasiva de referencia), **MIMIC-III/IV** (PPG+ABP), **PPG-BP dataset** (657 sujetos con pares manuales+Sanscript).
   - rPPG/SpO2: **UBFC-RPPG**, **MMPD**, **VIPL-HR** (SpO2 en algunos sujetos), y datasets-color de SpO2 amda University (hipoxemia inducida) donde se compile al protocolo público.
2. **Entrenamiento (fuera del repo, script Python `training/train_bp_nexus.py`):** features + PPG-raw dual-tower; arquitectura ligera de estilo TransfoRhythm (1D-CNN stem + bloque self-attention pequeño), outputs S/DBP + varianza (regresión heteroscedástica). Pérdida: NLL gaussiana. Validación **aparte por sujeto** + OOD-benchmark estilo AI4HealthUOL (fracaso si no supera la línea del benchmark).
3. **Promoción de pesos con procedencia (lo que el repo YA pide):** export a TypeScript (matrices + Huella/SHA-256), ficha `docs/mlp-weights-promotion-2.md` con métricas de validación (MAE Finals por fold, LOA) y el gate de procedencia actúa igual que hoy: **pesos no verificados no pesan**.
4. **El gate no-sim:** el entrenamiento ocurre fuera; el repo solo recibe pesos + ficha. `check:no-sim` sigue en verde (nada de generación de datos en el repo).

---

## 10. Innovación F — Contrato de calibración clínica guiada + Bland-Altman vivo

**Flujo UX (new tab en `SettingsPanel`): "Calibración NEXUS":**

1. Wizard guiado con `Estado-暂停`: pedir tensiómetro del usuario (automático si es validado tipo Sea/Ormon/BP Safe? no exigimos marca: protocolo genérico: 3 mediciones separadas 2 min, transparentes).
2. Motor: captura NEXUS durante cada referencia → registra `(τ, features, PWA-est, referencia)` triple.
3. Ajuste mínimos cuadrados ridge de `(A,B)` para SBP/DBP vía CSTT y de los 6–8 pesos del regresor de SpO2; guardado en `CalibrationManager` extendido con **vigencia 28 días + re-calibración recomendada tras cambios grandes de peso/perfil**.
4. **Bland-Altman vivo:** cada par (predicción posterior vs referencia siguiente) entra al panel; el sistema MUESTRA sesgo y límites de acuerdo reales del propio usuario (honestidad como producto). En ≥ 30 pares: recalibración por bayesiana (prior del modelo global + verosimilitud personal).

**Directo del estado del arte:** AlwaysBP (JMIR 2023) valida este esquema de calibración personal como instrumento; el marco "trustworthy" (npj 2026) exige presentación de incertidumbre. NEXUS lo convierte en el artículo central del producto.

---

## 11. Innovación G — Adjudicador de coherencia multisitio

**Idea:** mientras corre el modo NEXUS, un chequeo de congruencia entre sitio-facial y sitio-dedos más permanente:
- HR cara vs HR dedo (Δ < 3%),
- coherencia de fase inter-sitio en la banda de pulso (coherencia > 0.6 en 0.7–3 Hz),
- estabilidad de τ por latido (CV < 15%).

**Salida:** un nivel `NEXUS_CONGRUENT / NEXUS_PARTIAL / NEXUS_INCOMPATIBLE` que modula el peso de la fuente CSTT en la fusión. Si la coorrencia es débil (meta-cases: flash solo capta dedo, cara oscura, usuario vestido...) **el sistema cae con elegancia al modo dedo existente sin pérdida** — el chat del welcome scan explica qué causó caigor y qué pasos le aumentan calidad. **Cero lecturas falsas:** esto es lo que el repo ya exige (`waveHonesty`).

---

## 12. Arquitectura técnica (mapa de trabajo)

```
CameraView trasera+torch ─────────────┐   CameraView frontal (o plugin nativo)
   PPGSignalProcessor (dedo)          │   PPGSignalProcessor (cara, POS)
   (existente; modo dual)             │   (existente; morfo filtrado 0.5-5Hz)
            │                         │            │
            └────────► alineación temporal (timestamps reales, jitter)
                                  │
                   crossSiteTransitTime.ts  (NUEVO: GCC-PHAT + onset beats + τ)
                                  │
                   nexusCoherence.ts (NUEVO: congruencia multisitio)
                                  │
        Windkessel+PDA ─── MLP Deep-NEXUS ─── CSTT ─── HRV/resp covariates
                                  │
                   nexusFusionCore.ts (NUEVO: KKF con R_i por fuente)
                                  │
        salida: SBP/DBP/MAP + banda p5-p95 + confianza + motivação técnica
```

**Archivos nuevos (estimados) y contratos esbozados:**

```ts
// src/lib/vitals/crossSiteTransitTime.ts (NUEVO — puro, sin cámara)
export interface TransitTimeInput { proximal: Float32Array; distal: Float32Array;
  sampleRateHz: number; proximalPeakTimesMs?: number[]; distalPeakTimesMs?: number[]; }
export interface TransitTimeResult { tauMs: number | null; quality: number;
  reason: string; beatsAgreed: number; gccLagMs: number | null; }
export function estimateCrossSiteTransitTime(inp: TransitTimeInput): TransitTimeResult;

// src/lib/vitals/nexusFusionCore.ts (NUEVO — puro)
export class NexusFusionCore { pushObservation(src, value, variance, ts); getState(): {...} }

// src/lib/vitals/nexusCoherence.ts (NUEVO — puro)
// src/lib/device/dualCameraBridge.ts (NUEVO — web + capacitor plugin interface)
// src/hooks/useNexusSession.ts (NUEVO — orquestación UX del modo NEXUS)
// training/train_bp_nexus.py (NUEVO — fuera del bundle, datos públicos)
```

**Afectados (mínimos incrementales):**
- `src/modules/vital-signs/CalibrationManager.ts` — nuevos perfiles (CSTT A/B, SpO2 ridge) con vigencia.
- `src/modules/vital-signs/BloodPressureProcessor.ts` — guardar los resultados de pwaFusion y aceptar observaciones de la fusión NEXUS (sin romper su contrato actual).
- `src/components/SettingsPanel.tsx` — pestaña de Calibración NEXUS (Bland-Altman vivo).
- `src/components/SplashScreen.tsx` y `Index.tsx` — entrada al modo NEXUS como mod descrito.
- `supabase/migrations/*` — columnas adicionales (nexus_sources, tau_ms, banda p5/p95).

---

## 13. Plan de verificación (acumulado, Fähse por fase)

**A. Tests unitarios de lógica pura (vitest):**
- `crossSiteTransitTime.test.ts`: señales de referencia construidas ANALÍTICAMENTE (creación en el test de una señal retardada conocida con la misma frecuencia y amplitud: es un banco de señales de referencia del test, no simulación de medición) → τ recuperado con error < resolución; casos de ruido, latidos irregulares, ventana corta, fuera de banda → rechazo correcto.
- `nexusFusionCore.test.ts`: convergencia, pesos por calidad, bandas, degradación.
- `nexusCoherence.test.ts`: umbrales y estados.
- Regresión frontal: los tests del BandpassFilter compartido **no se tocan** (regla AGENTS.md); si NEXUS requiere banda nueva, se mantiene el filtro de producción intacto y se añaden regresiones JUNTO a los test compartidos con respuestas de transferencia independientes.

**B. Checks del repo en cada cambio:** `npm run check:all` completo (lint, typecheck, check:orphans, check:architecture, check:no-sim, tests, build, check dist).

**C. Estudio de referencia (cuando la captura dual esté lista):** protocolo escrito en `docs/medical-validation.md` — voluntarios, 3 pares por sesión + Stroop para inducir variabilidad + análisis Bland-Altman y MAE; separación por cohortes (edad, HR basal, tensión basal).

**D. Dispositivos-límite del conjunto real:** nodos de fallback L0→L3, bajo FPS, flash no disponible, una sola cámara.

---

## 14. Metas cuantitativas (objetivos declarados — absolutamente no logros asumidos)

| Métrica | Modo | Objetivo | Referencia pública de comparación |
|---|---|---|---|
| MAE SBP | NEXUS + calibración | ≤ 5 mmHg | EMBC 2025: 3.74 |
| MAE DBP | NEXUS + calibración | ≤ 4 mmHg | EMBC 2025: 2.73 |
| MAE SBP/DBP | dedo + calibración (sin NEXUS) | ≤ 7/5 mmHg | línea literature de PWA (revisión Sensors 2026) |
| SpO2 | tras calibración personal | banda p95 de error declarada ≤ ±4 | UW npj 2022 (MAE 5%) |
| Detección SpO2 < 92% | NEXUS | sensibilidad ≥ 0.75, especificidad ≥ 0.90 | UW npj 2022 (81% a <90) |

---

## 15. Hoja de ruta por fases (cada fase termina con reproducibilidad verificada)

- **F0 — Piedra angular (matemática pura):** `crossSiteTransitTime.ts` + tests + `nexusCoherence.ts` + tests. *Entregable:* estimador de τ listo para producción, cero dependencias de cámara.
- **F1 — Motor de fusión:** `nexusFusionCore.ts` (KKF con varianzas por fuente) + tests + integración como fuente adicional en `BloodPressureProcessor` (sin romper el contrato actual, siempre detrás de feature-flag).
- **F2 — Captura dual web:** `dualCameraBridge.ts` (getUserMedia dual) + `useNexusSession.ts` + UI de coherencia en `PPGSignalMeter`/panel de telemetría. Verificación: sesiones con 2 cámaras en dispositivos de prueba; fallback L1/L0 cubierto por tests de estado.
- **F3 — Calibración NEXUS:** tab Calibración en `SettingsPanel` (wizard + Bland-Altman vivo), migración Supabase de columnas NEXUS, vigencias en `CalibrationManager`.
- **F4 — SpO2 nex-gen:** ratio triple en `SpO2Calculator` + TMDS (modulación del torch con temporización segura para el registro de IL alignments) + regresor personal + banda de incertidumbre.
- **F5 — Deep NEXUS:** `training/train_bp_nexus.py` con datos públicos reales + export/treed + ficha de promoción de pesos + actualización `mlpWeights.ts`/provenance según patrón vigente.
- **F6 — Estudio y publicación interna:** protocolo de validación en `docs/medical-validation.md`, panel de resultados, ajuste del modelo por cohortes, iteración.

**Criterio de final de encargo global:** F0–F4 integrados y verificados; F5 opcional según criterio del usuario (los pesos anteriores quedan documentados como "sintéticos; no pesan"); los criterios de `docs/no-simulation-audit.md` revered en cada fase.

---

## 16. Referencias (mera lista navegante, verificada al día de este documento)

1. EMBC 2025 — Smartphone dual-camera PTT (ear–finger) BP screening — PMID 41337391. https://pubmed.ncbi.nlm.nih.gov/41337391/
2. JMIR mHealth 2023 — AlwaysBP, BP por cámara+IMU del smartphone — https://mhealth.jmir.org/2023/1/e44147
3. Sensors (MDPI) 2026 — Beyond the Cuff: State-of-the-Art on Cuffless Blood Pressure — https://www.mdpi.com/1424-8220/26/4/1243
4. npj Digital Medicine 2026 — Towards trustworthy AI-driven cuffless BP monitoring — https://www.nature.com/articles/s41746-026-02898-7
5. npj Digital Medicine 2022 — Smartphone camera oximetry in induced hypoxemia study — https://www.nature.com/articles/s41746-022-00665-y
6. Bioengineering (MDPI) 2024 — Contactless SpO2 from facial video — https://www.mdpi.com/2306-5354/11/3/251
7. arXiv 2404.15352 — TransfoRhythm (BP via solo PPG, transformer) — https://arxiv.org/abs/2404.15352
8. arXiv 2503.08015 — GPT-PPG (foundation model PPG) — https://arxiv.org/html/2503.08015v1
9. arXiv 2606.11125 — DMT (demographic conditioning + morphology) — https://arxiv.org/html/2606.11125v1
10. arXiv 2607.23406 — Blood Pressure Estimation from PPG: A Comparative Study (ECG-mediated pipeline) — https://arxiv.org/html/2607.23406v1
11. AI4HealthUOL/ppg-ood-generalization — benchmark OOD PPG→BP — https://github.com/AI4HealthUOL/ppg-ood-generalization
12. Electronics (MDPI) 2025 — Advancements in rPPG — https://www.mdpi.com/2079-9292/14/5/1015
13. npj Digital Medicine 2025 — Reliability of rPPG under low light — https://www.nature.com/articles/s41746-025-02192-y
14. IEEE Spectrum — New smartphone sensor for BP (PTT resumen) — https://spectrum.ieee.org/measure-your-blood-pressure-using-just-your-phone

*Datasets públicos: VitalDB (vitaldb.net), MIMIC-III/IV (physionet.org), PPG-BP dataset, UBFC-RPPG, MMPD, VIPL-HR — todos sujetos a sus licencias y protocolos de uso.*
