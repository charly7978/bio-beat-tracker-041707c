# Scripts de entrenamiento PPG/APG

Estos scripts son experimentales. Algunos generan señales y etiquetas sintéticas; sus resultados no constituyen validación clínica ni deben describirse como modelos clínicamente validados.

## Requisitos

```bash
pip install -r requirements.txt
```

## Scripts y salidas

| Script | Datos/salida |
|---|---|
| `generate_synthetic_ppg.py` | Generador de señales PPG sintéticas usado por los entrenamientos experimentales. |
| `train_bp_mlp.py` | Entrena con entradas y etiquetas generadas por fórmulas sintéticas y escribe `src/lib/vitals/mlpWeights.ts`, que sí se importa en runtime. |
| `train_peak_scorer.py` | Entrenamiento experimental; exporta `public/models/peak_scorer_v1.onnx`. |
| `train_sqi_refiner.py` | Entrenamiento experimental; exporta `public/models/sqi_refiner_v1.onnx`. |
| `train_denoiser.py` | Entrenamiento experimental; exporta `public/models/denoiser_v1.onnx`. |

Ejecutá desde este directorio, por ejemplo:

```bash
python train_bp_mlp.py
python train_peak_scorer.py
python train_sqi_refiner.py
python train_denoiser.py
```

Los exportadores ONNX no tienen integración de carga en runtime en el código fuente actual. El único modelo de esta carpeta conectado al pipeline es el MLP BP; sus pruebas verifican plausibilidad/rangos, no exactitud contra un tensiómetro de referencia. Consultá `docs/dependency-audit.md` y `docs/ARCHITECTURE.md` antes de interpretar una salida como dato clínico.
