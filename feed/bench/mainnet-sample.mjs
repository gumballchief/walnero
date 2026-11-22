// The real thing, read-only: real Monero blocks turned into feed files, checked against the chain the way the wallet checks them,
// then scanned with a throwaway random key. No wallet, no real keys, no money. Answers what the test network can't: real size
// including P2Pool miner transactions, and whether every real transaction parses.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { encodeChunk, txEntry } from '../src/format.mjs';

const NODES = ['http://node.monerodevs.org:18089', 'http://node2.monerodevs.org:18089', 'http://node3.monerodevs.org:18089'];
const BLOCKS = Number(process.argv[2] ?? 120);
const require = createRequire(new URL('../../extension/package.json', import.meta.url));
const sodium = require('libsodium-wrappers-sumo');
await sodium.ready;

const post = async (url, body) => {
  let failure;
  for (const node of NODES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${node}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        if (res.ok) return await res.json();
        failure = new Error(`${url} ${res.status}`);
      } catch (error) { failure = error; }
    }
  }
  throw failure;
};
const rpc = async (method, params = {}) => {
  const json = await post('/json_rpc', { jsonrpc: '2.0', id: '0', method, params });
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
};

const info = await rpc('get_info');
if (!info.mainnet) throw new Error('not mainnet');
const to = info.height - 3;
const from = to - BLOCKS + 1;
console.log(`mainnet height ${info.height}, reading ${BLOCKS} blocks from ${from}`);

const started = Date.now();
const blocks = new Array(BLOCKS);
let next = 0, minerOuts = 0, plainOuts = 0, extraTxs = 0, totalTxs = 0, biggestMiner = 0, noTag = 0;
await Promise.all(Array.from({ length: 2 }, async () => {
  while (next < BLOCKS) {
    const index = next++;
    const height = from + index;
    const block = await rpc('get_block', { height });
    const miner = txEntry(JSON.parse(block.json).miner_tx);
    const entries = [miner];
    minerOuts += miner.outs.length;
    biggestMiner = Math.max(biggestMiner, miner.outs.length);
    const hashes = block.tx_hashes ?? [];
    for (let i = 0; i < hashes.length; i += 100) {
      const reply = await post('/get_transactions', { txs_hashes: hashes.slice(i, i + 100), decode_as_json: true, prune: true });
      const byHash = new Map((reply.txs ?? []).map((t) => [t.tx_hash, t]));
      for (const hash of hashes.slice(i, i + 100)) {
        const tx = byHash.get(hash);
        if (!tx) throw new Error(`no tx ${hash}`);
        const entry = txEntry(JSON.parse(tx.as_json));
        if (!entry.keys.length) console.log(`  tx ${hash} has no main key`);
        if (entry.outs.some((o) => o.tag === undefined)) noTag++;
        if (entry.extras.length) extraTxs++;
        plainOuts += entry.outs.length;
        totalTxs++;
        entries.push(entry);
      }
    }
    blocks[index] = entries;
  }
}));
console.log(`read in ${((Date.now() - started) / 1000).toFixed(0)} s`);

const chunk = encodeChunk(from, blocks);
const days = BLOCKS / 720;
console.log(`${totalTxs} transactions, ${BLOCKS} miner transactions; miner outputs ${minerOuts} (biggest ${biggestMiner}), normal outputs ${plainOuts}, ${extraTxs} with per-output keys, ${noTag} without view tags`);
const perDay = chunk.length / days;
console.log(`feed size ${(chunk.length / 1024).toFixed(0)} KB, ${(perDay / 1048576).toFixed(2)} MB a day, ${((perDay * 30) / 1048576).toFixed(0)} MB a month, ${(chunk.length / (totalTxs + BLOCKS)).toFixed(0)} bytes per transaction`);

const dist = await rpc('get_output_distribution', { amounts: [0], from_height: from, to_height: to, cumulative: false, binary: false, compress: false });
const real = dist.distributions[0];
let mismatched = 0;
blocks.forEach((entries, i) => {
  const told = entries.reduce((sum, tx) => sum + tx.outs.length, 0);
  if (real.distribution[i + (from - real.start_height)] !== told) { mismatched++; console.log(`  block ${from + i}: chain ${real.distribution[i + (from - real.start_height)]}, feed ${told}`); }
});
console.log(`outputs per block against the chain: ${BLOCKS - mismatched} of ${BLOCKS} match`);

const wasm = fs.readFileSync(new URL('../../extension/scan-wasm/walnero_scan.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm, {});
const x = instance.exports;
const put = (bytes) => { const p = x.alloc(bytes.length); new Uint8Array(x.memory.buffer).set(bytes, p); return p; };
const view = sodium.crypto_core_ed25519_scalar_random();
const spend = sodium.crypto_scalarmult_ed25519_base_noclamp(sodium.crypto_core_ed25519_scalar_random());
const viewPtr = put(view);
const table = x.alloc(32);
const made = x.make_table(viewPtr, put(spend), 1, 1, table);
const fast = x.set_keys(viewPtr, table, made, x.alloc(4), 0);
const chunkPtr = put(chunk);
const out = x.alloc(12000);
const perBlock = x.alloc(4 * (BLOCKS * 2 + 1));
for (let run = 0; run < 3; run++) {
  const t = performance.now();
  const hits = x.scan_chunk(chunkPtr, chunk.length, out, 1000, perBlock);
  const seconds = (performance.now() - t) / 1000;
  console.log(`scan with a throwaway key: ${hits} matches (should be 0), fast path ${fast}, ${((totalTxs + BLOCKS) / seconds).toFixed(0)} tx/s on one core`);
}
const fileOuts = new Uint32Array(x.memory.buffer, perBlock, BLOCKS);
console.log(`scanner's output counts match the chain: ${[...fileOuts].every((n, i) => n === real.distribution[i + (from - real.start_height)])}`);
process.exit(0);
