// Storage for the iPhone app. Everything the wallet saves (already encrypted with the password key) goes to the app's own
// files through the native side, not to the web view's storage, which iOS can clear. Off the phone (testing on a computer)
// it falls back to the extension's IndexedDB storage.
import { kvGet as idbGet, kvSet as idbSet } from '../src/wallet/vault';

export { PBKDF2_ITERATIONS, deriveKey, seal, unseal, sealJson, unsealJson, type Sealed } from '../src/wallet/vault';

const bridge: { postMessage(body: unknown): Promise<string | null> } | undefined = (globalThis as any).webkit?.messageHandlers?.kv;
// The real wallet and the test-network wallet live side by side: test-network keys get their own prefix. The real wallet's
// keys keep their names, so a wallet made before the switch existed is still found.
const PREFIX = (globalThis as any).__walneroNet === 'stagenet' ? 'test-' : '';

const toB64 = (bytes: Uint8Array) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(text);
};
const fromB64 = (text: string) => {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
};
const encode = (value: unknown) => JSON.stringify(value, (_key, v) => {
  if (v instanceof Uint8Array) return { $b: toB64(v) };
  if (v instanceof ArrayBuffer) return { $a: toB64(new Uint8Array(v)) };
  return v;
});
const decode = (text: string) => JSON.parse(text, (_key, v) => {
  if (v && typeof v === 'object' && typeof v.$b === 'string') return fromB64(v.$b);
  if (v && typeof v === 'object' && typeof v.$a === 'string') return fromB64(v.$a).buffer;
  return v;
});

// The extension keeps a key that can't be exported in IndexedDB, to seal the scan keys so scanning can start before the
// password is typed. Here its bytes live in the app's files instead (sandboxed, encrypted by iOS while the phone is locked).
async function deviceKey(): Promise<CryptoKey> {
  let raw = await bridge!.postMessage({ op: 'get', key: 'device-raw' });
  if (!raw) {
    raw = toB64(crypto.getRandomValues(new Uint8Array(32)));
    await bridge!.postMessage({ op: 'set', key: 'device-raw', value: raw });
  }
  return crypto.subtle.importKey('raw', fromB64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function kvGet<T = any>(key: string): Promise<T | undefined> {
  if (!bridge) return idbGet<T>(PREFIX + key);
  if (key === 'device') return (await deviceKey()) as T;
  const text = await bridge.postMessage({ op: 'get', key: PREFIX + key });
  return text == null ? undefined : (decode(text) as T);
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  if (!bridge) return idbSet(PREFIX + key, value);
  if (key === 'device') return; // made and kept by deviceKey()
  await bridge.postMessage({ op: 'set', key: PREFIX + key, value: encode(value) });
}
