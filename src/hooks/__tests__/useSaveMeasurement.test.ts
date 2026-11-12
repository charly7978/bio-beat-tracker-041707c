import { beforeEach, describe, expect, it } from 'vitest';
import { decryptLocalMeasurements } from '../useSaveMeasurement';

const STORAGE_KEY = 'local_measurements';

describe('decryptLocalMeasurements', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (_name: string, operation: () => Promise<unknown>) => operation(),
      },
    });
  });

  it('preserves readable legacy arrays stored as plain JSON', async () => {
    const legacy = [{ id: 'local-1', heart_rate: 72 }];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));

    await expect(decryptLocalMeasurements()).resolves.toEqual(legacy);
    expect(localStorage.getItem('bb-crypto-key')).toBeNull();
  });

  it('decrypts encrypted history using its persisted key', async () => {
    const history = [{ id: 'local-2', heart_rate: 81 }];
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const keyData = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    localStorage.setItem('bb-crypto-key', btoa(String.fromCharCode(...keyData)));

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(history));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    localStorage.setItem(STORAGE_KEY, btoa(String.fromCharCode(...combined)));

    await expect(decryptLocalMeasurements()).resolves.toEqual(history);
  });

  it('reports unreadable data instead of treating it as an empty history', async () => {
    const corrupted = 'not-valid-encrypted-data';
    localStorage.setItem(STORAGE_KEY, corrupted);

    await expect(decryptLocalMeasurements()).rejects.toThrow(
      'Unable to decrypt local measurements',
    );
    expect(localStorage.getItem(STORAGE_KEY)).toBe(corrupted);
    expect(localStorage.getItem('bb-crypto-key')).toBeNull();
  });

  it('fails closed without cross-tab locking and preserves stored history', async () => {
    const corrupted = 'not-valid-encrypted-data';
    localStorage.setItem(STORAGE_KEY, corrupted);
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    });

    await expect(decryptLocalMeasurements()).rejects.toThrow(
      'Cross-tab local history coordination is unavailable',
    );
    expect(localStorage.getItem(STORAGE_KEY)).toBe(corrupted);
    expect(localStorage.getItem('bb-crypto-key')).toBeNull();
  });
});
