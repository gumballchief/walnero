// A month of mainnet-sized traffic through the real scan code in a real browser. Needs feed/bench/make-synth.mjs running.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './harness';

const SYNTH = path.resolve(import.meta.dirname, '../../feed/data/synth/keys.json');

test('scans a month, finds every hidden payment', async ({ context, extensionId }) => {
  const keys = JSON.parse(fs.readFileSync(SYNTH, 'utf8'));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/bench.html`);
  await page.waitForFunction(() => (window as any).runScan);
  const report: any[] = [];
  for (const threads of [15, 8, 4, 15]) {
    const r = await page.evaluate((c) => (window as any).runScan(c), { feed: 'http://127.0.0.1:8788', view: keys.view, spend: keys.spend, start: keys.start, days: keys.days, blocks: keys.blocks, threads });
    const found = new Set<string>(r.hits);
    const missed = keys.planted.filter((p: string) => !found.has(p));
    const extra = [...found].filter((p) => !keys.planted.includes(p));
    console.log(`${threads} threads: ${r.txs.toLocaleString()} transactions in ${r.seconds.toFixed(1)} s, ${Math.round(r.txs / r.seconds).toLocaleString()}/s, ${(r.bytes / 1048576).toFixed(0)} MB, fast path ${r.fast}, cores ${r.cores}; payments ${found.size} found, ${missed.length} missed, ${extra.length} false`);
    report.push({ threads, seconds: r.seconds, rate: r.txs / r.seconds, missed: missed.length, extra: extra.length, tableMs: r.tableMs });
    expect(r.complete).toBe(true);
    expect(r.fast).toBe(true);
    expect(missed).toEqual([]);
    expect(extra).toEqual([]);
  }
  fs.writeFileSync(path.resolve(import.meta.dirname, '../../feed/bench/scale-result.json'), JSON.stringify({ measured: new Date().toISOString(), txs: keys.days * keys.txPerDay, bytes: keys.bytes, report }, null, 1));
});
