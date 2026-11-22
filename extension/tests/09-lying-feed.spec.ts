// A feed server that lies, in every way worth trying. A proxy in this test sits between the wallet and the real feed and rewrites
// what it serves. The wallet must never show a wrong balance as if it were right. Needs the feed (8787) and make-month-old-wallet.mjs's
// output served on 8788.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { test, expect, SHOTS } from './harness';

const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3-test');
const SYNTH = path.resolve(import.meta.dirname, '../../feed/data/synth');
const NODE = 'http://node2.monerodevs.org:38089';
const REAL_FEED = 'http://127.0.0.1:8787';
const PROXY_PORT = 8789;
const PASSWORD = 'test-network-password';

const launch = (dir: string) => chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, viewport: { width: 380, height: 600 }, args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
const extensionIdOf = async (context: BrowserContext) => new URL((context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))).url()).host;
const call = (page: Page, method: string, params?: unknown) => page.evaluate(([m, p]) => (window as any).walnero.call(m, p), [method, params] as const);

// Walks a feed file and calls back for each transaction: tx(block, index, startOfTx, endOfTx, startOfKeys, keyCount).
function walk(bytes: Buffer, onTx: (block: number, index: number, start: number, end: number, keysAt: number, keys: number) => void) {
  const blocks = bytes.readUInt32LE(8);
  let p = 16 + blocks * 2;
  const varint = () => { let v = 0, shift = 0; for (;;) { const b = bytes[p++]; v += (b & 0x7f) * 2 ** shift; if (!(b & 0x80)) return v; shift += 7; } };
  for (let block = 0; block < blocks; block++) {
    const txs = bytes.readUInt16LE(16 + block * 2);
    for (let i = 0; i < txs; i++) {
      const start = p;
      const flags = bytes[p++];
      const keys = bytes[p++];
      const keysAt = p;
      p += keys * 32;
      const outs = varint();
      if (flags & 2) p += outs * 32;
      p += outs * (flags & 1 ? 33 : 32);
      const inputs = varint();
      p += inputs * 4;
      onTx(block, i, start, p, keysAt, keys);
    }
  }
}

type Tamper = (name: string, bytes: Buffer) => Buffer;

// Quietly removes one real transaction, fixing up the counts so the file still reads as valid.
const dropOne: Tamper = (name, bytes) => {
  if (!name.startsWith('d-')) return bytes;
  let cut: { block: number; start: number; end: number } | null = null;
  walk(bytes, (block, index, start, end) => { if (index === 1 && !cut) cut = { block, start, end }; });
  if (!cut) return bytes;
  const { block, start, end } = cut as { block: number; start: number; end: number };
  const out = Buffer.concat([bytes.subarray(0, start), bytes.subarray(end)]);
  out.writeUInt16LE(out.readUInt16LE(16 + block * 2) - 1, 16 + block * 2);
  out.writeUInt32LE(out.readUInt32LE(12) - 1, 12);
  return out;
};

// Changes every transaction's key. All the counts stay right, so only reading the real chain can catch it.
const alterAll: Tamper = (name, bytes) => {
  const out = Buffer.from(bytes);
  walk(out, (_b, _i, _s, _e, keysAt, keys) => { if (keys) out[keysAt] ^= 1; });
  return out;
};

const garbage: Tamper = (name, bytes) => { const out = Buffer.from(bytes); if (name.startsWith('d-')) out.fill(0x41, 16); return out; };

// Claims the chain is far ahead of where it really is, and backs it with perfectly valid empty files.
const FUTURE_BLOCKS = 5000;
const emptyChunk = (start: number, count: number) => {
  const out = Buffer.alloc(16 + count * 2);
  out.set([0x57, 0x4e, 0x46, 1]);
  out.writeUInt32LE(start, 4);
  out.writeUInt32LE(count, 8);
  return out;
};

async function serveLies(tamper: Tamper, future = false) {
  const server = http.createServer(async (req, res) => {
    const name = path.basename(new URL(req.url!, 'http://x').pathname);
    res.setHeader('Access-Control-Allow-Origin', '*');
    const upstream = await fetch(`${REAL_FEED}/${name}`);
    if (future && name === 'manifest.json') {
      const manifest = await upstream.json();
      manifest.tip += FUTURE_BLOCKS;
      manifest.networkTip += FUTURE_BLOCKS;
      res.end(JSON.stringify(manifest));
      return;
    }
    if (future && !upstream.ok) {
      const match = /^([dhb])-(\d+)\.bin$/.exec(name);
      if (match) { res.end(emptyChunk(Number(match[2]), { d: 720, h: 30, b: 1 }[match[1] as 'd' | 'h' | 'b'])); return; }
    }
    if (!upstream.ok) { res.statusCode = upstream.status; res.end(); return; }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    res.end(name.endsWith('.bin') ? tamper(name, bytes) : bytes);
  });
  await new Promise<void>((resolve) => server.listen(PROXY_PORT, '127.0.0.1', resolve));
  return () => new Promise((resolve) => server.close(resolve));
}

