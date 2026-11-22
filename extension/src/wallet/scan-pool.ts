// Runs the scanner across CPU cores over feed files. Each thread pulls the next file when it's free.
import { FeedRejected } from '@/wallet/feed-check';
import { NETWORK } from '@/wallet/network';

let FEED = NETWORK.feed;
export const setFeedForTest = (url: string) => { FEED = url; };
const DAY = 720;
const HOUR = 30;

export interface Manifest { version: number; network: string; from: number; tip: number; networkTip: number }
export interface Hit { height: number; tx: number; kind: number }
export interface ScanKeys { view: Uint8Array; table: Uint8Array; images: Uint32Array }
export interface Chunk { url: string; start: number; count: number }

export async function readManifest(): Promise<Manifest> {
  const res = await fetch(`${FEED}/manifest.json`, { cache: 'no-store', signal: AbortSignal.timeout(5000) }).catch((e) => { throw new Error(`Feed unreachable: ${e.message}`); });
  if (!res.ok) throw new Error(`Feed answered ${res.status}`);
  const manifest = await res.json();
  if (manifest.version !== 1) throw new Error('Feed version not understood');
  return manifest;
}

// Biggest files first. Starting a little before the cursor only rescans blocks, and old hits are ignored later. The file
// names don't reveal exactly where the wallet stopped.
export function planChunks(cursor: number, m: Manifest): Chunk[] {
  const out: Chunk[] = [];
  let c = cursor + 1;
  const add = (prefix: string, count: number) => { out.push({ url: `${FEED}/${prefix}-${c}.bin`, start: c, count }); c += count; };
  if (m.tip - c >= 2 * DAY) {
    c = Math.floor(c / DAY) * DAY;
    while (c + DAY <= m.tip + 1) add('d', DAY);
  }
  if (m.tip - c >= HOUR) {
    c = Math.floor(c / HOUR) * HOUR;
    while (c + HOUR <= m.tip + 1) add('h', HOUR);
  }
  while (c <= m.tip) add('b', 1);
  return out;
}

let compiled: Promise<WebAssembly.Module> | null = null;
// The fast build uses relaxed SIMD. An engine that can't load it (some Safari versions) gets the plain build instead.
const compileScanner = (name: string) => fetch(chrome.runtime.getURL(`scan/${name}`)).then((r) => r.arrayBuffer()).then((bytes) => WebAssembly.compile(bytes));
const scannerModule = () => (compiled ??= compileScanner('walnero_scan.wasm').catch(() => compileScanner('walnero_scan_plain.wasm')).catch((e) => { compiled = null; throw new Error(`Scanner file: ${e.message}`); }));

/** Every spend key this wallet can receive on: the same 50 accounts by 200 addresses wallet2 looks ahead to. */
export async function makeTable(view: Uint8Array, spend: Uint8Array): Promise<Uint8Array> {
  const module = await scannerModule();
  const worker = new Worker(chrome.runtime.getURL('scan/worker.js'));
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      worker.onmessage = ({ data }) => (data.type === 'table' ? resolve(data.table) : reject(new Error(data.message)));
      worker.onerror = (e) => reject(new Error(e.message));
      worker.postMessage({ type: 'table', module, view, spend, majors: 50, minors: 200 });
    });
  } finally {
    worker.terminate();
  }
}

export interface ScanResult {
  hits: Hit[];
  txs: number;
  bytes: number;
  fast: boolean;
  complete: boolean;
  /** Outputs in each block, by height, as the feed tells it. */
  outs: Map<number, number>;
  /** The feed's own bytes for the blocks picked for spot checking. */
  spots: Map<number, { txs: number; body: Uint8Array }>;
}

/**
 * Spends only: which transactions in these files spend a coin whose key image starts with one of these 4 byte prefixes.
 * Just reading, no keys or curve maths, and the files are usually still in the browser's cache from the scan. A match is
 * only a lead: the caller confirms it against the real block.
 */
