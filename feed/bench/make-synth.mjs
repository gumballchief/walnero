// A month of mainnet-sized traffic for the speed test: 30 daily files with the real measured shape (33,865 transactions a day,
// 2.19 outputs, 1.63 inputs, 7% with per-output keys), plus real payments hidden in them. Random data, no real wallets.
// Then serves it, because the browser test reads it the same way it reads the real feed.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
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

const OUT = path.resolve(import.meta.dirname, '../data/synth');
const DAYS = 30, TX_PER_DAY = 33865, BLOCKS = 720, START = 3600000;
fs.mkdirSync(OUT, { recursive: true });

const toLE = (n) => { const out = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { out[i] = Number(v & 255n); v >>= 8n; } return out; };
const fromLE = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
const randScalar = () => { let n = 0n; for (const b of sodium.randombytes_buf(64)) n = (n << 8n) | BigInt(b); return n % L; };
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const varint = (n) => { const o = []; while (n >= 0x80) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } o.push(n); return Uint8Array.from(o); };
const Hs = (...parts) => fromLE(keccak_256(concat(...parts))) % L;
const VIEW_TAG = new TextEncoder().encode('view_tag');
const hex = (b) => Buffer.from(b).toString('hex');
const point = () => sodium.crypto_scalarmult_ed25519_base_noclamp(sodium.crypto_core_ed25519_scalar_random());

const view = randScalar();
const spendPub = G.multiply(randScalar());
const viewBytes = toLE(view);

const randomTx = (miner = false) => {
  const nOut = miner ? 1 : 2 + (Math.random() < 0.19 ? 1 : 0);
  const nIn = miner ? 0 : 1 + (Math.random() < 0.5 ? 1 : 0) + (Math.random() < 0.13 ? 1 : 0);
  const tx = {
    keys: [point()],
    outs: Array.from({ length: nOut }, () => ({ tag: sodium.randombytes_uniform(256), key: sodium.randombytes_buf(32) })),
    images: Array.from({ length: nIn }, () => sodium.randombytes_buf(8)),
  };
  if (!miner && Math.random() < 0.07) tx.extras = Array.from({ length: nOut }, point);
  return tx;
};

// One day's random transactions are reused across files. The scanner caches nothing between them, so the work is the same.
console.log('making transactions');
const base = Array.from({ length: BLOCKS }, () => [randomTx(true)]);
for (let i = BLOCKS; i < TX_PER_DAY; i++) base[Math.floor(Math.random() * BLOCKS)].push(randomTx());

const pay = (index = 0) => {
  const r = randScalar();
  const R = G.multiply(r);
  const D = R.multiply(view).multiply(8n).toBytes();
  const tx = { keys: [R.toBytes()], outs: [{ tag: sodium.randombytes_uniform(256), key: sodium.randombytes_buf(32) }, { tag: sodium.randombytes_uniform(256), key: sodium.randombytes_buf(32) }], images: [sodium.randombytes_buf(8)] };
  tx.outs[index] = { tag: keccak_256(concat(VIEW_TAG, D, varint(index)))[0], key: G.multiply(Hs(D, varint(index))).add(spendPub).toBytes() };
  return tx;
};

const planted = [];
for (let day = 0; day < DAYS; day++) {
  const blocks = base.map((b) => b.slice());
  const hide = day % 3 === 0 ? 2 : 0; // Someone gets a couple of payments on some days.
  for (let k = 0; k < hide; k++) {
    const block = 1 + Math.floor(Math.random() * (BLOCKS - 1));
    const list = blocks[block];
    if (list.length < 2) { list.push(pay(k % 2)); planted.push(`${START + day * BLOCKS + block}:${list.length - 1}`); continue; }
    const tx = 1 + Math.floor(Math.random() * (list.length - 1));
    list[tx] = pay(k % 2);
    planted.push(`${START + day * BLOCKS + block}:${tx}`);
  }
  fs.writeFileSync(path.join(OUT, `d-${START + day * BLOCKS}.bin`), encodeChunk(START + day * BLOCKS, blocks));
}
const size = fs.readdirSync(OUT).filter((f) => f.endsWith('.bin')).reduce((sum, f) => sum + fs.statSync(path.join(OUT, f)).size, 0);
fs.writeFileSync(path.join(OUT, 'keys.json'), JSON.stringify({ view: hex(viewBytes), spend: hex(spendPub.toBytes()), planted: [...new Set(planted)], start: START, days: DAYS, blocks: BLOCKS, txPerDay: TX_PER_DAY, bytes: size }));
console.log(`${DAYS} files, ${(size / 1048576).toFixed(0)} MB, ${planted.length} payments hidden, ${(size / (DAYS * TX_PER_DAY)).toFixed(0)} bytes per transaction`);

http.createServer((req, res) => {
  const name = path.basename(new URL(req.url, 'http://x').pathname);
  res.setHeader('Access-Control-Allow-Origin', '*');
  const file = path.join(OUT, name);
  if (!fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
  fs.createReadStream(file).pipe(res);
}).listen(8788, '127.0.0.1', () => console.log('serving on http://127.0.0.1:8788'));
