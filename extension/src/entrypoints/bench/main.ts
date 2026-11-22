// Test page only, removed before public release. Runs the real scan code in a real browser against a month-sized feed.
import { makeTable, scanChunks, type Chunk } from '@/wallet/scan-pool';

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));

(window as any).runScan = async (config: { feed: string; view: string; spend: string; start: number; days: number; blocks: number; threads: number; table?: boolean }) => {
  const view = fromHex(config.view);
  const spend = fromHex(config.spend);
  const tableStart = performance.now();
  const table = await makeTable(view, spend);
  const tableMs = performance.now() - tableStart;
  const chunks: Chunk[] = Array.from({ length: config.days }, (_, i) => ({ url: `${config.feed}/d-${config.start + i * config.blocks}.bin`, start: config.start + i * config.blocks, count: config.blocks }));
  const started = performance.now();
  const result = await scanChunks(chunks, { view, table, images: new Uint32Array(0) }, config.threads, [], () => {});
  const seconds = (performance.now() - started) / 1000;
  return { seconds, tableMs, threads: config.threads, cores: navigator.hardwareConcurrency, txs: result.txs, bytes: result.bytes, fast: result.fast, complete: result.complete, hits: result.hits.map((h) => `${h.height}:${h.tx}`) };
};
