/**
 * TMDS — Torch Modulation Differential Spectroscopy (F4)
 * =====================================================
 * Cancela luz ambiental y ruido de exposición alternando la intensidad del
 * torch entre dos niveles conocidos dentro de la ventana de medición.
 *
 * Diferencial espectral:  ΔDC_ch = DC_ch(hi) − k·DC_ch(lo), con k = proporción
 * declarada entre niveles. Tasas lentas (≈1 Hz) para no meter line frequency
 * en la banda del pulso.
 *
 * Módulo puro: sin cámara, sin React. La orquestación del torch vive en la
 * capa de dispositivo; aquí solo la aritmética y la validación.
 */

export interface TmdsLevel {
  /** Identificador del nivel ('hi' | 'lo'). */
  level: 'hi' | 'lo';
  /** Intensidad declarada del torch en este nivel (0..1). */
  intensity: number;
  /** DC por canal tras promediar la ventana del nivel. */
  dc: { red: number; green: number; blue: number };
}

export interface TmdsDifferential {
  /** ΔDC por canal (hi − k·lo). */
  deltaDc: { red: number; green: number; blue: number };
  /** k usado (proporción hi/lo declarada). */
  k: number;
  /** true si ambos niveles válidos y el diferencial es finito. */
  valid: boolean;
}

/** k por defecto: relación hi/lo del torch típico (1.0 / 0.6). */
export const TMDS_DEFAULT_K = 1.0 / 0.6;

export function computeTmdsDifferential(
  hi: TmdsLevel,
  lo: TmdsLevel,
  k: number = TMDS_DEFAULT_K,
): TmdsDifferential {
  const out: TmdsDifferential = {
    deltaDc: { red: 0, green: 0, blue: 0 },
    k,
    valid: false,
  };
  if (!Number.isFinite(k) || k <= 0) return out;
  if (!Number.isFinite(hi.intensity) || !Number.isFinite(lo.intensity) || lo.intensity <= 0) return out;
  const channels = ['red', 'green', 'blue'] as const;
  let ok = true;
  for (const ch of channels) {
    const hiDc = hi.dc[ch];
    const loDc = lo.dc[ch];
    if (!Number.isFinite(hiDc) || !Number.isFinite(loDc) || hiDc < 0 || loDc < 0) { ok = false; break; }
    out.deltaDc[ch] = hiDc - k * loDc;
    if (!Number.isFinite(out.deltaDc[ch])) { ok = false; break; }
  }
  out.valid = ok;
  return out;
}

/** Normaliza un diferencial a ratio AC/DC por canal (para alimentar el regresor). */
export function tmdsToRatios(
  diff: TmdsDifferential,
  ac: { red: number; green: number; blue: number },
): { red: number; green: number; blue: number } | null {
  if (!diff.valid) return null;
  const out = { red: 0, green: 0, blue: 0 };
  for (const ch of ['red', 'green', 'blue'] as const) {
    const dc = diff.deltaDc[ch];
    if (Math.abs(dc) < 1e-9) return null;
    out[ch] = ac[ch] / dc;
  }
  if (![out.red, out.green, out.blue].every(Number.isFinite)) return null;
  return out;
}