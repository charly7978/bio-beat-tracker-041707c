# Informes de validación de pesos de PA

Directorio de informes que autorizan (o no) la sustitución de los pesos de
`src/lib/vitals/mlpWeights.ts`.

**Estado: vacío.** No existe ningún informe de validación en el repositorio, por lo que
los pesos en producción siguen sin poder sustituirse (ver
`docs/mlp-weights-promotion.md`).

Cada informe es un JSON con el esquema `BpValidationReport`
(`src/lib/vitals/mlpWeightsProvenance.ts`):

```json
{
  "weightsFingerprint": "fnv1a64:<huella de los pesos evaluados>",
  "weightsGeneratedAt": "<ISO 8601>",
  "evaluatedAt": "<ISO 8601>",
  "protocol": "ISO 81060-2:2018",
  "evaluator": "<responsable>",
  "dataset": {
    "kind": "clinical_reference",
    "subjectCount": 30,
    "referenceDevice": "<dispositivo certificado>",
    "referenceDeviceCertified": true,
    "collectedAt": "<ISO 8601>",
    "datasetId": "<id del dataset registrado>"
  },
  "arms": {
    "systolic":  { "sampleCount": 90, "bias": 0, "sd": 0, "mae": 0, "loaLower": 0, "loaUpper": 0 },
    "diastolic": { "sampleCount": 90, "bias": 0, "sd": 0, "mae": 0, "loaLower": 0, "loaUpper": 0 }
  }
}
```

Los ceros del ejemplo son marcadores, no resultados: un informe con `sampleCount`/`bias`/`sd`
incoherentes o con `loaLower`/`loaUpper` que no cumplan `bias ± 1.96·sd` se rechaza en el gate.

Verificación del gate:

```bash
python training/train_bp_mlp.py --promote --validation-report training/validation-reports/<id>.json
```

Sin un informe conforme, el script no escribe en `src/lib/vitals/mlpWeights.ts` y sale con
código 1.
