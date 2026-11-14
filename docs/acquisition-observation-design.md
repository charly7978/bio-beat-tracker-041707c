# Observaciones ópticas continuas para adquisición por contacto

## Problema y cambio

Una máscara puede cambiar con la fase del pulso. Promediar sólo los píxeles que en cada cuadro parecen perfundidos mezcla el pulso real con diferencias de brillo entre sitios que entran y salen. Además, la deriva lenta de exposición o textura podía contar como perfusión, y la normalización posterior amplificaba su pequeño residuo filtrado hasta producir picos.

La ruta canónica ahora separa tres hechos: fotometría de escena, soporte de tejido observado y evidencia cardíaca. No usa modelos por marca ni exige que el usuario centre un punto. Tampoco resta un modelo de movimiento que pudiera cancelar una modulación sanguínea espacialmente heterogénea.

`AdaptivePixelRoi` compara el mismo sitio del sensor en cuadros consecutivos y mantiene un DC lento propio para R/G/B. La onda relativa usa log((DC+1)/(I+1)) y la mediana entre regiones con soporte suficiente. La máscara fisiológica informa perfusión espacial, pero no selecciona ni repondera la onda según su fase. La fotometría RGB de escena se conserva aparte. Recorte, subexposición, reentrada y pérdida de soporte invalidan el historial correspondiente; azul no observado no invalida R/G.

`PPGSignalProcessor` mezcla R/G con pesos fijos y aplica su filtro lineal. `filteredValue` alimenta estimación; el AGC sólo vive en `displayValue`. La amplitud cardíaca relativa se estima como sqrt(2·varianza)/ganancia sobre hasta 2.5 s de muestras con timestamps, tras al menos 1 s de soporte. Es una aproximación técnica de AC/DC en pequeña señal, no un índice de perfusión clínicamente calibrado. Se mantiene el umbral canónico `QUALITY.MIN_PI`; el CV crudo y la deriva fuera de banda ya no pueden superarlo por otra vía. La validez explícita impide enviar ceros de rechazo como muestras observadas al detector, pero conserva los cruces reales por cero.

La época óptica llega al router junto con la muestra. Pausas mayores de 250 ms, cambios de soporte o cámara y saltos fotométricos reinician la evidencia temporal; ningún RR se calcula entre épocas. El mínimo del ensemble pasa de 48 muestras fijas a la duración equivalente de 1.6 s (con piso de 12 muestras): 24/39/48/96 muestras a 15/24/30/60 Hz. El detector sabe que la entrada en vivo ya está filtrada; repetir el filtro offline sobre cada ventana creciente desplazaba los primeros máximos y acortaba RR después de una pausa. La ruta independiente con entrada cruda conserva su acondicionamiento.

## Cámara

AE/AWB siguen continuos durante colocación. No se imponen ISO/EV arbitrarios tras encender el flash. En `STABLE_CONTACT` se capturan los valores convergidos antes de cambiar a manual; modo y valor se aplican por separado y se verifican en settings. Cuando un valor no se confirma se intenta restaurar continuo. Al retirar el dedo, `resumeFingerAcquisition` cancela el lease del lock, espera cualquier constraint pendiente y restaura AE/AWB. Un lente descubierto sostenidamente renueva el presupuesto de recuperación incluso si nunca se confirmó pulso.

Una cola conserva el orden de las operaciones ya enviadas al driver; las generaciones impiden continuar trabajo viejo sobre el siguiente contacto o stream. La revisión ISP sólo cambia cuando se solicita un control real, y los cuadros indican si hay una transacción pendiente. La apertura con constraints relajados comparte la inicialización de torch; conserva las cuatro sintaxis y el fallback con settings stale de Safari. Un stream tardío de una apertura cancelada se detiene sin reemplazar al actual.

## Evidencia reproducible

