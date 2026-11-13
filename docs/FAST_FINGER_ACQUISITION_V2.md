# Bio Beat — Fast Finger Acquisition v2

## Objetivo

Reducir la latencia de primera detección cardíaca y los tirones de interfaz **sin inventar datos**, sin modificar las fórmulas de oxígeno/presión y sin eliminar el modo 3D.

## Auditoría del pipeline

1. **Valores cero sustituidos artificialmente.** `useSignalRouter` cambiaba los cruces por cero de la onda filtrada por el último valor válido. `HeartBeatProcessor` repetía parcialmente el mismo patrón: valores cercanos a cero se excluían o se sustituían por un decaimiento del último valor. Esto altera amplitud y periodicidad, y consume tiempo de adquisición con una secuencia que no corresponde al video.
2. **Rechazos convertidos en muestras.** Cuando `PPGSignalProcessor` devolvía señal cero por saturación, exposición o rechazo, la ruta cardíaca podía incorporarla como si fuera una observación real por el mecanismo de retención.
3. **Coste repetido en hilo principal.** El detector Elgendi/ensemble reprocesaba una ventana de hasta 300 muestras **en cada callback de frame**. Incluye normalización, filtrado, umbral adaptativo y evaluación de picos. Esta operación compite con React/Canvas.
4. **Latencia inicial del detector.** `minSamplesEnsemble=72`: equivalente a 2,4 s a 30 Hz incluso antes de habilitar picos. Esta es una puerta de entrada, no una garantía de que ya existan dos latidos reales en la ventana.
5. **Relajación de umbral no activa antes del primer pico.** `peakStallMs` era cero hasta emitir el primero, por lo que la lógica de reacquisición no auxiliaba al inicio.
6. **Estabilización de HR demasiado tardía.** Requería al menos 3.000 ms de BPM válido más 40 muestras estables y 30 frames de calidad. Se ejecutaba después de obtener intervalos RR, sumando demora a las ventanas ópticas.

## Cambios en esta rama

### Integridad de señal

- Las muestras numéricas cero **se conservan** cuando son observaciones físicas válidas del filtro.
- Frames inválidos por exposición, movimiento o estado de contacto **no ingresan** al buffer de detección como muestras fisiológicas. No hay relleno lineal, replicación del último valor ni ondas sintéticas.
- El detector recibe la marca monotónica de **captura del frame**, no la hora del callback React.
- Si un frame es inválido, se mantiene brevemente el último BPM derivado de RR reales (sin producir un nuevo latido), hasta la caducidad actual del hold.

### Velocidad de detección y coste

- La ventana mínima de arranque baja de **72 a 48 muestras**: de 2,4 a 1,6 s teóricos a 30 fps, antes de detectar suficientes picos. El inicio exacto depende de los latidos que realmente se hayan observado.
- El ensemble se evalúa cada **2 muestras válidas** (15 evaluaciones/s con 30 fps de captura), preservando cada muestra en el buffer y sin alterar el detector de periodicidad. Esta reducción de invocaciones NO implica que se inventen latidos intermedios.
- La ventana del ensemble se limita a **180 muestras** en vez de 300; es más que suficiente para varios ciclos cardíacos dentro del rango de BPM admitido.
- En ausencia de pico inicial, `peakStallMs` ahora mide el tiempo desde la primera muestra aceptada. Se evita la falta de reacquisición inicial.

### Estabilización verificable

- Ventana mínima de BPM convergido: **3.000 → 1.800 ms** (hasta 1.200 ms con SQI, PI, periodicidad y movimiento excelentes).
- Mínimo de observaciones de BPM: **40 → 20** (hasta 12 con calidad excelente).
- Persistencia de calidad: **30 → 18 frames**.
- Se exigen **al menos dos intervalos RR derivados de latidos emitidos** para pasar a READY. Repetir el último BPM a 30 fps no cuenta como nueva evidencia de pulsos.
- Se conservan las protecciones de contacto, calidad óptica, movimientos, período refractario y amplitud. No se alteran SpO2, BP ni estimaciones secundarias.

## Evidencia y límites

- Elgendi et al., PLOS ONE 2013: detección de picos sistólicos mediante moving averages y umbral de offset; https://doi.org/10.1371/journal.pone.0076585
- Charlton et al., Physiol. Meas. 2022: benchmark de detectores PPG; https://pmc.ncbi.nlm.nih.gov/articles/PMC9393905/
- Revisión de PPG en smartphone y protocolo de adquisición, 2024: https://doi.org/10.3389/fdgth.2024.1326511
- PPG y presión arterial con smartphone, 2022: efectos de movimiento y presión de colocación; https://www.nature.com/articles/s41746-022-00629-2

Las optimizaciones son **ingeniería experimental sobre el repositorio**, no resultados clínicamente validados. Se requiere medir FPS real, `time-to-first-peak`, `time-to-first-valid-RR`, `time-to-READY`, tasa de picos falsos, y variación de BPM con ECG o pulsómetro de referencia. Los modelos de SpO2 y BP no adquieren validez por mejorar la adquisición.

## Criterios de aceptación en Android

1. Con dedo ausente o un objeto rojo estático frente a la cámara, **no emitir picos ni BPM**.
2. Con dedo bien colocado, contar tiempo entre contacto óptico y primer pico, primer RR y READY; comparar con versión previa en el mismo teléfono y condiciones semejantes.
3. Mover o quitar el dedo: no deben producirse picos falsos ni mantenerse resultados nuevos por retención de muestras.
4. Medir `requestVideoFrameCallback`, carga del hilo UI y latencia de detección mientras el Canvas se desplaza.
5. Revisar saturación rojo/verde, cobertura y presión excesiva; estos artefactos pueden ser físicamente irresolubles en algunos dispositivos.
6. Validar CI: typecheck, tests, lint, reglas anti-simulación y build antes de fusionar.

## Próxima investigación

Diseñar un evaluador de calidad por ROI adaptativo a iluminación y perfusión real (evitando confundir saturación del canal rojo con ausencia de tejido), y comparar un detector en streaming O(1)/muestra con el ensemble Elgendi de ventanas. La elección entre canales RGB se resolverá por evidencia y tiempo efectivo de captura. Para SpO2, una cámara RGB sin canal IR auténtico requiere calibración por dispositivo y validación independiente; no se puede sustituir verde por infrarrojo. Para BP, calibrar contra referencias reales antes de utilizar modelos fisiológicos en mmHg.
