#!/usr/bin/env python3
"""
Comprueba la huella de un fichero de pesos y, por omision, la de produccion.

Uso:
    python training/check_weights_fingerprint.py [ruta] [huella_esperada]

Sin argumentos verifica `src/lib/vitals/mlpWeights.ts` contra la huella declarada en
`MLP_WEIGHTS_PROVENANCE`. Reproduce exactamente el algoritmo de
`src/lib/vitals/mlpWeightsFingerprint.ts`, de modo que un desacuerdo entre ambos
lenguajes queda al descubierto.

Sale con codigo 1 si la huella no coincide.
"""

import ast
import os
import re
import struct
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PRODUCTION_WEIGHTS_PATH = os.path.join(REPO_ROOT, "src", "lib", "vitals", "mlpWeights.ts")
PROVENANCE_PATH = os.path.join(REPO_ROOT, "src", "lib", "vitals", "mlpWeightsProvenance.ts")

FNV_OFFSET_BASIS_64 = 0xCBF29CE484222325
FNV_PRIME_64 = 0x100000001B3
MASK_64 = 0xFFFFFFFFFFFFFFFF


def extract_weights_object(source):
    """Devuelve el literal `{ ... }` de MLP_WEIGHTS (llaves balanceadas)."""
    anchor = "export const MLP_WEIGHTS = "
    start = source.index(anchor) + len(anchor)
    start = source.index("{", start)
    depth = 0
    for position in range(start, len(source)):
        char = source[position]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:position + 1]
    raise ValueError("objeto MLP_WEIGHTS sin cerrar")


def parse_weights(source):
    """Convierte el literal TS en dict de Python (las claves se citan)."""
    raw = extract_weights_object(source)
    as_python = re.sub(r"([{,]\s*)([A-Za-z_]\w*)\s*:", r"\1'\2':", raw)
    return ast.literal_eval(as_python)


def _float64_hex(value):
    return struct.pack(">d", float(value)).hex()


def compute_fingerprint(layers):
    """Huella 'fnv1a64:...' de las capas, igual que en TypeScript."""
    lines = []
    for name in ("fc1", "fc2", "fc3"):
        rows = layers[name]["weights"]
        bias = layers[name]["bias"]
        for index, row in enumerate(rows):
            lines.append(
                "%s.w[%d]=%s" % (name, index, ",".join(_float64_hex(v) for v in row))
            )
        lines.append("%s.b=%s" % (name, ",".join(_float64_hex(v) for v in bias)))
    digest = FNV_OFFSET_BASIS_64
    for byte in "\n".join(lines).encode("utf-8"):
        digest ^= byte
        digest = (digest * FNV_PRIME_64) & MASK_64
    return "fnv1a64:%016x" % digest


def declared_fingerprint(source):
    """Lee `fingerprint: 'fnv1a64:...'` de la declaracion de procedencia."""
    match = re.search(r"fingerprint\s*:\s*'([^']+)'", source)
    if not match:
        raise ValueError("la procedencia no declara fingerprint")
    return match.group(1)


def main(argv):
    weights_path = argv[1] if len(argv) > 1 else PRODUCTION_WEIGHTS_PATH
    expected = argv[2] if len(argv) > 2 else None

    with open(weights_path, "r", encoding="utf-8") as handle:
        weights_source = handle.read()

    if expected is None:
        with open(PROVENANCE_PATH, "r", encoding="utf-8") as handle:
            expected = declared_fingerprint(handle.read())

    layers = parse_weights(weights_source)
    actual = compute_fingerprint(layers)

    print("archivo:           %s" % os.path.relpath(weights_path, REPO_ROOT))
    print(
        "filas fc1/fc2/fc3: %s"
        % [len(layers[n]["weights"]) for n in ("fc1", "fc2", "fc3")]
    )
    print("huella calculada:  %s" % actual)
    print("huella esperada:   %s" % expected)

    if actual == expected:
        print("OK - la huella coincide.")
        return 0
    print("FALLO - la huella NO coincide: los pesos no estan verificados.")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
