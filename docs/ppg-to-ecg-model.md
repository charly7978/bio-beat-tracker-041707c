# Modelo PPG → ECG entrenado: estado experimental

Se entrenó y exportó una red neuronal con registros **reales y pareados** de PPG y ECG de la base pública [BIDMC 1.0.0 de PhysioNet](https://physionet.org/content/bidmc/1.0.0/). No utiliza plantillas P–QRS–T ni formas de onda generadas como etiquetas. Sus pesos se encuentran en `src/lib/models/ppgToEcg.weights.json` y el entrenamiento reproducible en `training/train_ppg_to_ecg.py`.

**La evaluación muestra que este modelo no reconstruye de forma fiable el ECG individual.** Existe y está entrenado; eso no acredita exactitud médica. Su salida sólo permite investigar el comportamiento de una estimación aprendida. No debe usarse para interpretar P, QRS o T, medir PR/QRS/QT, identificar ritmo sinusal o realizar diagnósticos. La actividad eléctrica no se mide con la cámara.

## Datos y separación de personas

- 53 registros de ocho minutos, originalmente a 125 Hz, con PLETH y ECG de derivación II registrados simultáneamente.
- Los encabezados contienen **46 identificadores de persona fuente distintos**. Algunos registros comparten ese identificador. Se agrupan antes de dividir los datos para impedir que una misma persona aparezca en entrenamiento y evaluación.
- Entrenamiento: 30 identificadores, 31 registros, 29.357 ventanas.
- Validación para seleccionar el modelo: 8 identificadores, 11 registros, 10.417 ventanas.
- Prueba reservada: 8 identificadores, 11 registros, 10.417 ventanas.
- Semilla de la división: 20261114. Los identificadores exactos y la asignación de cada registro figuran en el artefacto.
- Se verificaron los 106 archivos de señal y encabezado contra `SHA256SUMS.txt` publicado por PhysioNet.

Las ventanas dentro de un mismo conjunto se superponen; no se deben tratar como observaciones clínicas independientes. La prueba contiene sólo ocho identidades fuente y no constituye una validación externa ni un estudio prospectivo.

## Preprocesamiento y arquitectura

Entrada: 60 muestras de PPG, equivalentes a dos segundos a 30 Hz. La señal se interpola linealmente sobre una rejilla temporal uniforme, se procesa mediante la convención de coeficientes del `BesselFilter` canónico a 0,5–12 Hz y se normaliza por la media y desviación estándar poblacional de la ventana. El filtro utiliza sus cuatro biquads causales y se descartan las primeras 150 muestras, equivalentes a cinco segundos, para limitar el transitorio inicial.

En el navegador, esa ruta consume `ProcessedSignal.rawValue`, previo al AGC y a la ganancia visual. No utiliza los valores ya escalados para el gráfico. Reutiliza la clase Bessel existente, con el mismo orden de filtrado que el entrenamiento.

La red seleccionada es `60 → 32 tanh → 15 lineal`, con **2.447 parámetros**. Se entrenó mediante Adam, lotes de 256, tasa 0,0007 y regularización L2 10, durante 80 épocas. La selección depende exclusivamente del menor error cuadrático de validación por personas separadas.

Se compararon ocho candidatos con la misma división: regresión Ridge con regularización 1, 10, 100 y 1.000; red de dos capas ocultas 128/64 con regularización 0,001 y 100; y red de una capa oculta de 32 con regularización 1 y 10. La comparación completa y los historiales se incluyen en el artefacto. La red más grande con regularización baja sobreajustó desde su primera época. La red pequeña regularizada dio el menor error de validación, pero tampoco generalizó con la fidelidad necesaria.

El ensayo inicial de la red grande produjo una correlación de prueba de 0,149 y una mejora de error del 0,71 %. Después se compararon los candidatos exclusivamente por validación; la prueba no se utilizó para escoger arquitectura, regularización ni época. Los resultados siguientes son del candidato final. Al haberse consultado la prueba en el ensayo inicial, esto se documenta como desarrollo exploratorio; una nueva evaluación externa debe mantenerse cerrada hasta fijar el método final.

Objetivo: las 15 muestras centrales del contexto ECG, índices 22 a 36 inclusive. El ECG se redujo de 125 a 30 Hz mediante `scipy.signal.resample_poly(6, 25)` y se normalizó por la media y desviación estándar de su contexto de dos segundos. La salida está en **unidades relativas**, sin escala de milivoltios. No se desplazaron picos ni se aplicó deformación temporal para mejorar la coincidencia. Su límite de Nyquist es 15 Hz y no preserva la banda de un ECG diagnóstico.

El modelo necesita el contexto completo: produce un segmento histórico, no una predicción eléctrica instantánea. La muestra central más antigua tiene aproximadamente 1,23 s de retraso respecto a la última muestra de entrada. La interfaz conserva los tiempos originales del segmento en vez de presentarlo como una medición del instante actual.

## Resultados medidos

| Conjunto | RMSE relativa | RMSE de referencia cero | Mejora de RMSE | Correlación de Pearson |
| --- | ---: | ---: | ---: | ---: |
| Entrenamiento | 0,9240 | 0,9880 | 6,48 % | 0,3628 |
| Validación | 0,9638 | 0,9961 | 3,25 % | 0,2576 |
| Prueba de personas reservadas | **0,9788** | **0,9919** | **1,32 %** | **0,1728** |

La referencia cero corresponde a predecir la media del ECG normalizado. La mejora de 1,32 % es pequeña y la correlación de 0,1728 es baja. Estos resultados no respaldan una visualización de ECG fiable ni la equivalencia con un electrocardiógrafo. El JSON conserva también los resultados completos por registro, incluidos aquellos que empeoran la referencia.

Las métricas son comparaciones punto a punto con el ECG pareado reducido a 30 Hz, expresado en unidades relativas. No se han medido sensibilidad de arritmias, precisión de intervalos eléctricos ni exactitud clínica.

## Transferencia a la cámara y uso en la app

BIDMC contiene PPG de pulsioxímetros hospitalarios, no de la cámara y el flash de un teléfono. El sensor, la respuesta óptica, el procesamiento y los artefactos difieren. Compartir una rejilla de muestreo y un preprocesamiento no elimina ese cambio de dominio. **No hay una evaluación pareada cámara/ECG de esta app.**

La inferencia integrada debe permanecer separada de los estimadores canónicos de frecuencia, intervalos de pulso, presión, SpO₂ y respiración. No alimenta diagnósticos, alertas clínicas o resúmenes médicos. Ante ausencia de contacto, señal inválida, discontinuidades o varianza nula de la entrada, no se proporciona una estimación.

Una siguiente etapa con posibilidad de mejorar requiere datos pareados de cámara y ECG, participantes distintos por conjunto, una arquitectura y un protocolo seleccionados mediante validación, y evaluación externa de morfología y tiempos. El entrenamiento de este cambio constituye una base reproducible para esa investigación; sus malos resultados no se ocultan ni se sustituyen por curvas prediseñadas.

## Reproducción e integridad

Desde la raíz del repositorio, con NumPy, SciPy y scikit-learn instalados:

```sh
OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 python training/train_ppg_to_ecg.py
```

El script descarga los datos en `work/ppg-ecg-data/`, verifica sus huellas, entrena, evalúa y exporta el artefacto. Los datos de pacientes no se añaden al código de la app. La ruta admite `--cache`, `--output` y `--epochs`; el valor por defecto es 80 épocas máximas con parada tras 12 épocas sin mejora y un mínimo de 25 épocas.

La ejecución usó Python 3.12.14, NumPy 2.3.5, SciPy 1.17.0 y scikit-learn 1.8.0. El JSON conserva las versiones exactas, el historial de entrenamiento, las métricas por registro y los hashes publicados de las fuentes. Incluye un vector real de entrada y salida esperada para comprobar paridad entre Python y TypeScript, además de un vector de paridad del filtro. La ficha ligera `src/lib/models/ppgToEcg.card.json` permite mostrar la procedencia, el retraso y la evaluación en la interfaz sin importar los pesos en el hilo de React.

SHA-256 del artefacto final exportado: `e8a66faa05265633ca4dd64d5563fc105b7969a4cb3209b4aff9fc292f228776`.

## Atribución

Dataset: [BIDMC PPG and Respiration Dataset, versión 1.0.0](https://physionet.org/content/bidmc/1.0.0/), DOI [10.13026/C2208R](https://doi.org/10.13026/C2208R). Licencia declarada por PhysioNet: [Open Data Commons Attribution License v1.0](https://physionet.org/content/bidmc/view-license/1.0.0/). Sus archivos son versiones modificadas de datos MIMIC-II; las modificaciones originales se describen en el archivo `LICENSE` de la distribución.

Pimentel, M. A. F. et al. “Towards a Robust Estimation of Respiratory Rate from Pulse Oximeters”. IEEE Transactions on Biomedical Engineering 64(8), 1914–1923. DOI [10.1109/TBME.2016.2613124](https://doi.org/10.1109/TBME.2016.2613124).
