// Proves the Rust scanner: exact against an independent library, finds every hidden payment, and how fast it runs.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { encodeChunk } from '../src/format.mjs';

const require = createRequire(new URL('../../extension/package.json', import.meta.url));
const sodium = require('libsodium-wrappers-sumo');
await sodium.ready;
const { ed25519 } = await import(new URL('../../extension/node_modules/@noble/curves/ed25519.js', import.meta.url).href);
const { keccak_256 } = await import(new URL('../../extension/node_modules/@noble/hashes/sha3.js', import.meta.url).href);
const Point = ed25519.Point;
const L = Point.Fn.ORDER;
const G = Point.BASE;

const wasm = fs.readFileSync(new URL('../../extension/scan-wasm/target/wasm32-unknown-unknown/release/walnero_scan.wasm', import.meta.url));
const load = async () => {
  const { instance } = await WebAssembly.instantiate(wasm, {});
  const x = instance.exports;
  return { x, put(bytes) { const p = x.alloc(bytes.length); new Uint8Array(x.memory.buffer).set(bytes, p); return p; }, read(p, n) { return new Uint8Array(x.memory.buffer).slice(p, p + n); } };
};
const hex = (b) => Buffer.from(b).toString('hex');
const toLE = (n) => { const out = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { out[i] = Number(v & 255n); v >>= 8n; } return out; };
const fromLE = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
const randScalar = () => { let n = 0n; for (const b of sodium.randombytes_buf(64)) n = (n << 8n) | BigInt(b); return n % L; };
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const varint = (n) => { const o = []; while (n >= 0x80) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } o.push(n); return Uint8Array.from(o); };
const Hs = (...parts) => fromLE(keccak_256(concat(...parts))) % L;
const VIEW_TAG = new TextEncoder().encode('view_tag');

let torsion;
for (let seed = 1n; !torsion; seed++) {
  try {
    const start = Point.fromBytes(sodium.crypto_generichash(32, toLE(seed)));
    const c = start.multiplyUnsafe(L - 1n).add(start);
    if (!c.is0() && !c.double().is0() && !c.double().double().is0()) torsion = c;
  } catch { /* not a curve point */ }
}

function setKeys(m, a, spendPub, majors = 1, minors = 8) {
  const view = m.put(toLE(a));
  const spend = m.put(spendPub.toBytes());
  const table = m.x.alloc(majors * minors * 32);
  const n = m.x.make_table(view, spend, majors, minors, table);
  const ki = m.x.alloc(4);
  return { fast: m.x.set_keys(view, table, n, ki, 0), n };
}

