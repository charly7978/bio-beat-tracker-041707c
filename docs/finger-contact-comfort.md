# Contacto cómodo: priorizar señal útil sobre centrado geométrico

## Problema y comportamiento resultante

La guía exigía un error visual menor al 4% del recorte aun cuando el pipeline ya
consideraba buena la colocación. Durante la estabilización volvía a pedir hacer
coincidir dos huellas. El usuario podía mover una yema que ya daba señal y perder
la ventana que estaba reuniendo.

Ahora el contacto con cobertura, pulsatilidad, quietud y captura suficientes puede
estar fuera del centro geométrico. El clasificador conserva las coordenadas y el
veredicto geométrico para diagnóstico; no los convierte en una orden de mover el
dedo si la evidencia óptica ya sirve. El estado READY sigue necesitando presión
IDEAL y adquisición READY. No se reducen los umbrales de señal ni se acepta una
imagen saturada o movimiento dominante como medición.

La ventana muestra una sola tarea principal:

- Contacto suficiente y adquisición lista: **SEÑAL ESTABLE**, sin fantasma ni flechas.
- Adquisición en curso: **MANTÉN UN APOYO CÓMODO**, sin exigir alineación adicional.
- Movimiento que impide leer: **APOYA LA MANO · RECUPERANDO SEÑAL**.
- Cobertura insuficiente: **CUBRE MÁS SIN APRETAR**.
- Presión excesiva: **SUELTA UN POCO**, sin añadir una orden secundaria de centrado.

También se corrige la recogida de morfología: una muestra finita de valor cero es
un punto válido de la onda. Ya no borra las ventanas de PA y respiración por el
mero hecho de cruzar cero. Los rechazos por movimiento, falta de contacto,
timestamp inválido y calidad insuficiente se conservan.

La pantalla inicial propone apoyar teléfono y mano para reducir el esfuerzo de
sostenerlos. La selección de lente, el flash, el bloqueo diferido de exposición y
los modelos de presión no cambian.

## Verificación realizada

`npm run check:all` pasó: lint, TypeScript, importaciones, arquitectura,
anti-simulación, 60 suites / 545 pruebas, build y control de dist. Se usaron valores
locales de prueba para inicializar Supabase; no credenciales reales.

Las regresiones cubren contacto útil lateral, pequeñas variaciones del centroide,
pulso insuficiente, presión excesiva, captura degradada, recuperación de movimiento
y cruces por cero. Las funciones de señal y guía se probaron también en Chromium,
con dibujo real sobre canvas y sin errores JavaScript. Esa comprobación utilizó
entradas deterministas de software; no una captura de un dedo real.

El recorrido comprobado es evidencia del procesador → veredicto canónico → guía →
canvas. No requiere una API remota para decidir la colocación.

## Comprobación pendiente en teléfonos

Comparar tiempo hasta primera lectura, número de recolocaciones pedidas y tiempo
de recuperación después de un pequeño cambio natural de posición. Incluir
dispositivos con distintas distribuciones de cámara/flash y dedos diferentes.
Registrar calidad y cobertura además de comodidad: una mejora de la guía no
demuestra por sí sola que haya mejorado la precisión de los signos vitales.
