// A real payment arrives while the wallet is locked. The background scan has to find it with no password, and unlocking has to
// show it. Real stagenet coins, sent from the second test wallet. Spends a little valueless test money each run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { test, expect } from './harness';

const require = createRequire(import.meta.url);
const lib = require('monero-ts').default ?? require('monero-ts');
const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3-test');
const SYNTH = path.resolve(import.meta.dirname, '../../feed/data/synth');
const FEED = 'http://127.0.0.1:8787';
const PASSWORD = 'test-network-password';
const AMOUNT = 200000000n; // 0.0002 XMR

const launch = (dir: string) => chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, viewport: { width: 380, height: 600 }, args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
const extensionIdOf = async (context: BrowserContext) => new URL((context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))).url()).host;
const call = (page: Page, method: string, params?: unknown) => page.evaluate(([m, p]) => (window as any).walnero.call(m, p), [method, params] as const);
const waitLive = async (page: Page) => {
  for (let i = 0; i < 2400; i++) {
    const t = await call(page, 'timing');
    if (t?.phase === 'live') return t;
    if (t?.phase === 'slow') throw new Error('fell back to the slow path');
    await page.waitForTimeout(250);
  }
  throw new Error('never went live');
};

test('a payment that arrives while locked is found without the password', async () => {
  test.setTimeout(1_500_000);
  const truth = JSON.parse(fs.readFileSync(path.join(SYNTH, 'month-old.json'), 'utf8'));
  const second = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'stagenet-second-wallet.json'), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnero-paid-'));
  const context = await launch(dir);
  const id = await extensionIdOf(context);

  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await expect.poll(async () => (await worker.evaluate(() => chrome.alarms.get('catchup')))?.periodInMinutes, { timeout: 10_000 }).toBe(30);
  console.log('background alarm is set, every 30 minutes');

  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.waitForFunction(() => (window as any).walnero);
  await call(page, 'testImport', { seed: truth.seed, password: PASSWORD, restoreHeight: truth.restoreHeight, walletPassword: truth.walletPassword, base: 'http://127.0.0.1:8788', savedAt: truth.savedAt });
  await call(page, 'unlock', { password: PASSWORD });
  await waitLive(page);
  const before = await call(page, 'home');
  const { address } = await call(page, 'receive');
  console.log(`caught up, balance ${before.balance}. Locking, then sending ${Number(AMOUNT) / 1e12} XMR to ${address.slice(0, 12)}...`);
  await call(page, 'lock');

  // Send from the other wallet, in this test's own process. The extension is locked throughout.
  const payer = await lib.createWalletFull({ networkType: lib.MoneroNetworkType.STAGENET, password: 'x', seed: second.seed, restoreHeight: 2243800, server: { uri: 'http://node3.monerodevs.org:38089' }, proxyToWorker: false });
  await payer.sync();
  const tx = await payer.createTx({ accountIndex: 0, address, amount: AMOUNT, relay: true });
  const hash = tx.getHash();
  console.log(`sent ${hash}`);
  await payer.close();

  // Wait for it to reach a block and the feed.
  let minedAt = 0;
  for (let i = 0; i < 180 && !minedAt; i++) {
    const res = await fetch('http://node3.monerodevs.org:38089/get_transactions', { method: 'POST', body: JSON.stringify({ txs_hashes: [hash] }) });
    const entry = (await res.json()).txs?.[0];
    if (entry && !entry.in_pool) minedAt = entry.block_height;
    else await new Promise((r) => setTimeout(r, 10000));
  }
  expect(minedAt).toBeGreaterThan(0);
  console.log(`in block ${minedAt}`);
  for (let i = 0; i < 120; i++) {
    const m = await (await fetch(`${FEED}/manifest.json`)).json();
    if (m.tip >= minedAt) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  // The scan that runs on Chrome's alarm, called directly. No password involved.
  const state = await call(page, 'state');
  expect(state.unlocked).toBe(false);
  const scanned = await call(page, 'catchup');
  console.log('background scan while locked:', JSON.stringify(scanned));
  expect(scanned.hits).toBeGreaterThan(0);

  // Unlock: the money must show, and match what was sent.
  const press = Date.now();
  await call(page, 'unlock', { password: PASSWORD });
  const shownAt = Date.now() - press;
  // Sending has to work straight away, without waiting for the wallet to finish catching up.
  const build = Date.now();
  const phaseThen = (await call(page, 'home')).phase;
  const built = await call(page, 'estimate', { address: second.address, amount: '0.0001' });
  console.log(`payment built ${((Date.now() - build) / 1000).toFixed(1)} s after unlock (phase was ${phaseThen}), fee ${built.fee}`);
  const live = await waitLive(page);
  console.log(`unlock returned in ${shownAt} ms; from there to balance right: ${((live.times.balanceRight - live.times.bootStart) / 1000).toFixed(2)} s, live ${((live.times.live - live.times.bootStart) / 1000).toFixed(2)} s, scan ${JSON.stringify(live.scan)}`);
  await page.waitForTimeout(16_000);
  const after = await call(page, 'home');
  const toAtomic = (x: string) => BigInt(x.replace('.', ''));
  console.log(`balance ${before.balance} -> ${after.balance}`);
  expect(toAtomic(after.balance) - toAtomic(before.balance)).toBe(AMOUNT);
  const txs = await call(page, 'activity');
  expect(txs.map((t: any) => t.hash)).toContain(hash);

  await context.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
