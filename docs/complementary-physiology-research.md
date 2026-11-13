# Bio Beat — Investigación integral y prácticas complementarias

Fecha de revisión: 13 de noviembre de 2026. Alcance: hipótesis para adquisición y modelado fisiológico; no recomendaciones de tratamiento ni resultados de validación de Bio Beat.

## Criterio de creación

La investigación puede incorporar fisiología clínica, deporte, respiración, meditación y prácticas tradicionales. Cada idea se traduce en una pregunta medible: qué señal cambia, por qué mecanismo propuesto, frente a qué referencia y qué explicación alternativa podría producir el mismo cambio. La etiqueta de una práctica no establece su eficacia ni la descarta.

Conviene separar tres niveles:

- **Evidencia observada:** resultado de un estudio en una población y condiciones concretas.
- **Hipótesis de ingeniería:** aplicación posible al teléfono que todavía debe probarse.
- **Afirmación no sustentada para Bio Beat:** dar por medido un mecanismo o una variable que sus sensores no identifican.

## Seis estudios primarios y su aplicación

| Estudio verificado | Evidencia relevante y límite | Decisión para Bio Beat |
| --- | --- | --- |
| **Hirsch y Bishop, 1981**, experimento con 17 participantes | Cuantificó dependencia de la arritmia sinusal respiratoria respecto de frecuencia respiratoria y volumen corriente. El resumen permite verificar el mecanismo; no evaluó teléfonos. | Interpretar variabilidad de pulso junto a la respiración observada. Un cambio de PRV durante respiración distinta no implica por sí solo un cambio en salud autonómica. |
| **Balban y colaboradores, 2023**, ensayo remoto aleatorizado | Comparó prácticas respiratorias con mindfulness durante un mes; informó diferencias en afecto positivo y frecuencia respiratoria. Evaluó autorreportes y wearable; no presión/SpO₂ por cámara. | Registrar práctica declarada, respiración y contexto separadamente. Los cambios de ánimo se obtienen por autorreporte, no se deducen del pulso. |
| **Buchheit y colaboradores, 2009**, comparación de recuperación en 11 hombres entrenados | La postura modificó la recuperación de pulso y variabilidad después de ejercicio; los efectos dependieron del esfuerzo previo. Población pequeña y específica. | Conservar postura declarada y tiempo desde actividad. La orientación IMU describe el teléfono, no identifica automáticamente la postura corporal. |
| **Hagins y colaboradores, 2014**, yoga frente a control activo | 84 inscritos, 68 completaron. Hubo cambios dentro del grupo de yoga, pero solo una variable de PA mostró diferencia significativa entre grupos. El estudio careció de potencia suficiente para varias comparaciones. | Un cambio antes/después no basta para atribuir beneficio a yoga. Evaluar con referencia de PA y control que contemple descanso, ejercicio y expectativas. |
| **Hewett y colaboradores, 2017**, Bikram frente a control | El análisis por intención de tratar no encontró diferencias significativas entre grupos en el resultado principal de HRV ni en los secundarios. Las asociaciones posteriores con asistencia no equivalen a efecto causal aleatorizado. | Conservar resultados nulos y adherencia. El modelo no debe asumir de antemano que una práctica aumenta HRV o reduce PA. |
| **Thrower y colaboradores, 2023**, ensayo cruzado de vinyasa | En una muestra pequeña, los cambios agudos fueron diferentes para PA, pulso y HRV: una dirección favorable para una variable coexistió con respuestas distintas en otras. | Evitar un puntaje de “mejora integral” que obligue a todas las variables a moverse juntas. Una sesión puede mezclar ejercicio, respiración, recuperación y descanso. |

Fuentes primarias:

