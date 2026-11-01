#!/usr/bin/env python3
"""
Entrenamiento del MLP de presión arterial (16 -> 32 -> 16 -> 2).

REGLA DE SUSTITUCIÓN DE PESOS (docs/medical-validation.md §4):
`src/lib/vitals/mlpWeights.ts` solo se sobrescribe cuando existe un informe de
validación verificable que demuestre, contra referencia clínica real, el
cumplimiento de ISO 81060-2:2018 / ANSI-AAMI ES1:
    |sesgo| <= 5 mmHg y DE <= 8 mmHg en sistólica y en diastólica,
    >= 30 sujetos y >= 3 pares válidos por sujeto.

Comportamiento por defecto (SIN promoción):
    Los pesos entrenados se escriben en `training/artifacts/mlpWeights.candidate.ts`
    y el archivo de producción NO se toca. El script sale con código 0 e indica
    por qué no se promovió.

Promoción explícita:
    python train_bp_mlp.py --promote --validation-report <ruta.json>
    El gate re-verifica el informe; si algo no cuadra, no se escribe nada.

La huella de los pesos (`fnv1a64:...`) es idéntica a la que calcula
`src/lib/vitals/mlpWeightsFingerprint.ts`; tras promocionar hay que declararla en
`MLP_WEIGHTS_PROVENANCE` (`src/lib/vitals/mlpWeightsProvenance.ts`) o los tests
de CI fallan y el motor descarta el MLP.
"""

import argparse
import json
import os
import struct
import sys
from datetime import datetime, timezone

import numpy as np
import torch
import torch.nn as nn

# ── Criterios de promoción (espejo de BP_PROMOTION_CRITERIA en TypeScript) ──
MIN_SUBJECTS = 30
MAX_ABS_BIAS_MMHG = 5.0
MAX_SD_MMHG = 8.0
MIN_PAIRS_PER_SUBJECT = 3
LOA_TOLERANCE_MMHG = 0.5

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PRODUCTION_WEIGHTS_PATH = os.path.join(
    REPO_ROOT, "src", "lib", "vitals", "mlpWeights.ts"
)
CANDIDATE_WEIGHTS_PATH = os.path.join(
    REPO_ROOT, "training", "artifacts", "mlpWeights.candidate.ts"
)

FNV_OFFSET_BASIS_64 = 0xCBF29CE484222325
FNV_PRIME_64 = 0x100000001B3
MASK_64 = 0xFFFFFFFFFFFFFFFF


# ═══════════════════════════════════════════════════════════════════════════
# Huella de pesos — mismo algoritmo que mlpWeightsFingerprint.ts
# ═══════════════════════════════════════════════════════════════════════════


def _float64_hex(value):
    """Bytes IEEE-754 big-endian del valor, en hexadecimal (16 caracteres)."""
    number = float(value)
    if not np.isfinite(number):
        raise ValueError("valor no finito en los pesos: %r" % (value,))
    return struct.pack(">d", number).hex()


def serialize_weights(layers):
    """
    Texto canónico. `layers` es [(nombre, filas, bias), ...] en orden
    fc1, fc2, fc3, con filas = lista de listas de floats.
    """
    lines = []
    for name, rows, bias in layers:
        for index, row in enumerate(rows):
            cells = ",".join(_float64_hex(value) for value in row)
            lines.append("%s.w[%d]=%s" % (name, index, cells))
        cells = ",".join(_float64_hex(value) for value in bias)
        lines.append("%s.b=%s" % (name, cells))
    return "\n".join(lines)


def compute_weights_fingerprint(layers):
    """Huella 'fnv1a64:...' sobre el texto canónico en UTF-8."""
    payload = serialize_weights(layers).encode("utf-8")
    digest = FNV_OFFSET_BASIS_64
    for byte in payload:
        digest ^= byte
        digest = (digest * FNV_PRIME_64) & MASK_64
    return "fnv1a64:%016x" % digest


# ═══════════════════════════════════════════════════════════════════════════
# Gate de promoción — mismo criterio que evaluateBpWeightsPromotion (TS)
# ═══════════════════════════════════════════════════════════════════════════


