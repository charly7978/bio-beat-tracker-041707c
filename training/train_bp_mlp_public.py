"""
train_bp_mlp_public.py — Entrenamiento del MLP de PA sobre datos PÚBLICOS (F5)
==============================================================================

Objetivo: reemplazar los pesos sintéticos de `src/lib/vitals/mlpWeights.ts`
(weightsId 'bp-mlp-formula-v1', datasetKind 'formula_generated') por pesos
entrenados sobre mediciones reales de pacientes, con procedencia verificable.

Datasets públicos admitidos (ver src/lib/vitals/bpTrainingDatasets.ts):
  1. MIMIC-IV Waveform Database (PhysioNet) — señales PPG/ABP + demografía.
  2. UCI Heart Disease (Cleveland) — variables clínicas + PA.
  3. PhysioNet PPG-BP (Liang et al. 2018) — pares PPG/PA de referencia.

Pipeline:
  1. Cargar y limpiar los datasets (eliminar filas con PA fuera de rango fisiológico).
  2. Extraer features (edad, IMC, rigidez arterial estimada, FC, features morfológicas PPG).
  3. Entrenar MLP (arquitectura fc1 16→32, fc2 32→32, fc3 32→2) con validación cruzada.
  4. Evaluar contra referencia con ISO 81060-2:2018 (|sesgo| ≤ 5 mmHg, DE ≤ 8 mmHg).
  5. Emitir pesos en el formato de `mlpWeights.ts` + huella fnv1a64.
  6. Generar informe BpValidationReport y pasarlo por evaluateBpWeightsPromotion.

Salida:
  - src/lib/vitals/mlpWeights.ts (sustituido, con nuevo weightsId y fingerprint)
  - src/lib/vitals/mlpWeightsProvenance.ts (MLP_WEIGHTS_PROVENANCE actualizado)
  - docs/bp-mlp-training-report.md (métricas + huella + datasetId)

Honestidad: mientras este script no se haya ejecutado sobre datos reales y el
informe no supere el gate, los pesos en producción siguen siendo los sintéticos
y la app los declara como 'formula_generated' / 'unvalidated'.
"""
import argparse
import json
import sys

DATASETS = {
    "mimic-iv-waveform": "https://physionet.org/content/mimic4wdb/0.1.0/",
    "uci-heart-disease": "https://archive.ics.uci.edu/dataset/45/heart+disease",
    "ppg-bp-liang2018": "https://figshare.com/articles/dataset/PPG-BP/...",
}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", choices=list(DATASETS), required=True)
    parser.add_argument("--data-dir", required=True, help="Directorio con los datos descargados")
    parser.add_argument("--out-weights", default="src/lib/vitals/mlpWeights.ts")
    parser.add_argument("--out-report", default="docs/bp-mlp-training-report.md")
    args = parser.parse_args(argv)

    print(f"[F5] Dataset seleccionado: {args.dataset}")
    print(f"[F5] Origen: {DATASETS[args.dataset]}")
    print("[F5] NOTA: este script es el pipeline documentado; su ejecución requiere")
    print("     los datos descargados manualmente (licencia PhysioNet/UCI).")
    print("     No se generan pesos sintéticos ni se simulan resultados.")
    # El entrenamiento real se implementa aquí cuando los datos estén disponibles.
    # Por ahora: emitir un manifiesto de procedencia para auditoría.
    manifest = {
        "dataset": args.dataset,
        "origin": DATASETS[args.dataset],
        "status": "pipeline_documented_not_executed",
        "weightsId": None,
        "fingerprint": None,
        "note": "Ejecutar con --data-dir apuntando a los datos reales descargados.",
    }
    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY