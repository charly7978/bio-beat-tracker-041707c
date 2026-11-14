# Monitor inmersivo y visualización híbrida

Actualizado el 14 de noviembre de 2026.

## Experiencia implementada

El instrumento ocupa la pantalla completa. En escritorio las cuatro métricas se agrupan en una columna derecha; el área de señal recibe el espacio central. En móvil las métricas forman una banda compacta y se eliminan los paneles inferiores que reducían el gráfico. La ampliación aumenta también el área disponible en el teléfono. En horizontal la guía de captura dispone de una columna propia para conservar su legibilidad junto a los canales.

La presentación combina superficies azul profundo, iluminación fija discreta, acentos jade/cian, controles translúcidos y cinta óptica en perspectiva. La nueva instalación abre en 3D; se conserva la elección guardada de usuarios existentes. Los eventos de latido proceden de los detectores existentes. No se añadieron latidos decorativos ni ondas prediseñadas.

El canvas adapta su densidad hasta 3 píxeles físicos por píxel CSS, con presupuesto aproximado de ocho millones de píxeles. La captura conserva su resolución de procesamiento y su reloj: aumentar la resolución del gráfico no se presenta como una mejora de la exactitud del sensor. La cadencia de presentación y el procesamiento en Worker permanecen separados.

## Canales reales y salida aprendida

La vista HÍBRIDO ofrece dos bandas secundarias alternables:

- **VPG/APG**, opción inicial: primera y segunda derivadas temporales de la PPG lineal filtrada, anteriores al AGC y a la ganancia visual. Diferencias divididas de tres observaciones respetan los tiempos irregulares; los huecos, muestras inválidas y retrocesos de reloj cortan los segmentos. Las unidades son relativas por segundo y por segundo cuadrado, sin atribuir velocidades sanguíneas ni actividad eléctrica a esas curvas.
- **ECG IA**, selección explícita: salida de un modelo realmente entrenado con PPG y ECG pareados de BIDMC. Su banda indica **concordancia baja**, carácter experimental, unidades relativas y retardo. Un botón de información abre las métricas y la procedencia del modelo.

El modelo final es una red `60 → 32 tanh → 15 lineal`. Se compararon ocho candidatos mediante pacientes de validación separados. La prueba final en ocho identidades fuente dio Pearson 0,173 y RMSE 0,979; la mejora de RMSE frente a predecir la media fue 1,32 %. Es insuficiente para interpretar el ECG individual. El entrenamiento hospitalario no valida su transferencia a la cámara. Informe, metodología, hashes y límites: [modelo PPG→ECG](ppg-to-ecg-model.md).

La inferencia reside en el Worker canónico y utiliza una ruta cuyo filtro y red se comprueban contra Python. No alimenta frecuencia cardíaca, intervalos de pulso, arritmias, presión, SpO₂, respiración ni resúmenes médicos. Los valores eléctricos PR/QRS/QT no se calculan.

La amplitud de la salida aprendida se representa tal como la produce la regresión. No se ajusta su posición temporal para aparentar una coincidencia mayor. Las últimas predicciones corresponden a un segmento histórico; el retardo mínimo de su muestra más reciente es aproximadamente 0,77 s y el del inicio de cada lote aproximadamente 1,23 s. Se necesitan aproximadamente siete segundos de contacto estable para disponer del primer segmento.

## Previsualización operativa

La ventana permanece dentro del monitor en 2D y 3D. Su vídeo se dibuja completo, sin recorte, con una sola operación por frame. La superposición ROI corresponde a la región publicada por el procesador y a las dimensiones reales del frame de análisis; no es una diana fija.

La guía prioriza el mensaje del modelo canónico de colocación. Expone cobertura, quietud, pulsación y fracción de imagen sin recorte/subexposición, además de FPS efectivos. Los indicadores no equivalen a fuerza de contacto ni a diagnósticos. La falta de imagen o evidencia se representa con ausencia de datos. Al detener captura se retiran el vídeo y los indicadores anteriores.

Las instrucciones mantienen al menos 11 px en la ventana compacta. La onda y la grilla no se dibujan por encima del texto. Se retiraron el barrido decorativo, la apertura por calidad y la deformación del vídeo en decenas de franjas: consumían recursos y dificultaban interpretar la captura.

## Interacciones y accesibilidad

Se conservan zoom temporal, pellizco, inspección por copia congelada, navegación por flechas y retorno en vivo. La copia incluye la fuente lineal necesaria para derivadas y una copia independiente de la salida del modelo y sus metadatos. La captura continúa durante la inspección.

Los botones tienen nombres accesibles y foco visible; existe alternativa de teclado a los gestos. La guía conserva un anuncio accesible fuera del canvas. El informe del modelo utiliza un diálogo nativo con cierre mediante Escape y recuperación de foco. Se respeta movimiento reducido. En alturas que no permiten una banda secundaria legible, la interfaz indica PPG y desactiva el cambio a HÍBRIDO con una explicación.

## Fuentes consultadas

- [AHA — Electrocardiogram](https://www.heart.org/en/health-topics/heart-attack/diagnosing-a-heart-attack/electrocardiogram): diferencia entre actividad eléctrica y señal óptica.
- [AHA — Echocardiogram](https://www.heart.org/en/health-topics/heart-attack/diagnosing-a-heart-attack/echocardiogram): una imagen cardíaca diagnóstica requiere una modalidad que mida anatomía y función; la perspectiva de este monitor es una visualización de datos.
- [Suboh et al., 2022](https://www.frontiersin.org/journals/public-health/articles/10.3389/fpubh.2022.920946/full): derivadas VPG/APG de PPG filtrada.
- [Slapničar et al., 2024](https://www.mdpi.com/1424-8220/24/7/2100) y [Tang et al., 2023](https://www.mdpi.com/2306-5354/10/6/630): reconstrucción aprendida PPG→ECG y dificultades de tiempo/generalización.
- [PhysioNet — BIDMC 1.0.0](https://physionet.org/content/bidmc/1.0.0/): datos pareados utilizados en el entrenamiento realizado para este cambio.
- [MDN — Optimizing canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas): densidad y coste de renderizado.

## Verificación y límites pendientes

Se ejecuta `npm run check:all`: lint, tipos, higiene de imports, arquitectura, guardas contra datos inventados, pruebas, compilación y comprobación del bundle. Las pruebas incluyen derivadas con tiempos irregulares, ausencia de señal, continuidad, layouts, ROI, lectura de métricas, inferencia con pesos reales y paridad numérica Python/TypeScript.

La automatización visual del navegador no pudo iniciarse: el entorno devuelve `the gaas-browser node_repl sandbox cannot be disabled`. No se presentan capturas ni una prueba física como realizadas. Falta evaluar legibilidad y fluidez en dispositivos reales, Safari/iOS y una captura pareada cámara/ECG. Los tests de software no acreditan exactitud clínica.
