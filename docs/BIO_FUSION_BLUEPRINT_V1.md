# BIO BEAT — Research & Engineering Blueprint v1

Fecha: 13 de noviembre de 2026  
Repositorio de referencia: charly7978/bio-beat-tracker-041707cb  
Rama de trabajo: research/bio-fusion-v1

## 1. Misión técnica

Construir una plataforma móvil que extraiga señales fisiológicas reales del teléfono, las relacione con la fisiología humana y produzca valores numéricos de frecuencia cardíaca, frecuencia respiratoria, SpO₂ y presión arterial cuando la evidencia disponible permita una estimación. El sistema debe conservar el origen, el método, la calibración, la calidad y la incertidumbre de cada resultado.

El objetivo no es reemplazar un sensor por una ecuación aislada. Es aumentar la observabilidad del organismo mediante fusión de señales ópticas, mecánicas, acústicas y datos personales longitudinales.

La pantalla debe mostrar valores cuando el motor disponga de observaciones suficientes. Un resultado experimental puede mostrarse como estimación experimental; no debe transformarse en una medición validada por un simple cambio de etiqueta.

## 2. Fundamento médico: el organismo es un sistema acoplado

### 2.1 Hemodinámica

El gasto cardíaco se expresa como:

GC = FC × VS

donde FC es la frecuencia cardíaca y VS el volumen sistólico.

En condiciones habituales, la presión arterial media puede aproximarse por:

PAM ≈ GC × RVS

donde RVS representa la resistencia vascular sistémica. La relación es una simplificación útil; no significa que el teléfono pueda obtener presión despejando una variable a partir de BPM.

El mismo BPM puede coexistir con distintos volúmenes sistólicos, estados de precarga, contractilidad y resistencias vasculares. Por eso un pulso de 130 BPM no impone por sí solo un máximo de SpO₂ ni determina una presión sistólica o diastólica.

### 2.2 Transporte de oxígeno

El contenido arterial aproximado de oxígeno puede expresarse como:

CaO₂ ≈ 1.34 × Hb × SaO₂ + 0.003 × PaO₂

La saturación describe la fracción de hemoglobina ocupada por oxígeno; el contenido depende también de la concentración de hemoglobina. Un hemograma histórico puede modificar la interpretación del transporte de oxígeno, pero no mide la saturación actual.

La oxigenación arterial depende de ventilación, relación ventilación/perfusión, difusión, cortocircuitos y otras variables pulmonares y circulatorias. La frecuencia cardíaca puede cambiar en respuesta a hipoxemia, pero no permite deducirla de manera unívoca.

### 2.3 Regulación autonómica

El sistema nervioso autónomo modifica frecuencia cardíaca, tono vascular, sudoración y respuestas posturales. Los intervalos entre pulsos PPG permiten calcular variabilidad del pulso (PRV). PRV no es idéntica a HRV derivada de ECG: su concordancia depende de la condición, el movimiento, la perfusión y el sitio de medición.

### 2.4 Respuesta respiratoria y circulatoria

La respiración modula el retorno venoso, el volumen sistólico y los intervalos entre pulsos. En PPG se estudian RIAV (amplitud), RIIV (intensidad/baseline) y RIFV (frecuencia/intervalos). Estas modalidades son parcialmente correlacionadas porque pueden derivar de la misma cadena óptica. Deben ponderarse según su calidad y dependencia, no contarse como tres sensores independientes.

### 2.5 Respuesta postural

El cambio de decúbito a bipedestación modifica retorno venoso y respuesta barorrefleja. Una prueba postural controlada ofrece un estímulo fisiológico reproducible y datos útiles de FC, intervalos, PPG, respiración y movimiento. Puede estudiar tendencias y respuesta autonómica; no debe usarse como sustituto directo de una lectura de presión arterial.

## 3. Qué observamos y qué inferimos

### Observaciones instrumentales

- Cámara trasera y flash: secuencias RGB, PPG de contacto, AC/DC por canal, forma de onda, amplitud y perfusión relativa.
- Cámara frontal: rPPG facial y movimiento torácico, cuando el dispositivo y la adquisición lo permitan.
- Acelerómetro y giroscopio: movimiento, orientación, cambios posturales y componentes mecánicos relacionados con respiración.
- Micrófono: envolventes y periodicidad respiratoria, tos y características acústicas experimentales. Un micrófono integrado no equivale a un estetoscopio.
- Barómetro: presión atmosférica/altitud aproximada, si existe. No mide presión arterial.
- Sensor de luz: contexto de iluminación.
- Perfil individual y análisis: edad, antropometría, medicación, hemoglobina, hematocrito, glucosa, electrolitos y antecedentes con fecha, unidad y procedencia. Son contexto; no sensores del estado actual.

### Inferencias

