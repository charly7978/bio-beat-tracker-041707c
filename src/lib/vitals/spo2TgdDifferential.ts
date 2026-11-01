/**
 * TGD — Torch Gated Differential (Fase 4)
 * ========================================
 * Sustituye la modulación de intensidad (imposible con torch booleano) por
 * torch ON / torch OFF con exposición bloqueada y verificada (manual + ISO +
 * exposureTime). Con la exposición fija, el flujo transmitido por el tejido es
 * exactamente DC_on − DC_off: cancela luz ambiental y deriva del
 * autoexposímetro. Si el bloqueo de exposición no se confirma, el diferencial
 * se declara inválido (no se corrige nada a ciegas).
 *
 * Módulo puro: sin cámara, sin React.
 */

export interface TgdExposureSettings {
  exposureMode: string;
  exposureTime?: number;
  iso?: number;
}

export interface TgdLevel {
  /** 'on' | 'off' del torch. */
  torchOn: boolean;
  /** DC por canal tras promediar la ventana del nivel. */
  dc: { red: number; green: number; blue: number };
}

export interface TgdDifferential {
  /** ΔDC por canal (on − off). */
  deltaDc: { red: number; green: number; blue: number };
  /** true si la exposición está bloqueada y el diferencial es finito y positivo. */
  valid: boolean;
  /** Motivo técnico si inválido. */
  reason: string;
}

export function isExposureLocked(settings: TgdExposureSettings): boolean {
  const s = settings as TgdExposureSettings;
  if (s.exposureMode !== 'manual') return false;
  if (typeof s.exposureTime !== 'number' || !Number.isFinite(s.exposureTime) || s.exposureTime <= 0) return false;
  if (typeof s.iso !== 'number' || !Number.isFinite(s.iso) || s.iso <= 0) return false;
  return true;
}

export function computeTgdDifferential(
  on: TgdLevel,
  off: TgdLevel,
  settings: TgdExposureSettings,
): TgdDifferential {
  const out: TgdDifferential = {
    deltaDc: { red: 0, green: 0, blue: 0 },
    valid: false,
    reason: 'NO_EVALUADO',
  };
  if (!isExposureLocked(settings)) {
    out.reason = 'EXPOSICION_NO_BLOQUEADA';
    return out;
  }
  const channels = ['red', 'green', 'blue'] as const;
  let ok = true;
  for (const ch of channels) {
    const onDc = on.dc[ch];
    const offDc = off.dc[ch];
    if (!Number.isFinite(onDc) || !Number.isFinite(offDc) || onDc < 0 || offDc < 0) { ok = false; out.reason = 'DC_INVALIDO'; break; }
    const delta = onDc - offDc;
    if (!Number.isFinite(delta)) { ok = false; out.reason = 'DELTA_NO_FINIDO'; break; }
    out.deltaDc[ch] = delta;
  }
  if (!ok) return out;
  // El diferencial debe ser positivo (el tejido transmite).
  for (const ch of channels) {
    if (out.deltaDc[ch] <= 0) { out.reason = 'DELTA_NO_POSITIVO'; return out; }
  }
  out.valid = true;
  out.reason = 'OK';
  return out;
}

export function tgdToRatios(
  diff: TgdDifferential,
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