Verificación completa local: `npm run check:all`, 67 archivos de pruebas y 649 pruebas aprobadas; lint, TypeScript, higiene, arquitectura, guardas de no simulación, build y guarda del bundle aprobados. Para el build local se usaron `VITE_SUPABASE_URL=http://127.0.0.1:54321` y `VITE_SUPABASE_PUBLISHABLE_KEY=local-test-key`; no se verificó un servicio Supabase externo.

`acquisitionEnvelope.test.ts` contiene 42 casos que recorren RGB → ROI → filtros → salida real del procesador → detector, sin sustituir la onda entre etapas. Cubre tejido con textura, traslación suave, deriva/escalón de iluminación, selección espacial, límite de clipping, pausas, pulso de amplitud 10 veces menor y controles sin pulso. Usa los gates de contacto, estado, movimiento y continuidad del router real.

| Medición determinista | Resultado actual |
|---|---:|
| Primera publicación de BPM, tejido a 15/24/30/60 fps | 3.43–3.47 s |
| Fracción de publicación correcta después de pérdidas de cuadros, ventana 18–26 s | 94.2–94.8% |
| Energía filtrada explicada por la fundamental real, casos de pulso normal | 92.7–94.9% |
| Misma energía, pulso 10 veces menor con traslación | 90.0–90.7% |
| Publicación en ventana asentada, seis casos de pulso débil | 100% |
| Picos emitidos: textura estática / textura trasladada sin pulso / flicker neutro / rojo recortado | 0 / 0 / 0 / 0 |

En una reproducción del snapshot anterior con el mismo enrutamiento y fixtures, los cuatro controles emitían 3/27/30/0 picos. El caso de pulso débil trasladado a 60 fps mejoró su energía fundamental de 75.7% a 90.7%. No todos los casos mejoran cada métrica: a 15 fps el caso próximo al clipping pasa de 94.0% a 92.7%, y la publicación tras pausas a 24/30/60 fps sacrifica algunas muestras iniciales para no aceptar evidencia rechazada. Son intercambios observados, no una promesa de superioridad universal.

Los 32 casos de pulso normal conservan el criterio de error RR de hasta un cuadro. Los seis casos débiles, próximos a la cuantización entera de imagen y con ruido de lectura, exigen además >80% de publicación, error mediano y percentil 95 ≤5 BPM, >80% de energía fundamental y >85% de muestras útiles; no se les atribuye precisión temporal subruido.

Reproducción portable:

```sh
ACQUISITION_ENVELOPE_REPORT=/tmp/acquisition-envelope.json \
  npx vitest run src/modules/signal-processing/__tests__/acquisitionEnvelope.test.ts
npm run check:all
```

Las pruebas de cámara cubren modos/valores ignorados, lectura antes del modo manual, cola EV→lock→retirada→reentrada, tracks detenidas/reemplazadas, fallback de resolución, torch y apertura tardía cancelada. Las pruebas de ROI cubren soporte común, ausencia de mezcla entre canales, píxeles recortados/reentrados y R/G válido con azul oscuro o recortado.

## Límites y validación pendiente

Los fixtures son evidencia de software, no capturas fisiológicas ni validación clínica. Una cámara RGB no distingue toda modulación de iluminación, presión y movimiento de un pulso; movimiento dentro de la banda cardíaca puede superar el umbral de amplitud. Este cambio no declara eliminación universal de artefactos. Señales por debajo del umbral existente quedan insuficientes; no se inventa pulso para acelerar adquisición.

Falta probar Android de varias gamas, iOS/Safari y navegadores con capacidades parciales: tiempo hasta señal útil, pérdidas/recontacto, temperatura/torch, piel, presión, exposición y RR frente a una referencia externa. AE/AWB manual, valores expuestos y confirmación de torch dependen del navegador/driver; el tono adaptativo del ISP no es controlable mediante esta API. La ley logarítmica opera sobre bytes ya procesados, no intensidad lineal calibrada. No hay una nueva afirmación de exactitud para SpO₂, presión arterial o glucosa.
