"""Comprueba el gate de promocion de train_bp_mlp.py sin tocar produccion."""
import sys
from datetime import datetime, timezone

sys.path.insert(0, "training")
import train_bp_mlp as gate  # noqa: E402

FINGERPRINT = "fnv1a64:329fb1661a12f726"
GENERATED_AT = datetime.now(timezone.utc)


def arm(bias, sd, sample_count):
    return {
        "sampleCount": sample_count,
        "bias": bias,
        "sd": sd,
        "mae": abs(bias) + 2.0,
        "loaLower": bias - 1.96 * sd,
        "loaUpper": bias + 1.96 * sd,
    }


def report(kind="clinical_reference", subjects=45):
    return {
        "weightsFingerprint": FINGERPRINT,
        "weightsGeneratedAt": GENERATED_AT.isoformat(),
        "evaluatedAt": GENERATED_AT.isoformat(),
        "protocol": "ISO 81060-2:2018",
        "evaluator": "Laboratorio de validacion",
        "dataset": {
            "kind": kind,
            "subjectCount": subjects,
            "referenceDevice": "Esfigmomanometro auscultatorio validado",
            "referenceDeviceCertified": True,
            "collectedAt": GENERATED_AT.isoformat(),
            "datasetId": "ds-bp-2026-04",
        },
        "arms": {
            "systolic": arm(1.4, 6.2, 3 * subjects),
            "diastolic": arm(-0.9, 5.1, 3 * subjects),
        },
    }


cases = [
    ("informe conforme", report(), True),
    ("dataset por formulas", report(kind="formula_generated"), False),
    ("pocos sujetos", report(subjects=12), False),
    ("sin informe", None, False),
]

failures = 0
for name, payload, expected in cases:
    allowed, blockers = gate.evaluate_promotion(payload, FINGERPRINT, GENERATED_AT)
    if allowed != expected:
        failures += 1
    print("%-22s permitido=%-5s esperado=%-5s %s" % (
        name, allowed, expected, "OK" if allowed == expected else "FALLO"))
    if not allowed:
        print("    bloqueo: %s" % (blockers[0] if blockers else "(ninguno)"))

sys.exit(1 if failures else 0)
