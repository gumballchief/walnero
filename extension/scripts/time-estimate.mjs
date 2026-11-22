// Times "Checking" (building a payment without sending it) right after the wallet goes live, then again, to see what's slow.
// Stagenet coins only, and nothing is ever sent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3-test');
const tests = path.resolve(import.meta.dirname, '../tests');
const wallet = JSON.parse(fs.readFileSync(path.join(tests, 'stagenet-test-wallet.json'), 'utf8'));
const second = JSON.parse(fs.readFileSync(path.join(tests, 'stagenet-second-wallet.json'), 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnero-time-'));
const context = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, viewport: { width: 380, height: 600 }, args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const page = await context.newPage();
await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
await page.waitForFunction(() => window.walnero);
const call = (m, p) => page.evaluate(([a, b]) => window.walnero.call(a, b), [m, p]);
await call('restore', { seed: wallet.seed, password: 'test-network-password', restoreHeight: 2243700 });
for (;;) { const t = await call('timing'); if (t?.phase === 'live') break; await page.waitForTimeout(300); }
console.log('live');
const log = [];
context.on('request', (r) => { if (/38089|kernal/.test(r.url())) { const s = Date.now(); log.push([s, new URL(r.url()).pathname]); r.response().then((res) => res?.body()).then((b) => { const e = log.find((x) => x[0] === s && x[2] === undefined); if (e) { e[2] = Date.now() - s; e[3] = b?.length; } }).catch(() => {}); } });
const time = async (label) => {
  const started = Date.now();
  try { await call('estimate', { address: second.address, amount: '0.0001' }); } catch (e) { console.log(label, 'error', e.message); }
  const h = await call('home');
  console.log(`${label}: ${Date.now() - started} ms (syncing now: ${h.syncing})`);
};
const wait = Number(process.argv[2] ?? 0);
if (process.argv[3] === 'open') { await call('sendOpen'); console.log('Send opened (refreshes paused, address check warmed)'); }
if (wait) { console.log(`waiting ${wait} s after live first`); await page.waitForTimeout(wait * 1000); }
await time('first');
for (const [s, u, ms, size] of log) console.log('   ', u, ms, 'ms', size, 'bytes');
log.length = 0;
await time('second');
for (const [s, u, ms, size] of log) console.log('   ', u, ms, 'ms', size, 'bytes');
await page.waitForTimeout(25000);
await time('third, 25 s later');
for (let i = 0; i < 4; i++) { await page.waitForTimeout(6000); await time(`again +${(i + 1) * 6} s`); }
await context.close();
fs.rmSync(dir, { recursive: true, force: true });
