// One 12-word phrase for the whole wallet (BIP39, the standard most wallets use), like Phantom's single recovery phrase.
// Monero's keys come out of it the way Cake Wallet and Exodus do it, so the same 12 words restore the same Monero wallet in
// either of them: the secp256k1 key at m/44'/128'/0'/0/0, read as a little-endian number and reduced to a Monero scalar,
// becomes the private spend key. Bitcoin and later coins come from the same phrase on their own standard paths.
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';

// The order of Monero's curve group: every private key is a number below it.
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

const clean = (phrase: string) => phrase.trim().toLowerCase().split(/\s+/).join(' ');

export const newPhrase = () => generateMnemonic(wordlist, 128);
export const isPhrase = (phrase: string) => validateMnemonic(clean(phrase), wordlist);
export const phraseWordCount = (phrase: string) => clean(phrase).split(' ').filter(Boolean).length;

// The root key every coin's keys are derived from. Slow on purpose (2048 rounds), so it's made once per use.
export async function rootKey(phrase: string): Promise<HDKey> {
  return HDKey.fromMasterSeed(await mnemonicToSeed(clean(phrase)));
}

// Monero's private spend key, as hex.
export function moneroSpendKey(root: HDKey, account = 0): string {
  const key = root.derive(`m/44'/128'/${account}'/0/0`).privateKey;
  if (!key) throw new Error("Couldn't make Monero keys from those words");
  let n = 0n;
  for (let i = key.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(key[i]!);
  n %= L;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
}

export { clean as cleanPhrase };