def _parse_iso(value):
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _check_arm(name, arm, required_pairs, blockers):
    if not isinstance(arm, dict):
        blockers.append("%s: falta el brazo de métricas" % name)
        return

    numeric = ("sampleCount", "bias", "sd", "mae", "loaLower", "loaUpper")
    values = {}
    for field in numeric:
        raw = arm.get(field)
        if not isinstance(raw, (int, float)) or not np.isfinite(float(raw)):
            blockers.append("%s.%s: valor no finito o ausente" % (name, field))
            return
        values[field] = float(raw)

    if values["sampleCount"] < required_pairs:
        blockers.append(
            "%s: %d pares válidos, mínimo %d (ISO 81060-2)"
            % (name, int(values["sampleCount"]), required_pairs)
        )
    if abs(values["bias"]) > MAX_ABS_BIAS_MMHG:
        blockers.append(
            "%s: sesgo %.2f mmHg, máximo ±%.1f"
            % (name, values["bias"], MAX_ABS_BIAS_MMHG)
        )
    if values["sd"] > MAX_SD_MMHG:
        blockers.append(
            "%s: DE %.2f mmHg, máximo %.1f" % (name, values["sd"], MAX_SD_MMHG)
        )
    if values["mae"] + 1e-9 < abs(values["bias"]):
        blockers.append(
            "%s: MAE (%.2f) menor que |sesgo| (%.2f)"
            % (name, values["mae"], abs(values["bias"]))
        )

    expected_lower = values["bias"] - 1.96 * values["sd"]
    expected_upper = values["bias"] + 1.96 * values["sd"]
    if (
        abs(values["loaLower"] - expected_lower) > LOA_TOLERANCE_MMHG
        or abs(values["loaUpper"] - expected_upper) > LOA_TOLERANCE_MMHG
    ):
        blockers.append(
            "%s: límites de concordancia incoherentes con bias ± 1.96·sd "
            "(esperado [%.2f, %.2f])"
            % (name, expected_lower, expected_upper)
        )


def evaluate_promotion(report, candidate_fingerprint, candidate_generated_at):
    """Devuelve (permitido, lista_de_bloqueos). Sin informe => bloqueado."""
    blockers = []

    if not isinstance(report, dict):
        return False, [
            "No existe informe de validación para estos pesos: "
            "la sustitución requiere resultados verificables."
        ]

    if report.get("weightsFingerprint") != candidate_fingerprint:
        blockers.append(
            'El informe evalúa los pesos "%s" pero los candidatos son "%s".'
            % (report.get("weightsFingerprint"), candidate_fingerprint)
        )

    evaluated_at = _parse_iso(report.get("evaluatedAt"))
    if evaluated_at is None:
        blockers.append("evaluatedAt no es una fecha ISO 8601 válida")
    elif evaluated_at < candidate_generated_at:
        blockers.append("El informe es anterior a la generación de los pesos evaluados")

    if not str(report.get("protocol") or "").strip():
        blockers.append("Falta el protocolo de validación")
    if not str(report.get("evaluator") or "").strip():
        blockers.append("Falta el responsable de la evaluación")

    dataset = report.get("dataset")
    if not isinstance(dataset, dict):
        blockers.append("Falta la descripción del dataset")
        subject_count = 0
    else:
        subject_count = dataset.get("subjectCount")
        if dataset.get("kind") != "clinical_reference":
            blockers.append(
                'Dataset "%s": solo un dataset con referencia clínica '
                "(clinical_reference) habilita la promoción" % dataset.get("kind")
            )
        if not isinstance(subject_count, (int, float)) or subject_count < MIN_SUBJECTS:
            blockers.append(
                "Sujetos %s: mínimo %d (docs/medical-validation.md §4.1)"
                % (subject_count, MIN_SUBJECTS)
            )
            subject_count = 0
        if dataset.get("referenceDeviceCertified") is not True:
            blockers.append(
                "El dispositivo de referencia no está declarado como certificado"
            )
        if not str(dataset.get("referenceDevice") or "").strip():
            blockers.append("Falta el dispositivo de referencia")
        if not str(dataset.get("datasetId") or "").strip():
            blockers.append("Falta el identificador del dataset registrado")
        if _parse_iso(dataset.get("collectedAt")) is None:
            blockers.append("dataset.collectedAt no es una fecha ISO 8601 válida")

    required_pairs = max(MIN_PAIRS_PER_SUBJECT, MIN_PAIRS_PER_SUBJECT * int(subject_count or 0))
    arms = report.get("arms") or {}
    _check_arm("systolic", arms.get("systolic"), required_pairs, blockers)
    _check_arm("diastolic", arms.get("diastolic"), required_pairs, blockers)

    return len(blockers) == 0, blockers