- BPM: frecuencia del pulso detectado por PPG.
- PRV: variabilidad de intervalos entre pulsos; debe llamarse PRV cuando la fuente sea PPG.
- Respiración: fusión de RIAV/RIIV/RIFV, movimiento y, en una fase posterior, audio/cámara frontal.
- SpO₂: estimación óptica multicanal que necesita calibración empírica con referencia de oxigenación. El RGB no contiene un canal infrarrojo; el verde no es físicamente un LED IR.
- Presión arterial: regresión individualizada de características PPG/multimodales contra referencias de tensiómetro. La morfología aislada no determina universalmente mmHg.
- Estado fisiológico: inferencia temporal que integra señales y contexto, no diagnóstico etiológico automático.

## 4. Auditoría del código vigente

El repositorio ya contiene una base aprovechable:

- Captura de cámara con flash y control de restricciones.
- Worker PPG y timestamps de frames.
- ROI adaptativo, detección de contacto, SQI, filtros y ensemble de picos.
- Canales morfológico, respiratorio, arrítmico y RGB para SpO₂.
- Fusión respiratoria RIAV/RIIV/RIFV y soporte ACC.
- Estimadores numéricos de SpO₂ y presión arterial.
- Calibración individual y contratos de estados/confianza.

Hallazgos de integración comprobados:

1. useSignalRouter procesa signos vitales cada tres frames (ROUTER.VITALS_PROCESS_EVERY_N_FRAMES = 3). A 30 FPS nominales, la señal morfológica que se acumula en VitalSignsProcessor quedaba en aproximadamente 10 muestras/s.
2. VitalSignsProcessor asumía 10 Hz para la señal respiratoria lenta, aunque la cadencia real depende del FPS del teléfono y del stride del router. La serie respiratoria y la señal de pulso no conservaban timestamps, por lo que esa frecuencia fija podía distorsionar la estimación.
3. BloodPressureProcessor recibía sampleRate=30 aunque la morfología acumulada llegaba a unos 10 samples/s a 30 FPS. PPGFeatureExtractor utiliza sampleRate para ciclos, tiempos de subida, anchuras y derivadas.
4. PPGSignalProcessor entrega accelRespiration en cada ProcessedSignal. useSignalProcessor captura DeviceMotion en el hilo principal y lo envía al Worker. Sin embargo, useSignalRouter no transmitía lastSignal.accelRespiration al argumento correspondiente de VitalSignsProcessor. La modalidad ACC estaba implementada pero no llegaba al motor de fusión.
5. VitalSignsProcessor admite parámetros de rostro (faceBvp, faceBpm, faceQuality), pero el flujo de router/hook actual no entrega una observación facial. Es una capacidad futura, no una fuente disponible en la medición actual.
6. SpO2Calculator usa relaciones RGB y coeficientes polinómicos genéricos, con una linealización de cámara fija. El código calcula un número, pero el repositorio no contiene validación de ese número frente a una referencia independiente.
7. pwaPhysiologicalBpEngine combina pesos MLP derivados de etiquetas sintéticas y funciones de normalización/ponderación denominadas índices hemodinámicos. Los nombres Windkessel, resistencia, compliancia y stiffness no prueban que esas cantidades físicas estén identificadas a partir de la señal.
8. training/train_bp_mlp.py genera entradas y etiquetas con fórmulas creadas en el propio script. Su conjunto de validación se genera con la misma familia de fórmulas; no es validación clínica.
9. Los tests de presión actuales verifican plausibilidad matemática y rangos, usando señales sintéticas. No miden error frente a tensiómetro.

## 4.1 Primera intervención implementada en research/bio-fusion-v1

- La ruta morfológica conserva una muestra con timestamp de cada frame estable, aunque VitalSignsProcessor se ejecute a una cadencia menor.
- La morfología se resamplea a una serie uniforme sin elevar la frecuencia por encima de la observada. Se rechazan ventanas con frecuencia menor de 20 Hz, jitter excesivo o huecos largos.
- BloodPressureProcessor recibe la frecuencia resampleada y rechaza tasas inválidas en lugar de asumir 30 Hz.
- La respiración óptica y la señal de pulso conservan timestamps y se resamplean a un objetivo de 10 Hz; si el teléfono entrega menos, se utiliza la tasa real.
- El router entrega la modalidad ACC ya generada por PPGSignalProcessor y limpia ventanas temporales al perder estabilidad/contacto o detectar movimiento.
- Se agregaron pruebas del resampleador para 30, 24 y 8 Hz, jitter, timestamps fuera de orden y huecos largos, además de una prueba de integración que verifica la frecuencia entregada al estimador BP.

Esta primera corrección resuelve errores de sincronización/frecuencia; no valida clínicamente los modelos de SpO₂ ni BP ni convierte sus salidas actuales en mediciones médicas certificadas.

## 5. Arquitectura objetivo

### Capa A — Adquisición nativa y web

