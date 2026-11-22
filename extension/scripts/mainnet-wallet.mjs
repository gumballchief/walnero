// The real-Monero test wallet. Lives outside the repo, in ~/.walnero, so it can never be committed.
//   node scripts/mainnet-wallet.mjs setup   makes the wallet once and prints the address to fund
//   node scripts/mainnet-wallet.mjs check   opens it like a person would after time away, and reports what it shows and how fast
// Needs `npm run build:mainnet-test` and the real-Monero feed on port 8797. Never sends money: that's only ever done by hand.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const HOME = path.join(os.homedir(), '.walnero');
const FILE = path.join(HOME, 'mainnet-test-wallet.json');
const PROFILE = path.join(HOME, 'profile');
const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3-mainnet-test');
const SHOTS = path.resolve(import.meta.dirname, '../test-shots');
const command = process.argv[2];

const launch = () => chromium.launchPersistentContext(PROFILE, { channel: 'chromium', headless: true, viewport: { width: 380, height: 600 }, args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
const call = (page, method, params) => page.evaluate(([m, p]) => window.walnero.call(m, p), [method, params]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(context) {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const started = Date.now();
  await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.walnero);
  return { page, id, started };
}

async function waitLive(page, limitMs = 15 * 60_000) {
  const until = Date.now() + limitMs;
  let last = '';
  while (Date.now() < until) {
    const t = await call(page, 'timing');
    const line = `${t?.phase} ${JSON.stringify(t?.checked ?? {})}`;
    if (line !== last) { console.log(`  ${((Date.now() + limitMs - until) / 1000).toFixed(1)} s  ${line}`); last = line; }
    if (t?.phase === 'live') return t;
    if (t?.phase === 'failed') throw new Error(`wallet failed: ${t.fellBack}`);
    await sleep(250);
  }
  throw new Error('never went live');
}

if (command === 'setup') {
  if (fs.existsSync(FILE)) throw new Error(`${FILE} already exists. One test wallet only.`);
  fs.mkdirSync(HOME, { recursive: true });
  const password = crypto.randomBytes(18).toString('base64url');
  const context = await launch();
  const { page } = await open(context);
  const { seed } = await call(page, 'create', { password });
  // Written before anything else can go wrong, so the seed is never lost.
  fs.writeFileSync(FILE, JSON.stringify({ made: new Date().toISOString(), note: 'Walnero real-Monero TEST wallet. Small amounts only. Never commit.', seed, password }, null, 2));
  const { address } = await call(page, 'primaryAddress');
  fs.writeFileSync(FILE, JSON.stringify({ ...JSON.parse(fs.readFileSync(FILE, 'utf8')), address }, null, 2));
  console.log(`wallet made. Address to fund:\n${address}`);
  await waitLive(page);
  console.log('home:', JSON.stringify(await call(page, 'home')));
  await call(page, 'lock');
  await sleep(2000);
  await context.close();
} else if (command === 'check') {
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const context = await launch();
  const { page, started } = await open(context);
  await page.waitForSelector('[data-testid=unlock-password]', { timeout: 30_000 });
  const lockScreen = Date.now() - started;
  const press = Date.now();
  await call(page, 'unlock', { password: saved.password });
  const unlocked = Date.now() - press;
  console.log(`lock screen ${lockScreen} ms after opening, unlock answered in ${unlocked} ms`);
  const live = await waitLive(page);
  const home = await call(page, 'home');
  const txs = await call(page, 'activity');
  const t = live.times;
  console.log(`balance right ${((t.balanceRight - t.bootStart) / 1000).toFixed(2)} s, live ${((t.live - t.bootStart) / 1000).toFixed(2)} s after unlock`);
  console.log('scan:', JSON.stringify(live.scan), live.fellBack ? `fell back: ${live.fellBack}` : '');
  console.log(`balance ${home.balance} XMR (spendable ${home.unlocked}), height ${home.height}/${home.target}, ${txs.length} transactions`);
  for (const tx of txs) console.log(`  ${tx.incoming ? 'in ' : 'out'} ${tx.amount} ${tx.confirmed ? `${tx.confirmations} confirmations` : 'pending'} ${tx.hash}`);
  await page.reload();
  await page.waitForTimeout(1500);
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, 'mainnet-home.png') });
  await call(page, 'lock');
  await sleep(2000);
  await context.close();
} else if (command === 'review') {
  // Times "Checking": building a payment without sending it, to one of this wallet's own addresses, the way Send does after
  // the amount is typed. Nothing is ever relayed: estimate only builds, and locking throws the built payment away.
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const context = await launch();
  const { page } = await open(context);
  await page.waitForSelector('[data-testid=unlock-password]', { timeout: 30_000 });
  await call(page, 'unlock', { password: saved.password });
  await waitLive(page);
  const opened = await call(page, 'sendOpen').then(() => true, () => false);
  console.log(opened ? 'Send opened: refreshes paused, address check warmed' : 'this build has no sendOpen (the old way)');
  await sleep(4000);
  const { address } = await call(page, 'receive');
  for (const label of ['first', 'second']) {
    const started = Date.now();
    const r = await call(page, 'estimate', { address, amount: '0.001' });
    console.log(`${label} Checking: ${Date.now() - started} ms (fee ${r.fee} XMR, not sent)`);
    await sleep(3000);
  }
  await call(page, 'lock');
  await sleep(2000);
  await context.close();
} else if (command === 'gap') {
  // A throwaway empty wallet starting N blocks back, so the feed and its chain checks run over real Monero traffic. No money,
  // nothing saved: a fresh browser profile that's deleted afterwards.
  const blocks = Number(process.argv[3] ?? 1800);
  const { createRequire } = await import('node:module');
  const lib = createRequire(import.meta.url)('monero-ts').default;
  const keys = await lib.createWalletKeys({ networkType: lib.MoneroNetworkType.MAINNET, language: 'English', proxyToWorker: false });
  const seed = await keys.getSeed();
  const tip = (await (await fetch('http://127.0.0.1:8797/manifest.json')).json()).tip;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnero-gap-'));
  const context = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, viewport: { width: 380, height: 600 }, args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
  const { page } = await open(context);
  const started = Date.now();
  await call(page, 'restore', { seed, password: 'throwaway-' + crypto.randomUUID(), restoreHeight: tip - blocks });
  const live = await waitLive(page);
  const t = live.times;
  console.log(`${blocks} real blocks behind: live ${((Date.now() - started) / 1000).toFixed(1)} s, balance right ${((t.balanceRight - t.bootStart) / 1000).toFixed(2)} s`);
  console.log('scan:', JSON.stringify(live.scan), live.fellBack ? `FELL BACK: ${live.fellBack}` : 'fast path, chain checks passed');
  console.log('home:', JSON.stringify(await call(page, 'home')));
  await context.close();
  fs.rmSync(dir, { recursive: true, force: true });
} else {
  console.log('usage: node scripts/mainnet-wallet.mjs setup|check|gap [blocks]');
}
