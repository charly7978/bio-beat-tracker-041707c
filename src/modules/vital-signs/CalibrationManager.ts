import { CalibrationInfo } from '../../types/measurements';
import type { AnthropometricProfile } from '@/lib/vitals/pwaPhysiologicalBpEngine';
import {
  NEXUS_CALIBRATION_VALIDITY_MS,
  type NexusCalibrationFitResult,
  type NexusCalibrationPair,
} from '@/lib/vitals/nexusCalibrationFit';
import type { PttPersonalModel } from '@/lib/vitals/nexusFusionCore';
import { createLogger } from '@/utils/logger';

const log = createLogger('CalibrationManager');

export type CalibrationType = 'SPO2' | 'BP' | 'DEVICE' | 'PPG_BASELINE' | 'NEXUS_PTT';

/** Identificador de dispositivo de la fuente PPG por cámara (perfiles de calibración). */
export const CALIBRATION_DEVICE_ID = 'camera_ppg';

/**
 * Clave localStorage del registro de pares de calibración NEXUS (τ + PA de
 * referencia del brazalete). Registro independiente de los perfiles: el par es
 * materia prima del ajuste, el perfil NEXUS_PTT es el modelo ya ajustado.
 */
export const NEXUS_CALIBRATION_PAIRS_KEY = 'nexus_calibration_pairs';

export interface CalibrationProfile {
  id: string;
  type: CalibrationType;
  deviceId: string;
  modelName: string;
  coefficients: Record<string, number>;
  referenceValues: Record<string, number>;
  createdAt: number;
  expiresAt: number;
  method: string;
}

export class CalibrationManager {
  private static instance: CalibrationManager;
  private profiles: Map<string, CalibrationProfile> = new Map();
  private activeProfileId: string | null = null;
  private anthropometric: AnthropometricProfile | null = null;

  private constructor() {
    this.loadFromStorage();
    this.loadAnthropometric();
  }

  public static getInstance(): CalibrationManager {
    if (!CalibrationManager.instance) {
      CalibrationManager.instance = new CalibrationManager();
    }
    return CalibrationManager.instance;
  }