export async function findSpends(chunks: Chunk[], prefixes: Set<number>): Promise<Hit[]> {
  const hits: Hit[] = [];
  let next = 0;
  const read = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      const res = await fetch(chunk.url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`Feed answered ${res.status} for ${chunk.url}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const damaged = () => new FeedRejected(`Feed file ${chunk.url} is damaged`);
      if (bytes.length < 16 || bytes[0] !== 0x57 || bytes[1] !== 0x4e || bytes[2] !== 0x46 || bytes[3] !== 1) throw damaged();
      const blocks = view.getUint32(8, true);
      if (blocks !== chunk.count || 16 + blocks * 2 > bytes.length) throw damaged();
      let p = 16 + blocks * 2;
      const varint = () => {
        let value = 0;
        for (let shift = 0; ; shift += 7) {
          if (p >= bytes.length || shift > 28) throw damaged();
          const b = bytes[p++];
          value |= (b & 0x7f) << shift;
          if (!(b & 0x80)) return value >>> 0;
        }
      };
      for (let block = 0; block < blocks; block++) {
        const txs = view.getUint16(16 + block * 2, true);
        for (let tx = 0; tx < txs; tx++) {
          if (p + 2 > bytes.length) throw damaged();
          const flags = bytes[p];
          p += 2 + bytes[p + 1] * 32;
          const outputs = varint();
          p += outputs * ((flags & 2 ? 32 : 0) + (flags & 1 ? 33 : 32));
          const inputs = varint();
          if (p + inputs * 4 > bytes.length) throw damaged();
          for (let i = 0; i < inputs; i++, p += 4) if (prefixes.has(view.getUint32(p, true))) hits.push({ height: chunk.start + block, tx, kind: 1 });
        }
      }
      if (p !== bytes.length) throw damaged();
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, chunks.length) }, read));
  return hits;
}

/** Scans every file. Nothing here is trusted yet: the caller compares `outs` and `spots` with the real chain first. */
export async function scanChunks(chunks: Chunk[], keys: ScanKeys, threads: number, spotHeights: number[], onProgress: (done: number, total: number) => void, signal?: AbortSignal): Promise<ScanResult> {
  const module = await scannerModule();
  const hits: Hit[] = [];
  const outs = new Map<number, number>();
  const spots = new Map<number, { txs: number; body: Uint8Array }>();
  let next = 0, txs = 0, bytes = 0, fast = true, finished = 0, failure: Error | null = null, aborted = false;
  const workers: Worker[] = [];
  const count = Math.max(1, Math.min(threads, chunks.length));

  await new Promise<void>((resolve) => {
    let running = count;
    const stopped = () => { running--; if (running === 0) resolve(); };
    const stopAll = () => { for (const w of workers) w.terminate(); resolve(); };
    signal?.addEventListener('abort', () => { aborted = true; stopAll(); });
    for (let t = 0; t < count; t++) {
      const worker = new Worker(chrome.runtime.getURL('scan/worker.js'));
      workers.push(worker);
      const give = () => {
        if (next >= chunks.length || failure) { worker.terminate(); stopped(); return; }
        const index = next++;
        const { start, count: size } = chunks[index];
        worker.postMessage({ type: 'scan', index, url: chunks[index].url, spots: spotHeights.filter((h) => h >= start && h < start + size).map((h) => h - start) });
      };
      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') { if (!data.fast) fast = false; give(); return; }
        if (data.type === 'error') {
          failure ??= data.bad ? new FeedRejected(data.message) : new Error(data.message);
          worker.terminate();
          stopped();
          return;
        }
        const chunk = chunks[data.index];
        if (data.start !== chunk.start || data.blocks !== chunk.count) {
          failure ??= new FeedRejected(`Feed file ${chunk.url} holds blocks ${data.start} to ${data.start + data.blocks - 1}, not what was asked for`);
          worker.terminate();
          stopped();
          return;
        }
        for (let i = 0; i < data.hits.length; i += 3) hits.push({ height: chunk.start + data.hits[i], tx: data.hits[i + 1], kind: data.hits[i + 2] });
        data.outs.forEach((n: number, i: number) => outs.set(chunk.start + i, n));
        for (const spot of data.spots) spots.set(chunk.start + spot.block, { txs: spot.txs, body: spot.body });
        txs += data.txs;
        bytes += data.bytes;
        finished++;
        onProgress(finished, chunks.length);
        give();
      };
      worker.onerror = (e) => { failure ??= new Error(e.message); worker.terminate(); stopped(); };
      worker.postMessage({ type: 'init', module, view: keys.view, table: keys.table, images: keys.images });
    }
  });
  if (failure && !aborted) throw failure;
  return { hits, txs, bytes, fast, complete: !aborted && finished === chunks.length, outs, spots };
}