Mantener React/TypeScript para la experiencia. Evaluar un puente nativo Kotlin con Camera2/CameraX para controles fotométricos, timestamps de sensor, exposición, ganancias y capacidades concurrentes. No asumir que todos los teléfonos permiten cámaras frontal y trasera simultáneas.

Canales de adquisición previstos:
- OpticalCapture: frames/timestamps RGB, torch, exposición, foco y metadatos.
- MotionCapture: aceleración, gravedad estimada, giroscopio, orientación y timestamp.
- AudioCapture: audio bruto local y derivaciones de baja dimensión, con consentimiento explícito.
- FaceCapture: regiones cutáneas y movimiento torácico con cámara frontal.
- UserContext: perfil, medicación, antecedentes y estudios confirmados por usuario.

### Capa B — Reloj común

Cada muestra debe llevar timestamp monotónico, fuente temporal, unidad, frecuencia observada y estado del dispositivo. No se debe asumir que el FPS solicitado equivale al FPS capturado ni que todas las fuentes comparten automáticamente la misma época.

### Capa C — Extracción de características

- PPG: AC/DC, RI, perfusión relativa, pendientes, anchuras, fiduciales, armónicos, SNR, SQI y artefactos.
- Tiempo: intervalos entre pulsos, PRV, irregularidad y latencia.
- Respiración: RIAV, RIIV, RIFV, ACC, movimiento torácico y audio.
- Movimiento: aceleración lineal, orientación, postura, vibración y contaminación.
- Perfil: edad, antropometría, laboratorio, medicación, fecha y confiabilidad del dato.

### Capa D — Modelos especializados

CARDIO: BPM y PRV.  
RESPIRATORY: estimación respiratoria multimodal.  
OXYGEN: modelo RGB temporal calibrado contra oxigenación de referencia, específico por dispositivo o dominio fotométrico.  
PRESSURE: modelo PPG/multimodal calibrado y validado contra referencias de presión.  
BIO PROFILE: contextualización longitudinal, no sustitución de mediciones actuales.

### Capa E — Bio Fusion

Modelo temporal de estado con variables observadas y latentes. Comparar modelos de espacio de estados, filtros de Kalman extendidos/partículas y redes temporales. Fusionar por calidad, incertidumbre, dependencia entre canales y cambio de contexto.

No inferir una variable desconocida por álgebra simple a partir de una correlación poblacional. La ausencia de una señal no debe reemplazarse por otra variable no equivalente.

### Capa F — Salida numérica trazable

Cada estimación incluirá:
- valor y unidad;
- timestamp;
- método/modelo y versión;
- observaciones utilizadas;
- calidad de señal;
- calibración y vigencia;
- intervalo de incertidumbre o error esperado;
- condición de uso (reposo, postura, movimiento);
- etiqueta: medición directa, estimación calibrada o estimación experimental.

La UI puede presentar valores numéricos de estimación y tendencias, pero no ocultará que son experimentales ni mostrará cifras ficticias cuando no haya observación utilizable.

## 6. Diseño por signo vital

### 6.1 Frecuencia cardíaca

Prioridad: preservar el pipeline PPG existente, comparar contra ECG/monitor validado y estudiar la generalización por dispositivo, perfusión, pigmentación, temperatura y ejercicio.

No confundir BPM promedio con latido a latido. Guardar timestamps de cada pico y calidad individual.

### 6.2 Variabilidad

Usar nomenclatura PRV para intervalos PPG. Comparar con ECG simultáneo en reposo, respiración controlada, postura, ejercicio y recuperación. No transferir límites clínicos de HRV a PRV sin evaluación.

### 6.3 Respiración

Primera versión: RIAV + RIIV + RIFV + ACC, con el canal ACC realmente conectado. Próximas modalidades: video frontal de tórax/cara y micrófono. Comparar contra banda respiratoria o capnografía según el protocolo.

### 6.4 SpO₂

Investigación:
- Capturar ventana temporal RGB cruda y parámetros fotométricos, no solo un ratio agregado.
- Controlar exposición, balance de blancos, ganancia, saturación, clipping y temperatura del teléfono.
- Evaluar modelos temporales RGB/Transformer con módulo explícito de calidad.
- Estudiar variantes por dispositivo y calibración.
- Validar contra un oxímetro de referencia durante el desarrollo y, en estudios específicos, contra cooximetría arterial.
- Separar datos por participante y por dispositivo para evitar fuga de información.

La SpO₂ no se deduce del color visual de la sangre ni de BPM. La investigación con smartphone de Hoffman et al. (2022) alcanzó MAE de 5 puntos porcentuales en un estudio inducido pequeño de seis participantes: demuestra potencial de investigación, no precisión clínica. El trabajo SETE de Luo et al. (2025) reporta MAE de 1,35% y RMSE de 2,08%; debe reproducirse y auditarse su cohorte, separación de sujetos, hardware, protocolo y generalización antes de trasladar cifras al producto.

