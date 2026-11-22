// How does the scanner scale across cores? Same work, 1 to N worker threads, each with its own copy of the module.
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { encodeChunk } from '../src/format.mjs';

const WASM = new URL('../../extension/scan-wasm/target/wasm32-unknown-unknown/release/walnero_scan.wasm', import.meta.url);

if (!isMainThread) {
  const { instance } = await WebAssembly.instantiate(workerData.wasm, {});
  const x = instance.exports;
  const put = (bytes) => { const p = x.alloc(bytes.length); new Uint8Array(x.memory.buffer).set(bytes, p); return p; };
  const view = put(workerData.view);
  const table = x.alloc(32);
  x.make_table(view, put(workerData.spend), 1, 1, table);
  x.set_keys(view, table, 1, x.alloc(4), 0);
  const chunk = put(workerData.chunk);
  const out = x.alloc(12000);
  // Warm up so the JIT has finished before the clock starts.
  x.scan_chunk(chunk, workerData.chunk.length, out, 1000);
  parentPort.postMessage('ready');
  parentPort.on('message', () => {
    const t = performance.now();
    for (let i = 0; i < workerData.rounds; i++) x.scan_chunk(chunk, workerData.chunk.length, out, 1000);
    parentPort.postMessage(performance.now() - t);
  });
} else {
  const require = createRequire(new URL('../../extension/package.json', import.meta.url));
  const sodium = require('libsodium-wrappers-sumo');
  await sodium.ready;
  const N = 2000, ROUNDS = 6;
  const txs = [];
  for (let i = 0; i < N; i++) {
    txs.push({
      keys: [sodium.crypto_scalarmult_ed25519_base_noclamp(sodium.crypto_core_ed25519_scalar_random())],
      outs: Array.from({ length: i % 5 === 0 ? 3 : 2 }, () => ({ tag: sodium.randombytes_uniform(256), key: sodium.randombytes_buf(32) })),
      images: [sodium.randombytes_buf(8)],
    });
  }
  const chunk = encodeChunk(0, [txs]);
  const wasm = fs.readFileSync(WASM);
  const view = new Uint8Array(32); view.set(sodium.randombytes_buf(31)); view[31] = 0x0c;
  const spend = sodium.crypto_scalarmult_ed25519_base_noclamp(sodium.crypto_core_ed25519_scalar_random());
  const logical = os.cpus().length;
  const results = {};
  for (const count of [1, 2, 4, 6, 8, 10, 12, 14, logical].filter((c, i, a) => c <= logical && a.indexOf(c) === i)) {
    const workers = Array.from({ length: count }, () => new Worker(new URL(import.meta.url), { workerData: { wasm, view, spend, chunk, rounds: ROUNDS } }));
    await Promise.all(workers.map((w) => new Promise((res) => w.once('message', res))));
    const t = performance.now();
    await Promise.all(workers.map((w) => new Promise((res) => { w.once('message', res); w.postMessage('go'); })));
    const seconds = (performance.now() - t) / 1000;
    const rate = (count * N * ROUNDS) / seconds;
    results[count] = Math.round(rate);
    console.log(`${String(count).padStart(2)} threads: ${Math.round(rate).toLocaleString()} tx/s, 1 million in ${(1e6 / rate).toFixed(1)} s`);
    await Promise.all(workers.map((w) => w.terminate()));
  }
  fs.writeFileSync(new URL('wasm-cores-result.json', import.meta.url), JSON.stringify({ cpu: os.cpus()[0].model, logical, results }, null, 1));
  process.exit(0);
}
