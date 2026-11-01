/**
 * Huella determinista de los pesos del MLP de presión arterial.
 *
 * Objetivo: que cualquier sustitución de pesos en `mlpWeights.ts` quede
 * detectada de forma automática. La huella se declara en
 * `mlpWeightsProvenance.ts`; si los pesos cambian sin actualizar la procedencia,
 * `getMlpWeightsIntegrity()` lo marca como no verificado y el motor descarta la
 * contribución del MLP (fusión `wMlp = 0`), además de fallar en CI.
 *
 * ALGORITMO (idéntico en TypeScript y en `training/train_bp_mlp.py`):
 *   1. Serialización canónica a texto UTF-8:
 *        - capas en orden fc1, fc2, fc3
 *        - por cada fila i de `weights`:   "<capa>.w[<i>]=<hex>,<hex>,..."
 *        - luego el vector `bias`:         "<capa>.b=<hex>,<hex>,..."
 *        - todo unido con "\n"
 *      donde <hex> es la representación hexadecimal big-endian de 16 dígitos
 *      del IEEE-754 float64 exacto del valor (struct.pack('>d', v).hex() en
 *      Python, DataView.setFloat64(0, v, false) en JS).
 *   2. FNV-1a de 64 bits sobre los bytes UTF-8 del texto canónico.
 *   3. Formato final: "fnv1a64:" + 16 dígitos hex.
 *
 * Trabajar con los bytes del float64 (y no con su representación decimal)
 * elimina toda ambigüedad de redondeo entre ambos lenguajes.
 */

const LAYER_ORDER = ['fc1', 'fc2', 'fc3'] as const;

export type MlpLayerName = (typeof LAYER_ORDER)[number];

/** Dimensiones canónicas del MLP de PA declarado en `training/train_bp_mlp.py`. */
export const MLP_ARCHITECTURE = {
  inputDimension: 16,
  hiddenLayers: { fc1: 32, fc2: 16 },
  outputDimension: 2,
} as const;

export interface MlpLayerWeights {
  weights: number[][];
  bias: number[];
}

export interface MlpWeightsShape {
  fc1: MlpLayerWeights;
  fc2: MlpLayerWeights;
  fc3: MlpLayerWeights;
}

const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

const float64Scratch = new DataView(new ArrayBuffer(8));

/** Bytes IEEE-754 big-endian del valor, en hexadecimal (16 caracteres). */
function float64Hex(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`mlpWeights: valor no finito en los pesos (${String(value)})`);
  }
  float64Scratch.setFloat64(0, value, false);
  let hex = '';
  for (let byte = 0; byte < 8; byte += 1) {
    hex += float64Scratch.getUint8(byte).toString(16).padStart(2, '0');
  }
  return hex;
}

/** Texto canónico sobre el que se calcula la huella. */
export function serializeMlpWeights(weights: MlpWeightsShape): string {
  const lines: string[] = [];
  for (const layer of LAYER_ORDER) {
    const { weights: rows, bias } = weights[layer];
    rows.forEach((row, rowIndex) => {
      lines.push(`${layer}.w[${rowIndex}]=${row.map(float64Hex).join(',')}`);
    });
    lines.push(`${layer}.b=${bias.map(float64Hex).join(',')}`);
  }
  return lines.join('\n');
}

function fnv1a64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hash = FNV_OFFSET_BASIS_64;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= BigInt(bytes[index]);
    hash = (hash * FNV_PRIME_64) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Huella "fnv1a64:…" de un juego de pesos. */
export function computeMlpWeightsFingerprint(weights: MlpWeightsShape): string {
  return `fnv1a64:${fnv1a64(serializeMlpWeights(weights))}`;
}

/**
 * Comprueba que la forma de los pesos coincide con la arquitectura declarada.
 * Devuelve la lista de problemas encontrados (vacía = correcto).
 */
export function verifyMlpWeightsShape(weights: MlpWeightsShape): string[] {
  const problems: string[] = [];
  const { inputDimension, hiddenLayers, outputDimension } = MLP_ARCHITECTURE;

  // Por capa: neuronas de salida (= filas de pesos = tamaño del bias) y
  // neuronas de entrada (= longitud de cada fila de pesos).
  const expected: Record<MlpLayerName, { neurons: number; fanIn: number }> = {
    fc1: { neurons: hiddenLayers.fc1, fanIn: inputDimension },
    fc2: { neurons: hiddenLayers.fc2, fanIn: hiddenLayers.fc1 },
    fc3: { neurons: outputDimension, fanIn: hiddenLayers.fc2 },
  };

  for (const layer of LAYER_ORDER) {
    const { weights: rows, bias } = weights[layer];
    const { neurons, fanIn } = expected[layer];

    if (rows.length !== neurons) {
      problems.push(`${layer}: ${rows.length} filas de pesos, se esperaban ${neurons}`);
    }
    if (bias.length !== neurons) {
      problems.push(`${layer}: bias de ${bias.length} valores, se esperaban ${neurons}`);
    }
    rows.forEach((row, rowIndex) => {
      if (row.length !== fanIn) {
        problems.push(`${layer}.w[${rowIndex}]: ${row.length} entradas, se esperaban ${fanIn}`);
      }
    });
  }

  return problems;
}