  private loadFromStorage(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const stored = localStorage.getItem('calibration_profiles');
      if (stored) {
        const parsed = JSON.parse(stored);
        Object.keys(parsed).forEach(id => {
          this.profiles.set(id, parsed[id]);
        });
      }
      this.activeProfileId = localStorage.getItem('active_calibration_id');
    } catch (e) {
      log.error('Error loading calibrations:', e);
    }
  }

  private saveToStorage(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const obj: Record<string, CalibrationProfile> = {};
      this.profiles.forEach((p, id) => {
        obj[id] = p;
      });
      localStorage.setItem('calibration_profiles', JSON.stringify(obj));
      if (this.activeProfileId) {
        localStorage.setItem('active_calibration_id', this.activeProfileId);
      }
    } catch (e) {
      log.error('Error saving calibrations:', e);
    }
  }

  private loadAnthropometric(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const stored = localStorage.getItem('anthropometric_profile');
      if (stored) {
        this.anthropometric = JSON.parse(stored);
      }
    } catch { /* ignore */ }
  }

  private saveAnthropometric(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      if (this.anthropometric) {
        localStorage.setItem('anthropometric_profile', JSON.stringify(this.anthropometric));
      }
    } catch { /* ignore */ }
  }

  public setAnthropometric(profile: AnthropometricProfile): void {
    this.anthropometric = profile;
    this.saveAnthropometric();
  }

  public getAnthropometric(): AnthropometricProfile | null {
    return this.anthropometric;
  }

  public addProfile(profile: CalibrationProfile): void {
    this.profiles.set(profile.id, profile);
    this.activeProfileId = profile.id;
    this.saveToStorage();
  }

  public getActiveProfile(type: CalibrationType): CalibrationProfile | undefined {
    if (this.activeProfileId) {
      const p = this.profiles.get(this.activeProfileId);
      if (p && p.type === type && p.expiresAt > Date.now()) {
        return p;
      }
    }
    
    // Fallback search for latest valid of type
    const valid = Array.from(this.profiles.values())
      .filter(p => p.type === type && p.expiresAt > Date.now())
      .sort((a, b) => b.createdAt - a.createdAt);
    
    return valid[0];
  }

  public getCalibrationInfo(type: CalibrationType): CalibrationInfo {
    let profile = this.getActiveProfile(type);
    if (!profile) {
      const candidates = Array.from(this.profiles.values())
        .filter((p) => p.type === type)
        .sort((a, b) => b.createdAt - a.createdAt);
      profile = candidates[0];
    }
    const now = Date.now();
    const expired = !!(profile && profile.expiresAt <= now);
    return {
      required: type === 'BP' || type === 'SPO2',
      available: !!profile && !expired,
      expired,
      profileId: profile?.id,
      lastCalibrationAt: profile?.createdAt,
      expiresAt: profile?.expiresAt,
      method: profile?.method
    };
  }

  /** Offsets de PA del perfil BP vigente (null si no hay calibración activa). */
  public getActiveBpOffsets(): { sbpOffset: number; dbpOffset: number } | null {
    const profile = this.getActiveProfile('BP');
    if (!profile || profile.expiresAt <= Date.now()) return null;
    return {
      sbpOffset: profile.coefficients.sbpOffset ?? profile.coefficients.systolicOffset ?? 0,
      dbpOffset: profile.coefficients.dbpOffset ?? profile.coefficients.diastolicOffset ?? 0,
    };
  }

  /** Offset de SpO2 del perfil SPO2 vigente (0 si no hay calibración activa). */
  public getActiveSpo2Offset(): number {
    const profile = this.getActiveProfile('SPO2');
    if (!profile || profile.expiresAt <= Date.now()) return 0;
    return profile.coefficients.spo2Offset ?? 0;
  }

  // ═══════════════ NEXUS (F3): modelo personal PTT↔PA y pares de calibración ═══════════════

  /** Registro de pares NEXUS leído del almacenamiento local (vacío si no hay). */
  public getNexusCalibrationPairs(): NexusCalibrationPair[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(NEXUS_CALIBRATION_PAIRS_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (p): p is NexusCalibrationPair =>
          !!p &&
          typeof p === 'object' &&
          Number.isFinite((p as NexusCalibrationPair).timestampMs) &&
          Number.isFinite((p as NexusCalibrationPair).tauMs) &&
          Number.isFinite((p as NexusCalibrationPair).sbpMmHg) &&
          Number.isFinite((p as NexusCalibrationPair).dbpMmHg),
      );
    } catch (e) {
      log.error('Error leyendo pares NEXUS:', e);
      return [];
    }
  }

  /**
   * Registra un trío (τ de la insignia NEXUS + PA de referencia del brazalete)
   * con sello temporal del runtime. Devuelve el par completo persistido.
   */
  public addNexusCalibrationPair(
    input: { tauMs: number; sbpMmHg: number; dbpMmHg: number; quality0to100?: number },
  ): NexusCalibrationPair | null {
    const pair: NexusCalibrationPair = {
      timestampMs: Date.now(),
      tauMs: input.tauMs,
      sbpMmHg: input.sbpMmHg,
      dbpMmHg: input.dbpMmHg,
      ...(input.quality0to100 !== undefined ? { quality0to100: input.quality0to100 } : {}),
    };
    if (typeof localStorage === 'undefined') return null;
    try {
      const list = [...this.getNexusCalibrationPairs(), pair].slice(-50);
      localStorage.setItem(NEXUS_CALIBRATION_PAIRS_KEY, JSON.stringify(list));
    } catch (e) {
      log.error('Error guardando par NEXUS:', e);
      return null;
    }
    return pair;
  }

  /** Borra el registro de pares (la materia prima; el modelo revocado aparte). */
  public clearNexusCalibrationPairs(): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(NEXUS_CALIBRATION_PAIRS_KEY);
    }
  }

  /**
   * Proclama el modelo personal ajustado por el fit como perfil NEXUS_PTT
   * activo, con vigencia de NEXUS_CALIBRATION_VALIDITY_MS (28 días) y las
   * estadísticas de acuerdo (Bland–Altman) guardadas como referencia.
   */
  public recordNexusPttModel(fit: NexusCalibrationFitResult): CalibrationProfile | null {
    if (fit.status !== 'FIT' || !fit.model || !fit.altman) return null;
    const now = Date.now();
    const profile: CalibrationProfile = {
      id: `nexus_ptt_${now}`,
      type: 'NEXUS_PTT',
      deviceId: CALIBRATION_DEVICE_ID,
      modelName: 'nexus_ppg_ptt_v1',
      coefficients: {
        kSbpMmHgS2: fit.model.kSbpMmHgS2,
        cSbpMmHg: fit.model.cSbpMmHg,
        kDbpMmHgS2: fit.model.kDbpMmHgS2,
        cDbpMmHg: fit.model.cDbpMmHg,
      },
      referenceValues: {
        biasSbpMmHg: fit.altman.sbp.biasMmHg,
        loaLowSbpMmHg: fit.altman.sbp.loaLowMmHg,
        loaHighSbpMmHg: fit.altman.sbp.loaHighMmHg,
        biasDbpMmHg: fit.altman.dbp.biasMmHg,
        loaLowDbpMmHg: fit.altman.dbp.loaLowMmHg,
        loaHighDbpMmHg: fit.altman.dbp.loaHighMmHg,
        pairsCount: fit.altman.sbp.n,
        rSbp: fit.fitSummary?.rSbp ?? 0,
        rDbp: fit.fitSummary?.rDbp ?? 0,
      },
      createdAt: now,
      expiresAt: now + NEXUS_CALIBRATION_VALIDITY_MS,
      method: 'NEXUS_PTT_DUAL_CAMERA',
    };
    this.addProfile(profile);
    return profile;
  }

  /**
   * Modelo personal PTT↔PA vigente (null si no hay modelo o venció). El
   * consumidor (sesión NEXUS) cae al prior público cuando devuelve null.
   */
  public getActiveNexusPttModel(): PttPersonalModel | null {
    const profile = this.getActiveProfile('NEXUS_PTT');
    if (!profile || profile.expiresAt <= Date.now()) return null;
    const c = profile.coefficients;
    const kS = c.kSbpMmHgS2;
    const cS = c.cSbpMmHg;
    const kD = c.kDbpMmHgS2;
    const cD = c.cDbpMmHg;
    if (![kS, cS, kD, cD].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    return { kSbpMmHgS2: kS, cSbpMmHg: cS, kDbpMmHgS2: kD, cDbpMmHg: cD, calibrated: true };
  }

  /** Info de vigencia del perfil NEXUS_PTT (para el panel con días restantes). */
  public getNexusPttCalibrationInfo(): CalibrationInfo {
    return this.getCalibrationInfo('NEXUS_PTT');
  }

  /**
   * Revoca SOLO los perfiles NEXUS_PTT (los demás perfiles de brazalete y
   * oxímetro permanecen intactos).
   */
  public revokeNexusPttModel(): void {
    let removed = false;
    for (const [id, p] of this.profiles) {
      if (p.type === 'NEXUS_PTT') {
        this.profiles.delete(id);
        removed = true;
      }
    }
    if (removed) this.saveToStorage();
  }

  public reset(): void {
    this.profiles.clear();
    this.activeProfileId = null;
    this.anthropometric = null;
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('calibration_profiles');
      localStorage.removeItem('active_calibration_id');
      localStorage.removeItem('anthropometric_profile');
      localStorage.removeItem(NEXUS_CALIBRATION_PAIRS_KEY);
    }
  }
}
