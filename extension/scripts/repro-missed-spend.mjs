// Reproduces the missed-spend case: the month-old test wallet (saved at block 2224078) catches up over a stretch where it
// both received coins and spent them from another device. Prints what the wallet believes next to what the chain says.
// Needs: npm run build:test, the stagenet feed on 8787, feed/data/synth served on 8788. Stagenet coins only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3-test');
const truth = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../feed/data/synth/month-old.json'), 'utf8'));
const PASSWORD = 'test-network-password';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnero-repro-'));
const context = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, viewport: { width: 380, height: 600 }, args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const page = await context.newPage();
await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
await page.waitForFunction(() => window.walnero);
const call = (m, p) => page.evaluate(([a, b]) => window.walnero.call(a, b), [m, p]);
await call('testImport', { seed: truth.seed, password: PASSWORD, restoreHeight: truth.restoreHeight, walletPassword: truth.walletPassword, base: 'http://127.0.0.1:8788', savedAt: truth.savedAt });
await call('unlock', { password: PASSWORD });
let t;
for (;;) { t = await call('timing'); if (t?.phase === 'live' || t?.phase === 'failed') break; await page.waitForTimeout(250); }
await page.waitForTimeout(3000);
const home = await call('home');
const txs = await call('activity');
console.log('phase', t.phase, 'scan', JSON.stringify(t.scan), t.fellBack ? `fell back: ${t.fellBack}` : '');
console.log(`wallet says balance ${home.balance} at height ${home.height}/${home.target}`);
for (const tx of txs) console.log(`  ${tx.incoming ? 'in ' : 'out'} ${tx.amount} ${tx.confirmed ? 'block' : 'pool'} ${tx.hash.slice(0, 16)}`);
await context.close();
fs.rmSync(dir, { recursive: true, force: true });
