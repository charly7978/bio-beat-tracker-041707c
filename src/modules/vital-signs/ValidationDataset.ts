import { VitalSignsResult } from './VitalSignsProcessor';
import {
  decryptLocal,
  encryptLocal,
  getOrCreateLocalKey,
} from '../../lib/storage/localEncryptedStorage';
import { createLogger } from '../../utils/logger';

const log = createLogger('ValidationDataset');

export interface ValidationDatasetEntry {
  timestamp: string;
  device: string;
  quality: {
    sqi: number;
    pi: number;
    fps: number;
    jitter: number;
  };
  rr: number[];
  vitals: VitalSignsResult;
  reference: {
    bpm: number | null;
    spo2: number | null;
    systolic: number | null;
    diastolic: number | null;
  };
}

/**
 * Dataset de validación (Bland–Altman pendiente vs referencia clínica).
 *
 * Contiene métricas de salud asociadas a sujeto → se guarda CIFRADO
 * (AES-GCM local, ver localEncryptedStorage para la semántica honesta de
 * "ofuscación local, no almacenamiento seguro"). Si el entorno no permite
 * cifrar (sin crypto.subtle), NO se guarda en plano: se degrada a no-guardar.
 */
export class ValidationDataset {
  private static readonly STORAGE_KEY = 'biobeat_validation_dataset';
  private static readonly KEY_STORAGE_KEY = 'bb-validation-key';

  /** Clave de cifrado del dataset (null si el entorno no permite cifrar). */
  private static async getKey() {
    return getOrCreateLocalKey(this.KEY_STORAGE_KEY);
  }

  public static async addEntry(entry: ValidationDatasetEntry): Promise<boolean> {
    if (typeof localStorage === 'undefined') return false;
    try {
      const key = await this.getKey();
      if (!key) {
        log.warn('crypto.subtle no disponible — entrada de validación NO guardada (sin escribir en plano)');
        return false;
      }
      const data = await this.readDecrypted(key);
      data.push(entry);
      const payload = await encryptLocal(key, data);
      if (payload == null) return false;
      localStorage.setItem(this.STORAGE_KEY, payload);
      return true;
    } catch (e) {
      log.warn('Failed to add to validation dataset:', e);
      return false;
    }
  }

  private static async readDecrypted(key: CryptoKey): Promise<ValidationDatasetEntry[]> {
    const raw = localStorage.getItem(this.STORAGE_KEY);
    if (!raw) return [];
    const data = await decryptLocal<ValidationDatasetEntry[]>(key, raw);
    return Array.isArray(data) ? data : [];
  }

  public static async getDataset(): Promise<ValidationDatasetEntry[]> {
    if (typeof localStorage === 'undefined') return [];
    try {
      const key = await this.getKey();
      if (!key) return [];
      return await this.readDecrypted(key);
    } catch (e) {
      log.warn('Failed to read validation dataset:', e);
      return [];
    }
  }

  public static async exportJSON(): Promise<string> {
    return JSON.stringify(await this.getDataset(), null, 2);
  }

  public static clear(): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(this.STORAGE_KEY);
    }
  }
}
