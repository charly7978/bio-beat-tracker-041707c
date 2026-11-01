# Sustitución de pesos del MLP de PA — regla y procedimiento

**Ámbito:** `src/lib/vitals/mlpWeights.ts` (pesos del regresor neuronal de presión arterial).
**Regla del proyecto:** los coeficientes de un modelo **solo se sustituyen cuando existen
resultados verificables** (docs/medical-validation.md §4).

## 1. Estado actual: la sustitución está bloqueada

| Elemento | Valor |
|---|---|
| `weightsId` | `bp-mlp-formula-v1` |
| Huella | `fnv1a64:ed365c6fd3f42d17` |
| Origen del dataset | `formula_generated` (fórmulas fisiológicas sobre features generados) |
| Sujetos reales | 0 |
| Estado de validación | `unvalidated` |
| Informe de validación | **no existe** |
| Métricas publicadas | **ninguna** |

Conclusión: **los pesos actuales no se sustituyen**. No hay informe que los respalde y
no existe ningún dato de pacientes con el que producirlo. Cualquier cambio de pesos en
este estado es, por definición, una sustitución sin evidencia.

## 2. Qué cuenta como «resultado verificable»

Un informe de validación solo habilita la promoción si demuestra, contra referencia
clínica real:

| Criterio | Umbral | Base |
|---|---|---|
| Sesgo medio (estimado − referencia) | \|sesgo\| ≤ **5 mmHg** | ISO 81060-2:2018 / ANSI-AAMI ES1 |
| Desviación estándar de las diferencias | DE ≤ **8 mmHg** | ISO 81060-2:2018 / ANSI-AAMI ES1 |
| Sujetos distintos | ≥ **30** | docs/medical-validation.md §4.1 |
| Pares válidos por sujeto | ≥ **3** | ISO 81060-2:2018 |
| Dataset | `clinical_reference` | Solo pares reales con referencia certificada |
| Dispositivo de referencia | certificado | Requisito del protocolo |
| Fecha del informe | ≥ fecha de generación de los pesos | Evita validar unos pesos y publicar otros |
| Huella del informe | = huella de los pesos candidatos | Evita promocionar pesos no evaluados |

Los criterios viven en `BP_PROMOTION_CRITERIA` (`src/lib/vitals/mlpWeightsProvenance.ts`)
y se replican en `training/train_bp_mlp.py`. No son constantes fisiológicas: son umbrales
de aceptación normativos.

## 3. Cuatro capas de bloqueo

1. **Script de entrenamiento** (`training/train_bp_mlp.py`): sin
   `--promote --validation-report <json>` válido, escribe el resultado en
   `training/artifacts/mlpWeights.candidate.ts` y **no toca** el fichero de producción.
   Con `--promote` y un informe que no cumple, sale con código 1 sin escribir nada.
2. **Declaración de procedencia** (`MLP_WEIGHTS_PROVENANCE`): contiene la huella de los
   pesos en producción. Unos pesos nuevos sin declaración actualizada quedan sin verificar.
3. **Integridad en runtime** (`getMlpWeightsIntegrity()`): el motor
   (`pwaPhysiologicalBpEngine.ts`) calcula la huella una vez al cargar; si no coincide con
   la declarada, el peso de fusión del MLP es **0** y la estimación depende solo del modelo
   físico Windkessel-PDA. La app sigue funcionando y los pesos no verificados no influyen.
4. **CI** (`src/lib/vitals/__tests__/mlpWeightsProvenance.test.ts`): falla si la huella de
   los pesos no coincide con la declarada, si la forma no cuadra con la arquitectura, o si
   el gate de promoción acepta o rechaza algo distinto de lo esperado.

## 4. Huella de pesos

Algoritmo (idéntico en TS y Python, ver `mlpWeightsFingerprint.ts`):

1. Serialización canónica: capas `fc1, fc2, fc3`; por cada fila `w[i]` y luego el `bias`,
   con cada valor como float64 big-endian en hexadecimal (`struct.pack('>d', v).hex()`),
   separado por comas y líneas `\n`.
2. FNV-1a de 64 bits sobre los bytes UTF-8 de ese texto.
3. Formato `fnv1a64:<16 hex>`.

Comprobación cruzada TS ↔ Python sobre los pesos en producción:

```bash
python training/check_weights_fingerprint.py
```

Sin argumentos compara `mlpWeights.ts` con la huella declarada en la procedencia y sale
con código 1 si no coinciden.

## 5. Procedimiento para promocionar (cuando existan datos reales)

1. Registrar el dataset de validación (pares estimación/referencia, SQI, dispositivo) —
   la infraestructura ya existe en `src/modules/vital-signs/ValidationDataset.ts`.
2. Calcular sesgo, DE, MAE y límites de Bland–Altman por brazo.
3. Escribir el informe en `training/validation-reports/<id>.json` con el esquema de §6.
4. Entrenar: `python training/train_bp_mlp.py` → anotar la huella impresa.
5. Completar `weightsFingerprint` del informe con esa huella y la fecha.
6. Promocionar: `python training/train_bp_mlp.py --promote --validation-report training/validation-reports/<id>.json`
7. Declarar en `MLP_WEIGHTS_PROVENANCE`: `fingerprint`, `validationStatus: 'validated'`,
   `validationReportPath`, `publishedMetrics` y `subjectCount`.
8. Actualizar `docs/medical-validation.md` con las métricas y la fecha.
9. `npm run check:all` debe quedar en verde.

Si el paso 6 imprime bloqueos, **no hay promoción**: se corrigen los datos, no los umbrales.

## 6. Esquema del informe (`BpValidationReport`)

```json
{
  "weightsFingerprint": "fnv1a64:<16 hex de los pesos evaluados>",
  "weightsGeneratedAt": "2026-05-01T00:00:00.000Z",
  "evaluatedAt": "2026-06-15T00:00:00.000Z",
  "protocol": "ISO 81060-2:2018",
  "evaluator": "<responsable de la evaluación>",
  "dataset": {
    "kind": "clinical_reference",
    "subjectCount": 45,
    "referenceDevice": "<dispositivo de referencia certificado>",
    "referenceDeviceCertified": true,
    "collectedAt": "2026-04-10T00:00:00.000Z",
    "datasetId": "<id del dataset registrado>"
  },
  "arms": {
    "systolic":  { "sampleCount": 135, "bias": 1.2, "sd": 6.1, "mae": 4.8, "loaLower": -10.76, "loaUpper": 13.16 },
    "diastolic": { "sampleCount": 135, "bias": 0.8, "sd": 5.4, "mae": 3.9, "loaLower": -9.78,  "loaUpper": 11.38 }
  }
}
```

Los límites de concordancia deben ser coherentes con `bias ± 1.96·sd` (tolerancia 0,5 mmHg);
un informe con cifras inventadas o mal calculadas se rechaza.

**No existe ningún informe en el repositorio.** `training/validation-reports/` está vacío a
propósito: mientras siga vacío, la respuesta a «¿sustituimos los pesos?» es **no**.
