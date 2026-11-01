/**
 * Triple-ratio features for SpO2 (F4) — pure, no camera, no React.
 * Extiende el ratio dual R/G con R/B y B/G (el canal azul aporta una
 * pseudo-segunda cromófora) y sus derivadas AC/DC normalizadas.
 */

export interface TripleRatioInput {
  redAC: number; redDC: number;
  greenAC: number; greenDC: number;
  blueAC: number; blueDC: number;
}

export interface TripleRatioFeatures {
  /** AC/DC por canal (normalizados). */
  ratioRed: number;
  ratioGreen: number;
  ratioBlue: number;
  /** Ratios cruzados. */
  rg: number; // R/G
  rb: number; // R/B
  bg: number; // B/G
  /** Validez: todos finitos y DC>0. */
  valid: boolean;
}

export function computeTripleRatioFeatures(input: TripleRatioInput): TripleRatioFeatures {
  const out: TripleRatioFeatures = {
    ratioRed: 0, ratioGreen: 0, ratioBlue: 0,
    rg: 0, rb: 0, bg: 0, valid: false,
  };
  const { redAC, redDC, greenAC, greenDC, blueAC, blueDC } = input;
  if (![redAC, redDC, greenAC, greenDC, blueAC, blueDC].every(Number.isFinite)) return out;
  if (redDC <= 0 || greenDC <= 0 || blueDC <= 0) return out;
  const rR = redAC / redDC;
  const rG = greenAC / greenDC;
  const rB = blueAC / blueDC;
  if (![rR, rG, rB].every(Number.isFinite)) return out;
  out.ratioRed = rR;
  out.ratioGreen = rG;
  out.ratioBlue = rB;
  if (rG <= 0 || rB <= 0) return out;
  out.rg = rR / rG;
  out.rb = rR / rB;
  out.bg = rB / rG;
  if (![out.rg, out.rb, out.bg].every(Number.isFinite)) return out;
  out.valid = true;
  return out;
}