# ═══════════════════════════════════════════════════════════════════════════
# Modelo y datos
# ═══════════════════════════════════════════════════════════════════════════


class BpMlpNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc1 = nn.Linear(16, 32)
        self.relu1 = nn.ReLU()
        self.fc2 = nn.Linear(32, 16)
        self.relu2 = nn.ReLU()
        self.fc3 = nn.Linear(16, 2)

    def forward(self, x):
        x = self.relu1(self.fc1(x))
        x = self.relu2(self.fc2(x))
        return self.fc3(x)


def generate_physiological_data(n_samples=5000, seed=42):
    """
    Genera features uniformes y objetivos calculados con fórmulas fisiológicas
    aproximadas. NO son mediciones de pacientes: sirven para entrenar y para
    comprobar que el pipeline funciona, nunca como base clínica.
    """
    rng = np.random.default_rng(seed)

    # Inputs
    sut_ratio = rng.uniform(0.12, 0.38, n_samples)
    dia_phase_ratio = rng.uniform(0.25, 0.75, n_samples)
    pw50_ratio = rng.uniform(0.15, 0.48, n_samples)
    area_ratio = rng.uniform(0.8, 2.2, n_samples)
    dicrotic_depth = rng.uniform(0.08, 0.45, n_samples)
    stiffness_index = rng.uniform(4.0, 18.0, n_samples)
    augmentation_index = rng.uniform(5.0, 35.0, n_samples)
    k_value = rng.uniform(0.28, 0.52, n_samples)
    v_max = rng.uniform(25.0, 95.0, n_samples)
    agi = rng.uniform(-0.6, 1.6, n_samples)
    b_div_a = rng.uniform(-0.9, 0.9, n_samples)
    d_div_a = rng.uniform(-0.7, 0.5, n_samples)

    hr = rng.uniform(50.0, 140.0, n_samples)
    age = rng.uniform(18.0, 85.0, n_samples)
    bmi = rng.uniform(17.5, 38.0, n_samples)
    is_male = rng.choice([0.0, 1.0], size=n_samples)

    X = np.stack(
        [
            sut_ratio,
            dia_phase_ratio,
            pw50_ratio,
            area_ratio,
            dicrotic_depth,
            stiffness_index,
            augmentation_index,
            k_value,
            v_max,
            agi,
            b_div_a,
            d_div_a,
            hr,
            age,
            bmi,
            is_male,
        ],
        axis=1,
    )

    # SBP/DBP targets (physiological formulas)
    sbp_base = (
        112.0
        + 0.32 * (age - 38.0)
        + 0.45 * (bmi - 23.0)
        + 0.15 * (hr - 72.0)
        + 1.15 * stiffness_index
        + 0.22 * augmentation_index
        - 45.0 * (sut_ratio - 0.22)
        + 6.5 * (area_ratio - 1.2)
    )
    dbp_base = (
        72.0
        + 0.19 * (age - 38.0)
        + 0.32 * (bmi - 23.0)
        + 0.08 * (hr - 72.0)
        + 0.28 * stiffness_index
        - 22.0 * (dia_phase_ratio - 0.48)
        + 14.0 * (pw50_ratio - 0.28)
    )

    # Gender adjustment
    sbp_base += is_male * 5.0 - 2.5
    dbp_base += is_male * 2.5 - 1.2

    # Interactions
    sbp = sbp_base + 0.016 * age * stiffness_index + 0.05 * hr * (1.0 - sut_ratio)
    dbp = dbp_base + 0.007 * age * stiffness_index - 0.03 * hr * dia_phase_ratio

    # Add noise
    sbp += rng.normal(0, 1.8, n_samples)
    dbp += rng.normal(0, 1.4, n_samples)

    # Guardrails
    sbp = np.clip(sbp, 75, 195)
    dbp = np.clip(dbp, 45, 115)

    return X.astype(np.float32), np.stack([sbp, dbp], axis=1).astype(np.float32)