async function openWallet(truth: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnero-liar-'));
  const context = await launch(dir);
  const id = await extensionIdOf(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.waitForFunction(() => (window as any).walnero);
  await call(page, 'testFeed', { url: `http://127.0.0.1:${PROXY_PORT}` });
  await call(page, 'testImport', { seed: truth.seed, password: PASSWORD, restoreHeight: truth.restoreHeight, walletPassword: truth.walletPassword, base: 'http://127.0.0.1:8788', savedAt: truth.savedAt });
  return { context, page, dir, id };
}

async function waitFor(page: Page, done: (t: any) => boolean, limitMs = 900_000) {
  const started = Date.now();
  let last = started;
  for (;;) {
    const t = await call(page, 'timing');
    if (t && done(t)) return t;
    if (Date.now() - started > limitMs) throw new Error(`timed out, last state ${JSON.stringify(t)}`);
    if (Date.now() - last > 30_000) { last = Date.now(); console.log(`  waiting ${Math.round((last - started) / 1000)} s: ${t?.phase}, ${JSON.stringify(t?.checked)} ${t?.fellBack ?? ''}`); }
    await page.waitForTimeout(250);
  }
}

const close = async (w: { context: BrowserContext; dir: string }) => { await w.context.close(); fs.rmSync(w.dir, { recursive: true, force: true }); };

for (const [title, tamper] of [['drops a transaction', dropOne], ['changes the contents', alterAll], ['serves garbage', garbage]] as const) {
  test(`a feed that ${title} gets refused, before unlocking and after`, async () => {
    test.setTimeout(300_000);
    const truth = JSON.parse(fs.readFileSync(path.join(SYNTH, 'month-old.json'), 'utf8'));
    const stop = await serveLies(tamper);
    const wallet = await openWallet(truth);
    try {
      const locked = await call(wallet.page, 'catchup', { eager: true });
      console.log(`${title}, while locked:`, JSON.stringify(locked));
      expect(locked.rejected).toBeTruthy();
      expect(locked.cursor).toBe(truth.savedAt - 1);

      await call(wallet.page, 'unlock', { password: PASSWORD });
      const t = await waitFor(wallet.page, (x) => x.phase === 'slow' || x.phase === 'live');
      console.log(`${title}, after unlock: phase ${t.phase}, rejected ${t.feedRejected}, "${t.fellBack}"`);
      expect(t.phase).toBe('slow');
      expect(t.feedRejected).toBe(true);
      const home = await call(wallet.page, 'home');
      expect(home.synced).toBe(false);
      await wallet.page.reload();
      await expect(wallet.page.getByTestId('feed-rejected')).toBeVisible();
      fs.mkdirSync(SHOTS, { recursive: true });
      await wallet.page.screenshot({ path: path.join(SHOTS, '2.5-feed-rejected.png') });
    } finally {
      await close(wallet);
      await stop();
    }
  });
}

test('a feed that claims blocks from the future can not move the wallet past the real chain', async () => {
  test.setTimeout(300_000);
  const truth = JSON.parse(fs.readFileSync(path.join(SYNTH, 'month-old.json'), 'utf8'));
  const stop = await serveLies((_n, bytes) => bytes, true);
  const wallet = await openWallet(truth);
  try {
    const locked = await call(wallet.page, 'catchup', { eager: true }).catch((e: any) => ({ error: String(e.message) }));
    console.log('future feed, while locked:', JSON.stringify(locked));
    expect(locked.hits).toBeUndefined();
    await call(wallet.page, 'unlock', { password: PASSWORD });
    const t = await waitFor(wallet.page, (x) => x.phase === 'slow' || x.phase === 'live');
    console.log(`future feed, after unlock: phase ${t.phase}, "${t.fellBack}"`);
    expect(t.phase).toBe('slow');
    const info = await (await fetch(`${NODE}/get_info`)).json();
    const home = await call(wallet.page, 'home');
    expect(home.height).toBeLessThanOrEqual(info.height);
  } finally {
    await close(wallet);
    await stop();
  }
});

test('after refusing a lying feed, the long way reaches the true balance', async () => {
  test.setTimeout(900_000);
  const truth = JSON.parse(fs.readFileSync(path.join(SYNTH, 'month-old.json'), 'utf8'));
  const stop = await serveLies(alterAll);
  const wallet = await openWallet(truth);
  try {
    await call(wallet.page, 'unlock', { password: PASSWORD });
    await waitFor(wallet.page, (x) => x.phase === 'slow');
    const t = await waitFor(wallet.page, (x) => x.phase === 'live');
    console.log(`long way finished in ${((t.times.live - t.times.bootStart) / 1000).toFixed(0)} s`);
    await wallet.page.waitForTimeout(16_000);
    const home = await call(wallet.page, 'home');
    expect(home.balance).toBe((Number(truth.balance) / 1e12).toFixed(12));
  } finally {
    await close(wallet);
    await stop();
  }
});

// The hardest case: one change, aimed at one wallet's own transactions, in blocks the random check is unlikely to pick.
test('a lie aimed only at this wallet can hide money for a while, and Full check finds it', async () => {
  test.setTimeout(1_800_000);
  const truth = JSON.parse(fs.readFileSync(path.join(SYNTH, 'month-old.json'), 'utf8'));
  // Where this wallet's real transactions sit in the chain.
  const res = await fetch(`${NODE}/get_transactions`, { method: 'POST', body: JSON.stringify({ txs_hashes: truth.txs }) });
  const targets = new Map<number, Set<number>>();
  for (const tx of (await res.json()).txs) {
    const block = await (await fetch(`${NODE}/json_rpc`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_block', params: { height: tx.block_height } }) })).json();
    const list = targets.get(tx.block_height) ?? new Set<number>();
    list.add(1 + block.result.tx_hashes.indexOf(tx.tx_hash));
    targets.set(tx.block_height, list);
  }
  console.log('aiming at', [...targets.entries()].map(([h, l]) => `${h}:${[...l]}`).join(' '));
  const aimed: Tamper = (_name, bytes) => {
    const start = bytes.readUInt32LE(4);
    const out = Buffer.from(bytes);
    walk(out, (block, index, _s, _e, keysAt, keys) => { if (keys && targets.get(start + block)?.has(index)) out[keysAt] ^= 1; });
    return out;
  };
  const stop = await serveLies(aimed);
  const wallet = await openWallet(truth);
  console.log('wallet in place, unlocking');
  try {
    await call(wallet.page, 'unlock', { password: PASSWORD });
    console.log('unlocked');
    const t = await waitFor(wallet.page, (x) => x.phase === 'live' || x.phase === 'slow');
    if (t.phase === 'slow') {
      // A random check happened to land on one of those blocks, which is the system working. Nothing more to prove here.
      console.log('the random check caught even the aimed lie:', t.fellBack);
      return;
    }
    await wallet.page.waitForTimeout(16_000);
    const fooled = await call(wallet.page, 'home');
    const want = (Number(truth.balance) / 1e12).toFixed(12);
    console.log(`after the aimed lie the wallet shows ${fooled.balance}, the truth is ${want}`);

    await wallet.page.reload();
    await expect(wallet.page.getByTestId('balance')).toBeVisible();
    await wallet.page.getByTestId('tab-settings').click();
    await wallet.page.getByTestId('full-check').click();
    const started = Date.now();
    const beat = setInterval(async () => {
      const h = await call(wallet.page, 'home').catch(() => null);
      if (h) console.log(`  ${Math.round((Date.now() - started) / 1000)} s: ${h.phase}, block ${h.height} of ${h.target}, ${(h.percent * 100).toFixed(1)}%, balance ${h.balance}, full ${JSON.stringify(h.full)}`);
    }, 60_000);
    await waitFor(wallet.page, (x) => x.full && !x.full.running, 1_700_000);
    clearInterval(beat);
    console.log(`full check took ${((Date.now() - started) / 1000).toFixed(0)} s`);
    await wallet.page.waitForTimeout(16_000);
    const fixed = await call(wallet.page, 'home');
    console.log(`after the full check: ${fixed.balance}`);
    expect(fixed.balance).toBe(want);
    await expect(wallet.page.getByTestId('full-result')).toBeVisible();
    await wallet.page.screenshot({ path: path.join(SHOTS, '2.5-full-check.png') });
  } finally {
    await close(wallet);
    await stop();
  }
});
