// Everything saved on disk goes through here. The seed and wallet data are only ever stored encrypted with a key made from the password.
const DB = 'walnero';
const STORE = 'kv';
export const PBKDF2_ITERATIONS = 1_000_000;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvGet<T = any>(key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export interface Sealed { iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> }

export async function seal(key: CryptoKey, bytes: Uint8Array<ArrayBuffer>): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, ct: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)) };
}

export async function unseal(key: CryptoKey, sealed: Sealed): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, key, sealed.ct));
}

export const sealJson = (key: CryptoKey, value: unknown) => seal(key, new TextEncoder().encode(JSON.stringify(value)));
export const unsealJson = async <T>(key: CryptoKey, sealed: Sealed): Promise<T> => JSON.parse(new TextDecoder().decode(await unseal(key, sealed)));
