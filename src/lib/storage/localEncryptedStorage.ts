/**
 * Almacenamiento local CIFRADO (AES-GCM) compartido.
 *
 * SEMÁNTICA HONESTA (léase antes de usar): es OFUSCACIÓN LOCAL, no almacenamiento
 * seguro. La clave se genera en el dispositivo y se guarda en el propio
 * `localStorage` junto a los datos, y la semilla es derivable del perfil del
 * navegador. Protege de miradas casuales y de copias accidentales del store,
 * NO de acceso forense al dispositivo. Nunca presentarlo como seguro.
 *
 * Solo `crypto.subtle` (Contexto seguro: https o localhost). Si no está
 * disponible, los callers deben degradar a "no guardar" en vez de guardar plano.
 */

const IV_LENGTH = 12;

/** Copia a un Uint8Array con buffer propio (tipado ArrayBuffer para crypto.subtle). */
function toBytes(source: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(source.length);
  out.set(source);
  return out;
}

async function importKey(keyData: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  // Acepta claves heredadas de 16 B (AES-128) y nuevas de 32 B (AES-256).
  return crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Obtiene (o crea) la clave local asociada a `keyStorageKey`. Misma derivación
 * para todos los stores: semilla estable del dispositivo → SHA-256 → 32 B.
 */
export async function getOrCreateLocalKey(keyStorageKey: string): Promise<CryptoKey | null> {
  if (typeof localStorage === 'undefined' || !crypto?.subtle) return null;
  const raw = localStorage.getItem(keyStorageKey);
  if (raw) {
    try {
      const keyData = toBytes(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)));
      return await importKey(keyData);
    } catch {
      // Clave corrupta: se regenera (los datos previos quedan ilegibles).
      localStorage.removeItem(keyStorageKey);
    }
  }
  const seed = `${navigator.userAgent}${navigator.language}bio-beat-local-v1:${keyStorageKey}`;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  const keyData = new Uint8Array(hash).slice(0, 32);
  try {
    localStorage.setItem(keyStorageKey, btoa(String.fromCharCode(...keyData)));
  } catch {
    return null;
  }
  return importKey(keyData);
}

/** Cifra `data` como base64(iv || ciphertext). null si el entorno no permite cifrar. */
export async function encryptLocal(key: CryptoKey, data: unknown): Promise<string | null> {
  if (!crypto?.subtle) return null;
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Descifra un payload base64(iv || ciphertext). Devuelve null si la clave no
 * abre el dato (payload corrupto o clave regenerada) — el caller degrada a
 * lista vacía, nunca a datos inventados.
 */
export async function decryptLocal<T>(key: CryptoKey, raw: string): Promise<T | null> {
  if (!crypto?.subtle) return null;
  try {
    const combined = toBytes(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)));
    if (combined.length <= IV_LENGTH) return null;
    const iv = combined.slice(0, IV_LENGTH);
    const ciphertext = combined.slice(IV_LENGTH);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(decrypted)) as T;
  } catch {
    // Base64 inválido, clave incorrecta, payload corrupto o truncado →
    // ilegible. El caller degrada a vacío (regla "sin lectura" sobre falsa).
    return null;
  }
}