1. [Hirsch & Bishop: Respiratory sinus arrhythmia in humans: how breathing pattern modulates heart rate](https://pubmed.ncbi.nlm.nih.gov/7315987/). DOI: 10.1152/ajpheart.1981.241.4.H620. Resumen verificado mediante el índice PubMed y la ficha del editor.
2. [Balban et al.: Brief structured respiration practices enhance mood and reduce physiological arousal](https://pubmed.ncbi.nlm.nih.gov/36630953/). DOI: 10.1016/j.xcrm.2022.100895. Resumen y descripción de medidas verificados.
3. [Buchheit et al.: Effect of body posture on postexercise parasympathetic reactivation in men](https://pubmed.ncbi.nlm.nih.gov/19395660/). DOI: 10.1113/expphysiol.2009.048041. Resumen verificado.
4. [Hagins et al.: Yoga frente a control activo y presión ambulatoria](https://pmc.ncbi.nlm.nih.gov/articles/PMC3948002/). DOI: 10.1111/jch.12244. Texto completo consultado.
5. [Hewett et al.: Ensayo de Bikram yoga y HRV](https://pmc.ncbi.nlm.nih.gov/articles/PMC5399826/). DOI: 10.1186/s12906-017-1740-1. Texto completo consultado.
6. [Thrower et al.: Vinyasa yoga y respuestas cardiovasculares agudas](https://pmc.ncbi.nlm.nih.gov/articles/PMC10684087/). DOI: 10.1371/journal.pone.0294945. Texto completo consultado.

Estos estudios sustentan preguntas concretas; no son una revisión exhaustiva ni establecen rendimiento de Bio Beat.

## Variables observables, contexto y estados latentes

| Categoría | Ejemplos | Tratamiento |
| --- | --- | --- |
| Observación de sensor | RGB con timestamp, movimiento del teléfono, eventos de pulso detectados | Conservar fuente, ventana y calidad. |
| Resultado derivado | PRV, FR estimada, cambios morfológicos | Conservar método y error frente a referencia. PRV no se renombra como HRV medida por ECG. |
| Contexto declarado | Meditación/yoga, postura corporal, esfuerzo reciente, estrés percibido, medicación | Guardar como autorreporte fechado; permitir “desconocido”. |
| Estado latente | Regulación autonómica, resistencia vascular, mecanismo específico de estrés | Evaluar si es identificable con datos suficientes; no presentarlo como medido por asociación. |

La misma variación óptica puede depender de movimiento, temperatura/perfusión periférica, exposición, contacto o fisiología. Una práctica complementaria puede modificar varios factores simultáneamente. El aprendizaje debe distinguir el cambio de la persona del cambio de adquisición.

“Estrés” requiere una definición operacional. Estrés percibido, activación cardiovascular y exposición a una tarea son etiquetas distintas; el pulso no es un detector específico de una de ellas.

## Hipótesis concretas para investigar

1. **Respiración y variabilidad:** comprobar si incluir FR y calidad respiratoria mejora la interpretación de cambios personales de PRV, frente al mismo modelo sin esa información. Analizar respiración observada y procedencia del dato; no asumir volumen corriente a partir de FR.
2. **Contexto de recuperación:** comprobar si conocer actividad previa, tiempo transcurrido y postura declarada mejora error y cobertura de los estimadores. Usar situaciones habituales o conjuntos de datos autorizados, sin prescribir esfuerzos a pacientes.
3. **Prácticas complementarias como contexto:** comparar mediciones ya disponibles en sesiones declaradas de meditación/yoga y descanso, con referencias independientes. Pregunta inicial: cambia la calidad del sensor o el error de estimación según contexto, no “demuestra la app que la práctica funciona”.
4. **Descomposición multimodal:** evaluar si añadir respiración, movimiento y características de pulso aporta información adicional después de controlar calidad. Mantener fuentes correlacionadas en un mismo grupo de dependencia.
5. **Modelo personal de respuesta:** estudiar tendencias por persona en sesiones posteriores, separado de entrenamiento y calibración. Una asociación temporal no se convierte en causalidad ni en diagnóstico.

Para evaluar efectos de una práctica haría falta un estudio específico, distinto de validar el medidor. Primero demostrar concordancia del sistema con referencias y después estudiar una intervención con control apropiado. No entrenar etiquetas de PA/SpO₂ a partir de lo que se espera que haga yoga, respiración o meditación.

## Integración gradual

La primera corrección conserva los timestamps de las observaciones RGB ya consumidas y la adquisición temporal IMU. La captura RGB completa por lotes sigue siendo una ampliación posterior del blueprint. La siguiente ampliación útil es un contrato de contexto de sesión, optativo y con procedencia, que mantenga independientes autorreportes, sensores y referencias. Las prácticas o mecanismos no evaluados permanecen como hipótesis de investigación, sin modificar numéricamente signos vitales por su nombre.

