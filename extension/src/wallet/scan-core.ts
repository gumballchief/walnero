// The core of instant open: check which Monero transactions are ours, as fast as a browser can.
//
// Monero's shared secret is D = 8 * a * R, with a the view key and R the transaction's public key. The usual way to compute
// it spends most of its time on safety checks and re-encoding points. Instead this uses the X25519 ladder, which needs far
// fewer field operations and works on Montgomery u-coordinates:
//   - k = 8 * a is a valid clamped X25519 scalar when 2^251 <= a < 2^252. If a is below that, l - a is in range and gives -D,
//     which has the same u-coordinate.
//   - Multiplying by a multiple of 8 also clears torsion, exactly as Monero does.
//   - u loses only the sign of x, so each D has 2 candidates. Both get a view tag check, then the one-time key settles it.
import { keccak_256 } from '@noble/hashes/sha3.js';

const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const LOW = 1n << 251n;
const HIGH = 1n << 252n;

const bytesToBig = (b: Uint8Array, at = 0) => {
  const v = new DataView(b.buffer, b.byteOffset + at, 32);
  return v.getBigUint64(0, true) | (v.getBigUint64(8, true) << 64n) | (v.getBigUint64(16, true) << 128n) | (v.getBigUint64(24, true) << 192n);
};
const bigToBytes = (n: bigint, out: Uint8Array, at = 0) => {
  const v = new DataView(out.buffer, out.byteOffset + at, 32);
  v.setBigUint64(0, n & 0xffffffffffffffffn, true);
  v.setBigUint64(8, (n >> 64n) & 0xffffffffffffffffn, true);
  v.setBigUint64(16, (n >> 128n) & 0xffffffffffffffffn, true);
  v.setBigUint64(24, n >> 192n, true);
};
const pow = (base: bigint, exp: bigint) => {
  let r = 1n, b = base % P, e = exp;
  while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; }
  return r;
};

// Inverts many field elements for the price of one. Zeros stay zero and mark points to skip.
function invertAll(values: bigint[]): bigint[] {
  const out = new Array<bigint>(values.length);
  const running = new Array<bigint>(values.length);
  let acc = 1n;
  for (let i = 0; i < values.length; i++) { running[i] = acc; if (values[i] !== 0n) acc = (acc * values[i]) % P; }
  let inv = pow(acc, P - 2n);
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] === 0n) { out[i] = 0n; continue; }
    out[i] = (inv * running[i]) % P;
    inv = (inv * values[i]) % P;
  }
  return out;
}

/** Turns a Monero view key into the scalar for the ladder, or null in the 1-in-2^125 case it doesn't fit. */
export function ladderScalar(viewKey: Uint8Array): Uint8Array | null {
  const a = bytesToBig(viewKey);
  const fit = a >= LOW && a < HIGH ? a : L - a;
  if (fit < LOW || fit >= HIGH) return null;
  const k = new Uint8Array(32);
  bigToBytes(fit * 8n, k);
  return k;
}

export interface Ladder { multiply(scalar: Uint8Array, u: Uint8Array): Uint8Array | null }

/** The y-coordinates of D for a batch of tx public keys. The result is 32 bytes per key; an all-zero entry means skip it. */
export function deriveBatch(ladder: Ladder, scalar: Uint8Array, keys: Uint8Array, count: number): Uint8Array {
  const out = new Uint8Array(count * 32);
  const ys = new Array<bigint>(count);
  const dens = new Array<bigint>(count);
  for (let i = 0; i < count; i++) {
    const y = bytesToBig(keys, i * 32) & ((1n << 255n) - 1n);
    ys[i] = y % P;
    dens[i] = (1n - ys[i] + P) % P;
  }
  const denInv = invertAll(dens);
  const u = new Uint8Array(32);
  const results = new Array<bigint>(count);
  const plusOne = new Array<bigint>(count);
  for (let i = 0; i < count; i++) {
    results[i] = 0n; plusOne[i] = 0n;
    if (dens[i] === 0n) continue;
    bigToBytes((((1n + ys[i]) % P) * denInv[i]) % P, u);
    const q = ladder.multiply(scalar, u);
    if (!q) continue;
    const r = bytesToBig(q) & ((1n << 255n) - 1n);
    results[i] = r % P;
    plusOne[i] = (results[i] + 1n) % P;
  }
  const inv = invertAll(plusOne);
  for (let i = 0; i < count; i++) {
    if (plusOne[i] === 0n) continue;
    bigToBytes((((results[i] - 1n + P) % P) * inv[i]) % P, out, i * 32);
  }
  return out;
}

const TAG_PREFIX = new TextEncoder().encode('view_tag');
const tagBuffer = new Uint8Array(8 + 32 + 10);
tagBuffer.set(TAG_PREFIX);

export function varint(n: number, out: Uint8Array, at: number): number {
  let i = at, v = n;
  while (v >= 0x80) { out[i++] = (v & 0x7f) | 0x80; v = Math.floor(v / 128); }
  out[i++] = v;
  return i - at;
}

/** Monero's view tag: the first byte of Keccak("view_tag" || D || varint(output index)). */
export function viewTag(d: Uint8Array, dAt: number, signBit: boolean, index: number): number {
  tagBuffer.set(d.subarray(dAt, dAt + 32), 8);
  if (signBit) tagBuffer[39] |= 0x80;
  const size = 40 + varint(index, tagBuffer, 40);
  return keccak_256(tagBuffer.subarray(0, size))[0];
}

/** Hs(D || varint(i)) as a reduced scalar, the value Monero adds to the spend key for this output. */
export function outputScalar(d: Uint8Array, index: number, reduce: (x: Uint8Array) => Uint8Array): Uint8Array {
  const buf = new Uint8Array(32 + 10);
  buf.set(d);
  const size = 32 + varint(index, buf, 32);
  const wide = new Uint8Array(64);
  wide.set(keccak_256(buf.subarray(0, size)));
  return reduce(wide);
}