# ═══════════════════════════════════════════════════════════════════════════
# Entrenamiento
# ═══════════════════════════════════════════════════════════════════════════


def _extract_layers(state):
    """Convierte el state_dict en [(nombre, filas, bias), ...]."""
    layers = []
    for name in ("fc1", "fc2", "fc3"):
        rows = np.asarray(state["%s.weight" % name], dtype=np.float64).tolist()
        bias = np.asarray(state["%s.bias" % name], dtype=np.float64).tolist()
        layers.append((name, rows, bias))
    return layers


def train(epochs=120, seed=42, verbose=True):
    """Entrena y devuelve (layers, best_val_mse, metrics_no_clinicas)."""
    X_train, y_train = generate_physiological_data(6000, seed=seed)
    X_val, y_val = generate_physiological_data(1000, seed=seed + 57)

    # Normalización idéntica a la que aplica TypeScript antes de la inferencia
    def normalise(matrix):
        out = matrix.astype(np.float64).copy()
        out[:, 5] /= 10.0   # stiffness_index
        out[:, 6] /= 20.0   # augmentation_index
        out[:, 8] /= 50.0   # v_max
        out[:, 12] /= 100.0  # hr
        out[:, 13] /= 50.0  # age
        out[:, 14] /= 25.0  # bmi
        return out

    norm_X_train = normalise(X_train)
    norm_X_val = normalise(X_val)

    torch.manual_seed(seed)
    model = BpMlpNet()
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.005, weight_decay=1e-4)
    criterion = nn.MSELoss()

    X_t = torch.tensor(norm_X_train, dtype=torch.float32)
    y_t = torch.tensor(y_train, dtype=torch.float32)
    X_v = torch.tensor(norm_X_val, dtype=torch.float32)
    y_v = torch.tensor(y_val, dtype=torch.float32)

    best_loss = float("inf")
    best_state = None

    for epoch in range(epochs):
        model.train()
        optimizer.zero_grad()
        pred = model(X_t)
        loss = criterion(pred, y_t)
        loss.backward()
        optimizer.step()

        model.eval()
        with torch.no_grad():
            val_loss = criterion(model(X_v), y_v).item()

        if val_loss < best_loss:
            best_loss = val_loss
            best_state = {k: v.detach().cpu().numpy() for k, v in model.state_dict().items()}

        if verbose and (epoch + 1) % 20 == 0:
            print(
                "Epoch %03d | Train MSE: %.4f | Val MSE: %.4f"
                % (epoch + 1, loss.item(), val_loss)
            )

    if verbose:
        print("Entrenamiento terminado. Mejor Val MSE (objetivos por fórmula): %.4f" % best_loss)

    with torch.no_grad():
        predictions = model(X_v).numpy()
    differences = predictions - y_val
    metrics = {
        "systolic_mae_mmhg": float(np.mean(np.abs(differences[:, 0]))),
        "diastolic_mae_mmhg": float(np.mean(np.abs(differences[:, 1]))),
        "note": "Error frente a los objetivos por fórmula del set de validación. NO es validación clínica.",
    }

    return _extract_layers(best_state), best_loss, metrics


# ═══════════════════════════════════════════════════════════════════════════
# Exportación
# ═══════════════════════════════════════════════════════════════════════════

HEADER_TEMPLATE = """/**
 * Pre-trained Multi-Layer Perceptron (MLP) weights for Blood Pressure estimation.
 * Generated automatically by training/train_bp_mlp.py.
 * Do not edit manually.
 *
 * PROCEDENCIA (divulgación obligatoria — no editar sin informe de validación):
 * {provenance}
 *
 * Huella de estos pesos: {fingerprint}
 * Declararla en `MLP_WEIGHTS_PROVENANCE` (src/lib/vitals/mlpWeightsProvenance.ts)
 * o la verificación de integridad los descarta y los tests de CI fallan.
 */

export const MLP_WEIGHTS = {{
  fc1: {{
    weights: {fc1_weights},
    bias: {fc1_bias}
  }},
  fc2: {{
    weights: {fc2_weights},
    bias: {fc2_bias}
  }},
  fc3: {{
    weights: {fc3_weights},
    bias: {fc3_bias}
  }}
}};
"""

PROVENANCE_FORMULA = (
    "Pesos obtenidos con objetivos calculados por fórmulas fisiológicas "
    "aproximadas sobre features generados. NO son mediciones de pacientes y la "
    "precisión clínica NO está validada."
)