### 6.5 Presión arterial

Reformular el modelo:
- Mantener extracción morfológica, pero corregir su frecuencia y muestreo temporal.
- Diferenciar características observadas de índices heurísticos.
- Retirar del aprendizaje clínico las etiquetas sintéticas como si fueran presión real.
- Entrenar regresores con pares señal-referencia de la misma sesión, sujeto y dispositivo.
- Comparar modelos poblacionales, calibración individual y adaptación temporal.
- Validar sesgo, límites de concordancia, error por rango de presión, deriva de calibración y cambios posturales/actividad.

Un modelo basado en PPG puede ofrecer una estimación numérica experimental. La precisión absoluta en mmHg exige comparación con tensiómetro validado, calibración y evaluación independiente. La presión sin manguito es especialmente sensible a postura, actividad, temperatura, fármacos y tiempo desde calibración.

## 7. Literatura y datasets prioritarios

1. Bae et al., 2022, smartphone HR/RR: 95 participantes para FC, MAPE 1,6%; 50 para FR, MAE 0,78 respiraciones/min.  
   https://pmc.ncbi.nlm.nih.gov/articles/PMC9053269/

2. Hoffman et al., 2022, oximetría RGB por smartphone con hipoxemia inducida; datos abiertos y código asociado.  
   https://www.nature.com/articles/s41746-022-00665-y  
   https://github.com/ubicomplab/oximetry-phone-cam-data

3. Luo et al., 2025, SETE Transformer y evaluación de calidad para SpO₂ en videos de dedo.  
   https://doi.org/10.1109/TIM.2025.3548252

4. M³PD / F³Mamba, 2026, PPG dual frontal + trasera sincronizada en 60 participantes, 47 con enfermedad cardiovascular.  
   https://doi.org/10.1145/3810228  
   https://github.com/Health-HCI-Group/F3Mamba

5. CardioWave-Portable, PhysioNet 2026: 3.849 registros de 24 segundos de ECG/PPG sincronizados, 977 adultos y etiquetas de presión por manguito. Acceso controlado y acuerdo de uso.  
   https://physionet.org/content/cardiowave-portable/1.0.0/

6. AHA Scientific Statement, cuffless BP, diciembre 2025: calibración y validación en el mundo real son esenciales.  
   https://professional.heart.org/en/science-news/cuffless-devices-for-the-measurement-of-blood-pressure

7. PRV versus HRV, revisión sistemática y metaanálisis 2026.  
   https://pmc.ncbi.nlm.nih.gov/articles/PMC13517957/

8. MIMIC waveform datasets: ECG, PPG, respiración y, en subgrupos, presión arterial invasiva. Son útiles para preentrenamiento e investigación, pero proceden de entornos hospitalarios/UTI y requieren evaluación de cambio de dominio.

## 8. Protocolo de validación

- FC/PRV: ECG simultáneo.
- SpO₂: oxímetro de referencia; protocolos de hipoxemia sólo con supervisión clínica, ética y referencia apropiada.
- Presión: tensiómetro validado y protocolo estandarizado; referencias invasivas sólo en datasets clínicos con permiso.
- Respiración: banda respiratoria/capnografía según el objetivo.
- Movimiento y postura: referencia IMU y protocolo controlado.

Separación por participante, no por ventanas aleatorias de la misma persona. Evaluación externa en modelos de teléfono no vistos durante el entrenamiento. Reportar MAE, RMSE, sesgo, límites de concordancia, sensibilidad por umbral, tasa de rechazo, calibración y rendimiento por subgrupo.

## 9. Secuencia de implementación

P0 — Corregir muestreo temporal morfológico y conectar ACC al motor respiratorio.  
P1 — Registrar capacidades reales de cámara y crear contrato de observaciones sincronizadas.  
P2 — Construir dataset local de pruebas con referencias simultáneas y protocolo reproducible.  
P3 — Reentrenar SpO₂ y presión usando datos reales, validación por sujeto/dispositivo y calibración.  
P4 — Añadir captura frontal y audio con consentimiento, prueba de sincronización y control de privacidad.  
P5 — Implementar Bio Fusion temporal y perfil longitudinal.  
P6 — Evaluar rendimiento, seguridad y preparación para distribución.

## 10. Criterio de éxito

Bio Beat será mejor cuando:
- mida bien aquello que ya puede medir;
- aproveche fuentes que ya están disponibles;
- combine canales fisiológicamente relacionados;
- estime valores adicionales con modelos entrenados contra referencias reales;
- detecte cambios individuales útiles;
- y pueda explicar de qué evidencia procede cada número.

La ambición es producir más información fisiológica real que una aplicación de cámara convencional, no fabricar una apariencia de precisión.
