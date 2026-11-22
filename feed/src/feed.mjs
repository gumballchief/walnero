// The scan feed: reads blocks from a Monero node, writes the small files wallets scan, and serves them.
// Static files only, the same for everyone. No accounts, no per-user requests, and the server never sees a key.
//
//   node feed/src/feed.mjs --node http://node.monerodevs.org:38089 --days 31 --port 8787 --out feed/data/stagenet [--once]
//
// Files: manifest.json, then d-<height>.bin (720 blocks), h-<height>.bin (30 blocks), b-<height>.bin (1 block).
// Wallets walk from where they stopped, always taking the biggest file that fits, so the file names give nothing away.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { encodeChunk, txEntry } from './format.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
// One server or several, comma separated. Several spreads the load, and a server that fails is skipped on the retry.
const NODES = arg('node', 'http://node.monerodevs.org:38089').split(',');
const NODE = NODES.join(', ');
let turn = 0;
const DAYS = Number(arg('days', 31));
const PORT = Number(arg('port', 8787));
const OUT = path.resolve(arg('out', 'feed/data/stagenet'));
const ONCE = process.argv.includes('--once');
const FROM = arg('from') ? Number(arg('from')) : null;
const CONCURRENCY = Number(arg('concurrency', 8));
const DAY = 720, HOUR = 30, BLOCKS_PER_DAY = 720;
// The chain tip can still reorganise, so the feed stops a little short and wallet2 reads the last few blocks itself.
const KEEP_BEHIND = 2;

fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'blocks.log');