PROVENANCE_CLINICAL = (
    "Pesos entrenados sobre pares (estimación, referencia certificada) en "
    "sujetos reales y validados según el informe declarado en "
    "MLP_WEIGHTS_PROVENANCE.validationReportPath."
)


def render_typescript(layers, fingerprint, clinically_validated):
    """Devuelve el contenido de mlpWeights.ts para estos pesos."""
    by_name = {name: (rows, bias) for name, rows, bias in layers}
    fc1_rows, fc1_bias = by_name["fc1"]
    fc2_rows, fc2_bias = by_name["fc2"]
    fc3_rows, fc3_bias = by_name["fc3"]
    return HEADER_TEMPLATE.format(
        provenance=PROVENANCE_CLINICAL if clinically_validated else PROVENANCE_FORMULA,
        fingerprint=fingerprint,
        fc1_weights=fc1_rows,
        fc1_bias=fc1_bias,
        fc2_weights=fc2_rows,
        fc2_bias=fc2_bias,
        fc3_weights=fc3_rows,
        fc3_bias=fc3_bias,
    )


def write_file_atomic(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
    os.replace(temporary, path)


# ═══════════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════════


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            "Entrena el MLP de PA. Por defecto solo escribe un candidato; "
            "sobrescribir los pesos de producción exige --promote con un informe "
            "de validación que pase el gate."
        )
    )
    parser.add_argument("--epochs", type=int, default=120)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--promote",
        action="store_true",
        help="Escribe src/lib/vitals/mlpWeights.ts (requiere --validation-report válido).",
    )
    parser.add_argument(
        "--validation-report",
        type=str,
        default=None,
        help="Ruta al JSON con el informe de validación (BpValidationReport).",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="No imprime el progreso por epoch.",
    )
    args = parser.parse_args(argv)

    layers, best_loss, metrics = train(
        epochs=args.epochs, seed=args.seed, verbose=not args.quiet
    )
    fingerprint = compute_weights_fingerprint(layers)
    generated_at = datetime.now(timezone.utc)

    print("")
    print("Huella de los pesos entrenados: %s" % fingerprint)
    print("Val MSE (objetivos por fórmula): %.4f" % best_loss)
    print(
        "MAE sobre objetivos por fórmula -> SBP %.2f mmHg | DBP %.2f mmHg"
        % (metrics["systolic_mae_mmhg"], metrics["diastolic_mae_mmhg"])
    )
    print("Aviso: esas cifras NO son una validación clínica.")

    report = None
    if args.validation_report:
        if not os.path.isfile(args.validation_report):
            print("ERROR: no existe el informe %s" % args.validation_report)
            return 2
        with open(args.validation_report, "r", encoding="utf-8") as handle:
            report = json.load(handle)

    allowed, blockers = evaluate_promotion(report, fingerprint, generated_at)

    if args.promote and allowed:
        content = render_typescript(layers, fingerprint, clinically_validated=True)
        write_file_atomic(PRODUCTION_WEIGHTS_PATH, content)
        print("")
        print("PROMOCIÓN ACEPTADA: %s actualizado." % PRODUCTION_WEIGHTS_PATH)
        print("PASO OBLIGATORIO: declarar en MLP_WEIGHTS_PROVENANCE:")
        print("    fingerprint: '%s'" % fingerprint)
        print("    validationStatus: 'validated'")
        print("    validationReportPath: '%s'" % args.validation_report)
        return 0

    content = render_typescript(layers, fingerprint, clinically_validated=False)
    write_file_atomic(CANDIDATE_WEIGHTS_PATH, content)

    print("")
    if args.promote:
        print("PROMOCIÓN RECHAZADA: %s NO se ha modificado." % PRODUCTION_WEIGHTS_PATH)
    else:
        print(
            "Sin --promote: %s NO se ha modificado." % PRODUCTION_WEIGHTS_PATH
        )
    print("Motivos:")
    for blocker in blockers:
        print("  - %s" % blocker)
    print("")
    print("Pesos candidatos guardados en: %s" % CANDIDATE_WEIGHTS_PATH)
    return 0 if not args.promote else 1


if __name__ == "__main__":
    sys.exit(main())
