"""Comprueba que la huella de un mlpWeights.ts coincide con la esperada.

Uso: python temp_fp_check.py <ruta> <huella_esperada>
"""
import ast
import re
import struct
import sys

FNV_OFFSET = 0xCBF29CE484222325
FNV_PRIME = 0x100000001B3
MASK = 0xFFFFFFFFFFFFFFFF


def extract_object(source, anchor):
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
    raise ValueError("objeto sin cerrar")


def hex64(value):
    return struct.pack(">d", float(value)).hex()


def fingerprint(layers):
    lines = []
    for name in ("fc1", "fc2", "fc3"):
        rows = layers[name]["weights"]
        bias = layers[name]["bias"]
        assert len(rows) == len(bias), name
        for index, row in enumerate(rows):
            lines.append("%s.w[%d]=%s" % (name, index, ",".join(hex64(v) for v in row)))
        lines.append("%s.b=%s" % (name, ",".join(hex64(v) for v in bias)))
    digest = FNV_OFFSET
    for byte in "\n".join(lines).encode("utf-8"):
        digest ^= byte
        digest = (digest * FNV_PRIME) & MASK
    return "fnv1a64:%016x" % digest


path = sys.argv[1]
expected = sys.argv[2]

with open(path, "r", encoding="utf-8") as handle:
    source = handle.read()

raw = extract_object(source, "export const MLP_WEIGHTS = ")
layers = ast.literal_eval(re.sub(r"([{,]\s*)([A-Za-z_]\w*)\s*:", r"\1'\2':", raw))

actual = fingerprint(layers)
print("archivo:", path)
print("filas:", [len(layers[n]["weights"]) for n in ("fc1", "fc2", "fc3")])
print("huella recalculada:", actual)
print("huella esperada:   ", expected)
print("COINCIDEN" if actual == expected else "NO COINCIDEN")
sys.exit(0 if actual == expected else 1)
