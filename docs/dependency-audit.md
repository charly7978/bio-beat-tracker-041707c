# Dependencias y guardrails de simulación

Este documento describe los límites de los controles; `package.json` y los lockfiles son la fuente de verdad del inventario de dependencias.

## Controles ejecutables

- `npm run check:no-sim` analiza archivos de producción bajo `src/` y excluye tests. Busca `Math.random` y términos asociados a datos simulados; las excepciones están en `scripts/anti-sim-allowlist.json`.
- `npm run check:no-sim:dist` analiza JavaScript emitido en `dist/` después del build.
- Estos escaneos son guardrails estáticos: no prueban el comportamiento de dependencias transitivas ni la validez de una medición.
- `training/` queda fuera del guardrail de runtime y contiene generadores de datos sintéticos para entrenamiento experimental.

## Límite importante del modelo de presión arterial

`src/lib/vitals/mlpWeights.ts` se consume en runtime por `pwaPhysiologicalBpEngine.ts`. El script que genera esos pesos, `training/train_bp_mlp.py`, crea entradas y objetivos mediante rangos y fórmulas sintéticas; no usa un conjunto de mediciones clínicas de referencia. Los límites fisiológicos y las pruebas de plausibilidad solo comprueban forma/rango, no exactitud. En consecuencia, este repositorio no aporta evidencia de validación clínica del estimador BP y no debe presentarse como una lectura clínica validada.

## Procedimiento para actualizar dependencias

1. Actualizar `package.json` y el lockfile correspondiente con el gestor usado.
2. Verificar que la dependencia se importa o justificar explícitamente su uso indirecto.
3. Ejecutar `npm run check:all`.
4. Revisar cambios de bundle y mantener este documento limitado a hallazgos que hayan sido verificados.
5. Para plataformas acopladas (por ejemplo, Capacitor Android/Core), comprobar que las versiones resueltas satisfacen los `peerDependencies` y verificar el árbol con `npm ls`.