// Part 1: exactness.
let wrong = 0, checked = 0;
const big = [], small = [];
while (big.length < 4 || small.length < 4) {
  const a = randScalar();
  if (a >= 1n << 251n && big.length < 4) big.push(a);
  if (a < 1n << 251n && small.length < 4) small.push(a);
}
const LOW_ORDER = ['0100000000000000000000000000000000000000000000000000000000000000', 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', '0000000000000000000000000000000000000000000000000000000000000000', '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', 'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'].map((h) => Uint8Array.from(Buffer.from(h, 'hex')));
for (const a of [...big, ...small]) {
  const m = await load();
  const spendPub = G.multiply(randScalar());
  const { fast } = setKeys(m, a, spendPub);
  if (!fast) { console.log('  fast path refused, self test failed'); wrong++; continue; }
  const keyPtr = m.x.alloc(64), outPtr = keyPtr + 32;
  const derive = (bytes) => { new Uint8Array(m.x.memory.buffer).set(bytes, keyPtr); m.x.test_derive(keyPtr, outPtr); return m.read(outPtr, 32); };
  for (let i = 0; i < 300; i++) {
    const R = i % 3 === 2 ? G.multiply(randScalar()).add(torsion) : G.multiply(randScalar());
    const want = R.multiplyUnsafe(a).multiplyUnsafe(8n).toBytes();
    want[31] &= 0x7f;
    if (hex(derive(R.toBytes())) !== hex(want)) wrong++;
    checked++;
  }
  for (const low of LOW_ORDER) {
    const got = derive(low);
    if (hex(got) !== '01' + '00'.repeat(31)) { wrong++; console.log('  low order wrong', hex(low), hex(got)); }
    checked++;
  }
}
console.log(`exactness: ${checked} checked, ${wrong} wrong`);

// Part 2: a chunk with hidden payments among random transactions, all shapes at once.
const a = big[0];
const spendSecret = randScalar();
const B = G.multiply(spendSecret);
const m = await load();
const { n: tableSize } = setKeys(m, a, B, 1, 8);
const A = G.multiply(a);
const sub = (minor) => B.add(G.multiply(Hs(new TextEncoder().encode('SubAddr\0'), toLE(a), new Uint8Array(4), Uint8Array.from([minor, 0, 0, 0]))));
const randomTx = (nOut = 2) => ({
  keys: [sodium.crypto_scalarmult_ed25519_base_noclamp(sodium.crypto_core_ed25519_scalar_random())],
  outs: Array.from({ length: nOut }, () => ({ tag: sodium.randombytes_uniform(256), key: sodium.randombytes_buf(32) })),
  images: Array.from({ length: 2 }, () => sodium.randombytes_buf(8)),
});
const payTo = (Bdest, viewPub, index, nOut) => {
  const r = randScalar();
  const tx = randomTx(nOut);
  const isSub = Bdest !== B;
  const Rp = isSub ? Bdest.multiply(r) : G.multiply(r);
  const D = Rp.multiply(a).multiply(8n).toBytes();
  tx.keys = [Rp.toBytes()];
  tx.outs[index] = { tag: keccak_256(concat(VIEW_TAG, D, varint(index)))[0], key: G.multiply(Hs(D, varint(index))).add(Bdest).toBytes() };
  return tx;
};
const payExtra = (Bdest, viewPub, index, nOut) => {
  const tx = randomTx(nOut);
  tx.extras = Array.from({ length: nOut }, () => sodium.crypto_scalarmult_ed25519_base_noclamp(sodium.crypto_core_ed25519_scalar_random()));
  const r = randScalar();
  const Re = Bdest.multiply(r);
  tx.extras[index] = Re.toBytes();
  const D = Re.multiply(a).multiply(8n).toBytes();
  tx.outs[index] = { tag: keccak_256(concat(VIEW_TAG, D, varint(index)))[0], key: G.multiply(Hs(D, varint(index))).add(Bdest).toBytes() };
  return tx;
};
const payUntagged = (index, nOut) => {
  const tx = payTo(B, A, index, nOut);
  tx.outs = tx.outs.map((o) => ({ key: o.key }));
  return tx;
};
const BLOCKS = 200, PER_BLOCK = 20;
const blocks = Array.from({ length: BLOCKS }, () => Array.from({ length: PER_BLOCK }, () => randomTx()));
const planted = [];
const plant = (block, tx, value) => { blocks[block][tx] = value; planted.push(`${block}:${tx}`); };
plant(0, 0, payTo(B, A, 0, 2));
plant(3, 19, payTo(B, A, 1, 2));
plant(50, 7, payTo(sub(1), A, 0, 2));
plant(51, 7, payExtra(sub(3), A, 1, 3));
plant(77, 2, payUntagged(1, 2));
plant(120, 0, payTo(B, A, 130, 131)); // A miner-style transaction with many outputs, varint index above 127.
plant(199, 19, payTo(sub(7), A, 1, 2));
const chunk = encodeChunk(1000, blocks);
const outCap = 4096;
const out = m.x.alloc(outCap * 12);
const chunkPtr = m.put(chunk);
const found = m.x.scan_chunk(chunkPtr, chunk.length, out, outCap, m.x.alloc(4 * (BLOCKS * 2 + 1)));
if (found < 0) console.log('scan failed with', found);
const hits = new Uint32Array(m.x.memory.buffer, out, Math.max(found, 0) * 3);
const foundSet = new Set();
for (let i = 0; i < found; i++) foundSet.add(`${hits[i * 3]}:${hits[i * 3 + 1]}`);
const missed = planted.filter((p) => !foundSet.has(p));
const extra = [...foundSet].filter((p) => !planted.includes(p));
console.log(`hidden payments: ${planted.length} planted among ${BLOCKS * PER_BLOCK} transactions, table ${tableSize}; found ${foundSet.size}, missed ${missed.length}, false ${extra.length}`);
if (missed.length) console.log('  missed:', missed.join(' '));
if (extra.length) console.log('  false:', extra.join(' '));

// Part 3: a coin we hold gets spent.
{
  const spent = sodium.randombytes_buf(8);
  const m2 = await load();
  const view = m2.put(toLE(a));
  const table = m2.x.alloc(32);
  const nTab = m2.x.make_table(view, m2.put(B.toBytes()), 1, 1, table);
  const kiPtr = m2.put(spent.subarray(0, 4));
  m2.x.set_keys(view, table, nTab, kiPtr, 1);
  const spender = randomTx();
  spender.images[1] = spent;
  const c = encodeChunk(5, [[randomTx(), spender, randomTx()]]);
  const o = m2.x.alloc(1200);
  const count = m2.x.scan_chunk(m2.put(c), c.length, o, 100, m2.x.alloc(64));
  const h = new Uint32Array(m2.x.memory.buffer, o, count * 3);
  console.log(`spend detection: ${count} hit, block ${h[0]} tx ${h[1]} kind ${h[2]} (want 1 hit, 0 1 1)`);
}

// Part 4: speed, one core, real curve points with the real average shape.
const N = 40000;
const speedTxs = [];
for (let i = 0; i < N; i++) {
  speedTxs.push({
    keys: [sodium.crypto_scalarmult_ed25519_base_noclamp(sodium.crypto_core_ed25519_scalar_random())],
    outs: Array.from({ length: i % 5 === 0 ? 3 : 2 }, () => ({ tag: sodium.randombytes_uniform(256), key: sodium.randombytes_buf(32) })),
    images: [sodium.randombytes_buf(8)],
  });
}
const big0 = encodeChunk(0, [speedTxs]);
const sm = await load();
let t0 = performance.now();
const tableInfo = setKeys(sm, a, B, 50, 200);
console.log(`table of ${tableInfo.n} keys built in ${(performance.now() - t0).toFixed(0)} ms`);
const pp = sm.put(big0);
const op = sm.x.alloc(12000);
const perBlock = sm.x.alloc(64);
const bare = encodeChunk(0, [speedTxs.map((t) => ({ keys: t.keys, outs: [], images: [] }))]);
const bp = sm.put(bare);
for (let r = 0; r < 2; r++) {
  const t = performance.now();
  sm.x.scan_chunk(bp, bare.length, op, 1000, perBlock);
  console.log(`maths only, no tag checks: ${((1e6 * (performance.now() - t) / 1000) / N).toFixed(1)} us each`);
}
for (let r = 0; r < 4; r++) {
  const t = performance.now();
  sm.x.scan_chunk(pp, big0.length, op, 1000, perBlock);
  const s = (performance.now() - t) / 1000;
  console.log(`run ${r + 1}: ${(N / s).toFixed(0)} tx/s on one core (${((1e6 * s) / N).toFixed(1)} us each, ${(big0.length / N).toFixed(0)} bytes per tx)`);
}
process.exit(wrong || missed.length || extra.length ? 1 : 0);
