# NEXUS-VITALS GEN-II — Diseño de siguiente generación (2026)

**Objetivo:** superar el estado del arte publicado en PA y SpO2 por cámara, usando SOLO los recursos que un smartphone ya tiene (cámaras, flash, IMU, pantalla, cómputo). Este documento parte de la investigación web del estado del arte 2015–2026 y define las 6 innovaciones que GEN-II añade sobre el blueprint NEXUS actual (`docs/nexus-vitals-blueprint.md`). Igual que NEXUS: **cero simulación, cero resultados inventados — solo objetivos declarados y verificados con el protocolo de `docs/validation-protocol.md`**.

---

## 1. Qué dice la literatura más avanzada (fuentes verificadas)

| Hallazgo | Resultado | Fuente |
|---|---|---|
| **PTT + PIR (Photoplethysmogram Intensity Ratio)**: PTT sigue la variación de alta frecuencia (respiratoria) de la PA, pero falla en baja frecuencia (tono vasomotor). PIR — el ratio de intensidad del propio PPG — traza esa componente LF. Combinar ambos rindió MAD 4.09/3.18/3.18 mmHg (SBP/DBP/MAP) contra Finapres. | La clave no es "mejor PTT": es **PTT + un segundo regresor ortogonal para LF**. | [IEEE TBE 2015, PTT+PIR](https://ieeexplore.ieee.org/document/7273864/) |
| **Personalización extrema con transformers**: modelo end-to-end personalizado (ECG+PPG, contrastive loss) logra **MAE 1.08/0.68 mmHg**; con pocos datos por sujeto, transfer learning supera a todos los SOTA. | La personalización (no el modelo genérico) es el camino a precisión "clínica". | [IEEE 2024, personalized cuff-less BP](https://ieeexplore.ieee.org/document/10445970/) |
| **Fusión demográfica con atención (CNN+Transformer)** sobre PulseDB: cumple AAMI y **Grado A BHS** con MAE 3.79/2.37 mmHg sin personalización. | Las covariables demográficas + atención mejoran el arranque en frío antes de calibrar. | [IEEE 2025, demographic attention fusion](https://ieeexplore.ieee.org/document/10849156/) |
| **BPNet — PA sin contacto por video facial con transformer, SIN calibración** (BESTLab + VV). | El modo facial sin manguito de referencia es viable como *primer arranque*. | [IEEE 2025, BPNet](https://ieeexplore.ieee.org/abstract/document/10756549/) |
| **PTT oreja→dedo con cámara dual de un solo teléfono**: MAE 3.74/2.73 mmHg, r=0.877/0.868 (EMBC 2025). | Valida nuestra columna CSTT; la barrera real es la sincronización multisitio. | [PubMed 41337391, EMBC 2025] |
| **Oximetría por cámara sin modificar** con hipoxemia inducida (FiO2 controlado): MAE 5.00% SpO2 hasta <85%, sensibilidad hipoxemia 81%/esp. 79%. | El techo actual del RGB puro; para superarlo hay que **añadir información espectral y temporal controlada**, no más capas. | [npj Digital Medicine 2022, UW](https://www.nature.com/articles/s41746-022-00665-y) |
| **Oximetría multispectral sin contacto (3λ: 660/810/940 nm)** — la "SpO2 camera" original demuestra SpO2 espacial resuelto con ROIs y espectros por tesela. | Con flash + pantalla + cámara RGB podemos aproximar 2–3 longitudes de onda efectivas por modulación temporal. | [Ann Biomed Eng 2005, multispectral PPG imaging](https://link.springer.com/article/10.1007/s10439-005-5763-2) |
| **Advertencia AHA (2025)**: los dispositivos cuffless miden *cambios* respecto a calibración; su exactitud colapsa con postura, movimiento e hidrostática, y casi nadie valida eso. | GEN-II convierte esta debilidad del resto de la industria en **nuestra ventaja**: control postural + hidrostático explícito en cada medición. | [AHA, Cuffless Devices](https://professional.heart.org/en/science-news/cuffless-devices-for-the-measurement-of-blood-pressure) |
| Los smartwatches validados en la vida real muestran sesgo proporcional (sobreestiman bajos, subestiman altos). | Refuerza: **regresión personalizada + corrección de sesgo proporcional** (Taffé) en nuestro pipeline. | [Frontiers Cardiovasc Med 2022](https://doi.org/10.3389/fcvm.2022.958212) |

**Conclusión lateral:** el cuello de botella no es el sensor — es (1) la variabilidad de baja frecuencia que PTT no ve, (2) la calibración que envejece, (3) la incertidumbre no declarada, y (4) la postura/hidrostática no controlada. GEN-II ataca los cuatro con física y diseño, no con fe.

---

## 2. Tesis GEN-II

> **La precisión "cerca del manguito" emerge de: (i) dos regresores fisiológicamente ortogonales (PTT→HF, PIR/compresibilidad→LF), (ii) personalización continua que nunca deja de aprender, (iii) incertidumbre declarada por medición que degrada con la evidencia, y (iv) instrumentación activa: el teléfono no solo observa — controla la luz y la postura durante la medición.**

---

## 3. Las 6 innovaciones GEN-II

### H. PIR-LF: el segundo regresor ortogonal (cierra la brecha de baja frecuencia)
El blueprint NEXUS estima PA por PTT (HF). GEN-II añade el **PIR** demostrado en [PTT+PIR, IEEE 2015](https://ieeexplore.ieee.org/document/7273864/):
- `PIR = (AC/DC)₂ / (AC/DC)₁` — ratio de intensidad pulsátil entre sub-bandas o entre el componente de inyección y el diástole, sensible al cambio de diámetro arterial (Bramwell–Hill: `dV/V ∝ dP/E`).
- Estimación: `BP_LF = PIR-model + tendencia de calibración`; se fusiona con `BP_PTT` en la KKF existente con covarianzas separadas por banda espectral (LF 0.04–0.15 Hz, HF 0.15–0.5 Hz).
- **Test de independencia:** PIR y PTT no deben correlacionar en HF (verificación en cada sesión; si correlacionan >0.7, la KKF no duplica confianza).

### I. Calibración viva: el modelo personal nunca deja de aprender
La literatura de personalización extrema muestra MAE <1.1 mmHg *cuando el modelo ve suficientes datos del sujeto*. GEN-II convierte cada medición en dato de entrenamiento online:
- **Regresor personal ridge-incremental** (covariables: 1/τ², PIR, HR, RMSSD, fase respiratoria, edad de calibración) actualizado con cada par (medición, referencia de tensiómetro) que el usuario registre — sin almacenar señales crudas, solo features y referencias (privacidad).
- **Transfer inicial demográfico:** antes de 3 referencias, el prior viene de un modelo demográfico-atenso entrenado off-device (patrón [demographic attention fusion](https://ieeexplore.ieee.org/document/10849156/)); el MLP con procedencia existente (`mlpWeights.ts`) es el vehículo.
- **Corrección de sesgo proporcional (Taffé):** el panel Bland-Altman existente se amplía con estimación de sesgo ∝ nivel; si el sistema sobreestima SBP bajos, la corrección entra en el regresor personal.
- **Desgaste de calibración:** edad de calibración entra como covariable y como inflador de varianza (`σ² ← σ²·(1 + edad_días/90)`), como exige el marco de [trustworthy cuffless AI (npj 2026)](https://www.nature.com/) citado en el blueprint.

### J. Instrumentación activa de luz (SpO2 más allá del MAE 5%)
El techo del RGB pasivo es información espectral insuficiente. GEN-II controla la fuente:
- **Flash PWM bimodal:** el LED blanco tiene dos emisores (azul frío + ámbar cálido) en la mayoría de teléfonos; alternarlos por tramo de frames crea dos pseudo-longitudes de onda (∼450 nm y ∼600 nm) sobre el mismo tejido → ratio dual real en lugar del proxy R/G pasivo.
- **Pantalla como segunda fuente:** frente a la cámara, la pantalla puede emitir rojo puro (`rgb(255,0,0)`) para el canal facial en rPPG multi-λ (patrón [multispectral PPG imaging, 2005](https://link.springer.com/article/10.1007/s10439-005-5763-2)).
- **Ratio triple ya existente** (`spo2TripleRatio.ts`) pasa de heurística a calibración por emisores: cada ratio se asigna a su λ efectiva medida con una carta de color estándar en el onboarding (1 sola vez).
- Objetivo declarado: reducir el MAE de 5.00% (techo UW) hacia ≤3% tras calibración personal, con banda p5–p95 declarada por medición.

### K. Control activo de postura e hidrostática (la respuesta directa a la crítica AHA)
La [advertencia de la AHA](https://professional.heart.org/en/science-news/cuffless-devices-for-the-measurement-of-blood-pressure) es exactamente donde podemos superar a la industria:
- **Verificación postural por IMU** (ya en el device): pitch del teléfono <10°; si no, la medición entra en modo "postura guiada" con instrucciones en vivo.
- **Hidrostática explícita:** la mano con el dedo en el flash a altura del corazón (`hydrostaticCalibration.ts` ya existe) — GEN-II añade verificación por IMU + guía: Δh ≈ 0 entre corazón y punto de medida; corrección `ΔP = ρ·g·Δh` (≈0.77 mmHg/cm) cuando el usuario declara posición no estándar.
- **Ventana de estabilidad:** la medición solo cierra si la deriva de τ y PIR en los últimos 20 s está dentro de banda; si no, "sin lectura por inestabilidad" — honestidad antes que apariencia (regla `waveHonesty` del repo).

### L. NEXUS multimodal en profundidad: cara + dedo + IMU (seismocardiograma)
[AlwaysBP (JMIR 2023)](https://mhealth.jmir.org/2023/1/e44147/) validó PTT por cámara+IMU como instrumento clínico. GEN-II integra el **SCG del acelerómetro** apoyado sobre el pecho o sostenido:
- `τ_SCG = t(aórtico, IMU) − t(dedo, cámara)`: elimina la ambigüedad del sitio proximal facial (la cara no es arterial proximal pura).
- Fusión de tres τ (cara→dedo CSTT, SCG→dedo, co-pulsación SCG) con desacuerdo >20 ms → marcador de coherencia bajo (`nexusCoherence.ts` extendido).
- Modo degradado elegante por capa (dedo solo → dedo+IMU → cara+dedo → cara+dedo+IMU), cada uno con su banda de confianza declarada.

### M. Incertidumbre calibrada y adjudicación final
Siguiendo el estándar emergente (npj Digital Medicine 2026, "trustworthy cuffless BP"):
- Cada lectura lleva `(BP̂, σ)`, y σ se **calibra**: en la población de mediciones del usuario con referencia, el z-score `(BP_ref − BP̂)/σ` debe ser N(0,1) — test automático en el panel Bland-Altman (ya existente) extendido con histograma de z-scores.
- **Adjudicador:** si el intervalo `BP̂ ± 2σ` cruza un umbral clínico (130/80), el sistema lo declara y sugiere repetición con guía — nunca emite "confirmado" sin verificación interna.

---

## 4. Arquitectura de fusión (extendiendo la KKF existente)

```
                     ┌──────────────────────────────┐
 cara (rPPG) ───────▶│                              │──▶ τ_CSTT ──┐
 dedo (PPG+flash) ──▶│  alineación + GCC-PHAT fine  │             │
 IMU (SCG) ─────────▶│  + validación fisiológica    │──▶ τ_SCG ───┼──▶ [BP_HF: 1/τ² + ridge personal]
                     └──────────────────────────────┘             │
 dedo (AC/DC) ──────────────────────────────────────▶ PIR ────────┴──▶ [BP_LF: modelo PIR]
 dedo (R/G/B modulado) ──▶ oximetría bimodal+triple ──▶ SpO2 ──▶ (intervalo p5–p95)
 respiración (RIAV/RIIV) ──▶ covariables + fase
                                        │
                              ┌─────────▼──────────┐
                              │  KKF N-fuentes     │  ← covarianzas por banda (HF/LF separadas)
                              │  + adjudicador σ   │  ← infladores: edad calibración, coherencia,
                              └─────────┬──────────┘     SQI, postura, desacuerdo multisitio
                                        ▼
                          (BP̂, σ, SpO2 ± banda, trazabilidad completa)
```

**Principios no negociables** (heredados y reforzados):
1. `check:no-sim` se aplica a GEN-II: ningún resultado entra al sistema sin señal real detrás.
2. Los pesos nuevos (regresor demográfico, personal incremental) mantienen **huella y procedencia** verificable (`mlpWeightsProvenance.ts`, `training/check_weights_fingerprint.py`).
3. Toda exactitud citada de la literatura queda atribuida a su estudio; la de GEN-II se declara solo cuando el protocolo de validación la mida.

---

## 5. Plan de implementación por fases (cada fase termina en verde: tests + lint + typecheck + build)

| Fase | Contenido | Criterio de salida |
|---|---|---|
| **G2-1** | PIR-LF: extracción, test de independencia con τ, entrada en KKF con covarianzas por banda | Tests unitarios con señales de referencia independientes; sin regresión en el pipeline actual |
| **G2-2** | Calibración viva: regresor ridge-incremental + inflador de varianza + corrección Taffé en el panel BA | Tests de promoción/derogación de pesos; z-scores calibrados en datos registrados |
| **G2-3** | Instrumentación activa: PWM bimodal del flash + carta de color en onboarding | Tests de estados de torch/PWM (TORCH_UNAVAILABLE → fallback al modo pasivo actual) |
| **G2-4** | Hidrostática + postura por IMU con guía en vivo y ventana de estabilidad | Tests de estados de adquisición y rechazos honestos |
| **G2-5** | τ_SCG por IMU + fusión de tres τ y coherencia extendida | Tests de desacuerdo/degradación por capa |
| **G2-6** | Entrenamiento off-device del regresor demográfico-atenso (PulseDB/MIMIC subset público) con huella | Procedencia verificable; OOD generalización medida antes de promover pesos |

## 6. Regla de oro que gobierna todo el diseño

**La pregunta correcta no es "¿cómo mido mejor con un sensor?" sino "¿qué información independiente puedo agregar en este mismo instante con lo que ya tengo?"** — luz controlada (espectro), movimiento controlado (postura), segunda señal (IMU), segundo sitio (cara), segunda banda (PIR/LF), y tiempo (calibración viva). Cada una de las seis innovaciones responde esa pregunta con un recurso que el teléfono ya tiene.
