# Monitor óptico: diseño visual e interacción

## Dirección implementada

El monitor pasa a ser el centro de la interfaz: grafito y azul de baja saturación, jade para pulso, cian para SpO₂, lavanda para presión y tonos claros para respiración. Las advertencias mantienen rojo/ámbar. La portada, los controles, los paneles de aviso/ajustes/resultados y las superficies comparten tipografía, espaciado y colores; el pulso medido sustituye la animación decorativa del corazón.

Los cuatro valores provienen de los procesadores existentes. La respiración se conecta al resultado canónico y sus estados; los valores ausentes siguen indicando ausencia de lectura. La presentación no convierte la estimación en una medición clínicamente validada.

La onda tiene menos halo y un mapeo lineal de amplitud relativa. Curvas cúbicas monótonas unen las muestras observadas: pasan por ellas y acotan cada segmento a sus extremos. No se añade suavizado a los estimadores ni se altera el tiempo de las observaciones. La misma curva se aplica a crestas y caras de la cinta 3D. La previsualización conserva la perspectiva del piso, con vídeo a opacidad 0.62 y velos tenues; las líneas se pintan por encima.

## Interacciones reales

- Zoom temporal de 1 a 8 segundos, por botones o pellizco; escalas de tiempo recalculadas en 2D y 3D.
- Tocar o pulsar Enter abre inspección en 2D. La copia conserva muestras, amplitud y evidencia visual aunque el flujo vivo cambie. La captura y los estimadores continúan.
- Arrastrar, usar flechas o los botones anterior/posterior desplaza la ventana dentro del registro disponible. El cursor muestra una muestra real en unidades relativas.
- Botón de retorno en vivo, Escape o Enter cierran inspección. No se permite explorar más allá de la copia disponible.
- Área ampliada, anotaciones visibles/ocultas y cambio 2D/3D. En pantallas bajas la distribución ya es compacta; en horizontal los cuatro signos pasan a la cabecera.
- Retroalimentación de contacto con la guía canónica y cobertura observada. Se conservan hápticos y eventos de latido existentes. Se añaden foco visible, valores accesibles fuera del canvas y alternativas a los gestos.

## Consulta web y decisiones

Fuentes oficiales consultadas el 13 de noviembre de 2026:

1. [MDN — Optimizing canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas). Mantener Canvas 2D con contexto opaco, limitar la densidad de píxeles y controlar el trabajo por frame evita añadir un motor 3D pesado. En dispositivos con puntero táctil y en nativo el render se limita a 30 fps; captura y procesamiento tienen su propio ritmo.
2. [MDN — Pinch zoom gestures](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events/Pinch_zoom_gestures). Pointer Events unifica ratón, lápiz y multitáctil. Se manejan captura, liberación y cancelación; el gesto sólo se toma en la zona de gráfico.
3. [MDN — OKLCH](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/color_value/oklch). Se utiliza como mejora progresiva para el acento CSS, con fallback hexadecimal. El canvas utiliza colores sRGB explícitos para compatibilidad.
4. [MDN — backdrop-filter](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/backdrop-filter). Transparencia y blur local de 6 px en controles pequeños, con fallback opaco/translúcido y comprobación de soporte.
5. [W3C — Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html) y [WCAG 2.2](https://www.w3.org/TR/WCAG22/). Se respeta movimiento reducido, se mantienen alternativas de teclado/botones se utilizan controles táctiles principales de 44 px y el zoom del navegador permanece habilitado fuera del gráfico. Esto no constituye una auditoría completa de conformidad WCAG.

## Verificación

Pruebas de límites de interpolación y recorrido inverso; inspección independiente del buffer, escala y evidencia en vivo; límites de zoom y de navegación histórica. Chromium ejercita el componente real: opacidad y orden del piso, zoom por botón y pellizco, congelación visual ante muestras nuevas, retorno, ampliación y distribuciones 390×844, 320×568, 844×390 y 1440×900. Las imágenes de comprobación utilizan entradas de software controladas, no capturas de pacientes.

Pendiente: evaluación de legibilidad, fluidez y uso con una mano en dispositivos físicos de varias gamas y Safari/iOS. La implementación utiliza React, Canvas, CSS y los iconos ya presentes.
