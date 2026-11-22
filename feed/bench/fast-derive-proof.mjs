// Is the fast route exactly right, and how much faster is it? Compares against a slow, independent reference on random keys,
// on tiny view keys that force the negated path, and on keys laced with torsion, which a hostile sender could craft.
import { createRequire } from 'node:module';
import { ladderScalar, deriveBatch, viewTag } from '../../extension/src/wallet/scan-core.ts';

const require = createRequire(new URL('../../extension/package.json', import.meta.url));
const sodium = require('libsodium-wrappers-sumo');
await sodium.ready;
const { ed25519 } = await import(new URL('../../extension/node_modules/@noble/curves/ed25519.js', import.meta.url).href);
const Point = ed25519.Point;
const L = Point.Fn.ORDER;
const G = Point.BASE;
const hex = (b) => Buffer.from(b).toString('hex');
const toLE = (n) => { const out = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { out[i] = Number(v & 255n); v >>= 8n; } return out; };
const randScalar = () => { let n = 0n; for (const b of sodium.randombytes_buf(64)) n = (n << 8n) | BigInt(b); return n % L; };

const ladder = { multiply: (k, u) => { try { return sodium.crypto_scalarmult(k, u); } catch { return null; } } };

// Reference: Monero's definition, computed the slow way with an unrelated library.
const reference = (a, R) => R.multiplyUnsafe(a).multiplyUnsafe(8n);

// A point of order 8, to add torsion. Found by clearing the prime-order part of a random point.
let torsion;
for (let seed = 1n; !torsion; seed++) {
  try {
    const start = Point.fromBytes(sodium.crypto_generichash(32, toLE(seed)));
    const candidate = start.multiplyUnsafe(L - 1n).add(start);
    if (!candidate.is0() && !candidate.double().is0() && !candidate.double().double().is0()) torsion = candidate;
  } catch { /* not a curve point */ }
}

function check(label, viewScalars, makeKey, rounds) {
  let good = 0, bad = 0, tagChecked = 0;
  for (const a of viewScalars) {
    const k = ladderScalar(toLE(a));
    if (!k) { console.log('  scalar did not fit'); bad++; continue; }
    const keys = new Uint8Array(rounds * 32);
    const Rs = [];
    for (let i = 0; i < rounds; i++) { const R = makeKey(); Rs.push(R); keys.set(R.toBytes(), i * 32); }
    const out = deriveBatch(ladder, k, keys, rounds);
    for (let i = 0; i < rounds; i++) {
      const want = reference(a, Rs[i]).toBytes();
      const y = out.subarray(i * 32, i * 32 + 32);
      const sign = (want[31] & 0x80) !== 0;
      const got = y.slice(); if (sign) got[31] |= 0x80;
      if (hex(got) === hex(want)) good++; else bad++;
      const realTag = viewTag(want, 0, false, i);
      const fastTag = viewTag(y, 0, sign, i);
      if (realTag === fastTag) tagChecked++; else bad++;
    }
  }
  console.log(`${label}: ${good} exact, ${bad} wrong, ${tagChecked} view tags agree`);
  return bad;
}

const randomKey = () => G.multiply(randScalar());
const big = [];
const small = [];
while (big.length < 5 || small.length < 5) {
  const a = randScalar();
  if (a >= 1n << 251n && big.length < 5) big.push(a);
  if (a < 1n << 251n && small.length < 5) small.push(a);
}
let wrong = 0;
wrong += check('view key in the direct range', big, randomKey, 200);
wrong += check('view key in the negated range', small, randomKey, 200);
wrong += check('tx keys with torsion added', [...big, ...small], () => randomKey().add(torsion), 100);
console.log(wrong === 0 ? 'ALL EXACT' : `WRONG: ${wrong}`);

// Speed: real work per transaction, 2.2 outputs and both sign candidates.
const a = big[0];
const viewBytes = toLE(a);
const k = ladderScalar(viewBytes);
const N = 3000;
const keys = new Uint8Array(N * 32);
for (let i = 0; i < N; i++) keys.set(sodium.crypto_scalarmult_ed25519_base_noclamp(sodium.crypto_core_ed25519_scalar_random()), i * 32);
const raw = sodium.libsodium;
const rawLadder = (() => {
  const nPtr = raw._malloc(32), pPtr = raw._malloc(32), qPtr = raw._malloc(32);
  const out = new Uint8Array(32);
  return { multiply(s, u) {
    raw.HEAPU8.set(s, nPtr); raw.HEAPU8.set(u, pPtr);
    if (raw._crypto_scalarmult_curve25519(qPtr, nPtr, pPtr) !== 0) return null;
    out.set(raw.HEAPU8.subarray(qPtr, qPtr + 32));
    return out;
  } };
})();
const time = (label, fn) => {
  const runs = [];
  for (let r = 0; r < 5; r++) { const t = performance.now(); fn(); runs.push(N / ((performance.now() - t) / 1000)); }
  runs.sort((x, y) => x - y);
  console.log(`${label}: ${Math.round(runs[2])} tx/s`);
  return runs[2];
};
const tags = (y, i) => { let hits = 0; for (let o = 0; o < 2; o++) { for (const s of [false, true]) if (viewTag(y, i * 32, s, o) === 0) hits++; } return hits; };
const oldWay = time('old way (safety-checked ed25519)', () => {
  for (let i = 0; i < N; i++) {
    let D = sodium.crypto_scalarmult_ed25519_noclamp(viewBytes, keys.subarray(i * 32, i * 32 + 32));
    for (let d = 0; d < 3; d++) D = sodium.crypto_core_ed25519_add(D, D);
    for (let o = 0; o < 2; o++) viewTag(D, 0, false, o);
  }
});
const wrapped = time('ladder through the normal wrapper', () => { const y = deriveBatch(ladder, k, keys, N); for (let i = 0; i < N; i++) tags(y, i); });
const direct = time('ladder calling WebAssembly directly', () => { const y = deriveBatch(rawLadder, k, keys, N); for (let i = 0; i < N; i++) tags(y, i); });
console.log(`speedup: ${(direct / oldWay).toFixed(1)}x (wrapper ${(wrapped / oldWay).toFixed(1)}x)`);
process.exit(0);