async function post(url, body) {
  for (let attempt = 0; ; attempt++) {
    const node = NODES[turn++ % NODES.length];
    try {
      const res = await fetch(`${node}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`${url} ${res.status}`);
      return await res.json();
    } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}
const rpc = async (method, params = {}) => {
  const json = await post('/json_rpc', { jsonrpc: '2.0', id: '0', method, params });
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
};

async function fetchBlock(height) {
  const block = await rpc('get_block', { height });
  const parsed = JSON.parse(block.json);
  const entries = [txEntry(parsed.miner_tx)];
  const hashes = block.tx_hashes ?? [];
  for (let i = 0; i < hashes.length; i += 100) {
    const reply = await post('/get_transactions', { txs_hashes: hashes.slice(i, i + 100), decode_as_json: true, prune: true });
    const byHash = new Map((reply.txs ?? []).map((t) => [t.tx_hash, t]));
    for (const hash of hashes.slice(i, i + 100)) {
      const entry = byHash.get(hash);
      if (!entry) throw new Error(`node did not return tx ${hash}`);
      entries.push(txEntry(JSON.parse(entry.as_json)));
    }
  }
  return { hash: block.block_header.hash, entries };
}

// A block's body is its chunk minus the header and the tx-count table, so chunks can be stitched together cheaply.
const bodyOf = (entries, height) => {
  const chunk = encodeChunk(height, [entries]);
  return { txs: entries.length, bytes: chunk.subarray(18) };
};

const blocks = new Map(); // height -> { txs, bytes }
function readLog() {
  if (!fs.existsSync(LOG)) return;
  const log = fs.readFileSync(LOG);
  let at = 0;
  while (at + 12 <= log.length) {
    const height = log.readUInt32LE(at);
    const txs = log.readUInt32LE(at + 4);
    const size = log.readUInt32LE(at + 8);
    if (at + 12 + size > log.length) break;
    blocks.set(height, { txs, bytes: log.subarray(at + 12, at + 12 + size) });
    at += 12 + size;
  }
}
const logStream = () => fs.createWriteStream(LOG, { flags: 'a' });

function chunkBytes(start, count) {
  const parts = [];
  let total = 16 + count * 2, txCount = 0;
  for (let h = start; h < start + count; h++) {
    const block = blocks.get(h);
    parts.push(block);
    total += block.bytes.length;
    txCount += block.txs;
  }
  const out = Buffer.alloc(total);
  out.set([0x57, 0x4e, 0x46, 1]);
  out.writeUInt32LE(start, 4);
  out.writeUInt32LE(count, 8);
  out.writeUInt32LE(txCount, 12);
  let at = 16;
  for (const block of parts) { out.writeUInt16LE(block.txs, at); at += 2; }
  for (const block of parts) { out.set(block.bytes, at); at += block.bytes.length; }
  return out;
}

const atomicWrite = (name, data) => {
  const target = path.join(OUT, name);
  fs.writeFileSync(`${target}.tmp`, data);
  fs.renameSync(`${target}.tmp`, target);
};

// Writes every file a wallet might ask for, biggest sizes first, only when all of its blocks are known and final.
function writeFiles(from, tip) {
  let written = 0;
  const haveAll = (start, count) => { for (let h = start; h < start + count; h++) if (!blocks.has(h)) return false; return true; };
  for (const [prefix, size] of [['d', DAY], ['h', HOUR], ['b', 1]]) {
    // Whole days cover any gap. Hours and single blocks only matter near the tip, so older ones aren't kept.
    const oldest = prefix === 'd' ? from : prefix === 'h' ? tip - 2 * DAY - HOUR : tip - 2 * HOUR;
    const first = Math.ceil(Math.max(from, oldest) / size) * size;
    for (let start = first; start + size <= tip + 1; start += size) {
      const name = `${prefix}-${start}.bin`;
      if (fs.existsSync(path.join(OUT, name)) || !haveAll(start, size)) continue;
      atomicWrite(name, chunkBytes(start, size));
      written++;
    }
  }
  return written;
}

async function update() {
  const info = await rpc('get_info');
  const networkTip = info.height - 1;
  const tip = networkTip - KEEP_BEHIND;
  const from = FROM ?? Math.max(0, tip - DAYS * BLOCKS_PER_DAY);
  const missing = [];
  for (let h = from; h <= tip; h++) if (!blocks.has(h)) missing.push(h);
  if (missing.length) {
    const log = logStream();
    let done = 0, nextIndex = 0, failed = null;
    const started = Date.now();
    const worker = async () => {
      while (nextIndex < missing.length && !failed) {
        const height = missing[nextIndex++];
        try {
          const { entries } = await fetchBlock(height);
          const body = bodyOf(entries, height);
          blocks.set(height, body);
          const head = Buffer.alloc(12);
          head.writeUInt32LE(height, 0);
          head.writeUInt32LE(body.txs, 4);
          head.writeUInt32LE(body.bytes.length, 8);
          log.write(head);
          log.write(Buffer.from(body.bytes));
        } catch (error) { failed = error; }
        done++;
        if (done % 500 === 0 || done === missing.length) console.log(`blocks ${done}/${missing.length}, ${(done / ((Date.now() - started) / 1000)).toFixed(0)}/s`);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await new Promise((r) => log.end(r));
    if (failed) throw failed;
  }
  const written = writeFiles(from, tip);
  // A manifest lands last, so a wallet never sees a tip whose files don't exist yet.
  const firstFile = Math.ceil(from / DAY) * DAY;
  atomicWrite('manifest.json', JSON.stringify({ version: 1, network: info.stagenet ? 'stagenet' : info.testnet ? 'testnet' : 'mainnet', from: firstFile, tip, networkTip, sizes: { day: DAY, hour: HOUR } }));
  return { from, tip, written };
}

readLog();
console.log(`feed: ${blocks.size} blocks cached, node ${NODE}, keeping ${DAYS} days in ${OUT}`);
const first = await update();
console.log(`feed: ready through block ${first.tip}, ${first.written} new files`);
if (ONCE) process.exit(0);

http.createServer((req, res) => {
  const name = path.basename(new URL(req.url, 'http://x').pathname);
  res.setHeader('Access-Control-Allow-Origin', '*');
  const file = path.join(OUT, name);
  if (!/^(manifest\.json|[dhb]-\d+\.bin)$/.test(name) || !fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', name.endsWith('json') ? 'application/json' : 'application/octet-stream');
  res.setHeader('Cache-Control', name.endsWith('json') ? 'no-cache' : 'public, max-age=31536000, immutable');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`feed: serving on http://127.0.0.1:${PORT}`));

setInterval(() => { update().catch((error) => console.warn('update failed, will retry:', error.message)); }, 30000);
