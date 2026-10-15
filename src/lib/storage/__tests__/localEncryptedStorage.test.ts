import { describe, expect, it, beforeAll } from 'vitest';
import {
  decryptLocal,
  encryptLocal,
  getOrCreateLocalKey,
} from '../localEncryptedStorage';

/**
 * Semantic honesta verificada aquí: si el entorno permite cifrar (crypto.subtle),
 * el roundtrip funciona y un payload inválido degrada a null — nunca inventa
 * datos. Sin crypto.subtle, encryptLocal devuelve null (no guardar en plano).
 */
describe('localEncryptedStorage', () => {
  beforeAll(() => {
    if (typeof localStorage === 'undefined') {
      (globalThis as unknown as { localStorage: Storage }).localStorage = {
        store: {} as Record<string, string>,
        getItem(key: string) { return this.store[key] ?? null; },
        setItem(key: string, value: string) { this.store[key] = value; },
        removeItem(key: string) { delete this.store[key]; },
        clear() { this.store = {}; },
        key() { return null; },
        length: 0,
      } as unknown as Storage;
    }
    localStorage.clear();
  });

  it('roundtrip cifra y descifra fielmente', async () => {
    const key = await getOrCreateLocalKey('test-key-1');
    if (!key) {
      // Entorno sin crypto.subtle (jsdom antiguo): comportamiento esperado es null.
      expect(await encryptLocal(null as unknown as CryptoKey, { a: 1 })).toBeNull();
      return;
    }
    const payload = { measurements: [{ hr: 72, spo2: 98 }], n: 2 };
    const encrypted = await encryptLocal(key, payload);
    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toContain('72'); // no plano
    const decrypted = await decryptLocal<typeof payload>(key, encrypted!);
    expect(decrypted).toEqual(payload);
  });

  it('payload corrupto o clave incorrecta → null (no datos inventados)', async () => {
    const key = await getOrCreateLocalKey('test-key-2');
    if (!key) return;
    const encrypted = await encryptLocal(key, { secret: true });
    expect(encrypted).toBeTruthy();
    const otherKey = await getOrCreateLocalKey('test-key-3');
    expect(otherKey).toBeTruthy();
    const wrong = await decryptLocal(otherKey!, encrypted!);
    expect(wrong).toBeNull();
    const garbage = await decryptLocal(key, 'bm90LWEtcmVhbC1wYXlsb2Fk');
    expect(garbage).toBeNull();
  });

  it('la clave persiste entre llamadas (mismo storageKey → misma clave)', async () => {
    const a = await getOrCreateLocalKey('test-key-4');
    const b = await getOrCreateLocalKey('test-key-4');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    const raw = localStorage.getItem('test-key-4');
    expect(raw).toBeTruthy();
    // No comparamos CryptoKey directamente (opaco); verificamos vía roundtrip.
    if (a && b) {
      const enc = await encryptLocal(a, [1, 2, 3]);
      const dec = await decryptLocal<number[]>(b, enc!);
      expect(dec).toEqual([1, 2, 3]);
    }
  });
});
