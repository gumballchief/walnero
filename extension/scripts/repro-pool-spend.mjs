// Two devices, one wallet. Device A sends; device B is open at the same time and keeps refreshing. Prints what B shows
// while A's payment waits to go into a block, and after. Stagenet coins only.
// Needs: npm run build:test, the stagenet feed on 8787, feed/data/synth served on 8788.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const BUILD = (name) => path.resolve(import.meta.dirname, `../.output/${name}`);
const tests = path.resolve(import.meta.dirname, '../tests');
const wallet = JSON.parse(fs.readFileSync(path.join(tests, 'stagenet-test-wallet.json'), 'utf8'));
const second = JSON.parse(fs.readFileSync(path.join(tests, 'stagenet-second-wallet.json'), 'utf8'));
const truth = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../feed/data/synth/month-old.json'), 'utf8'));
const PASSWORD = 'test-network-password';
const AMOUNT = process.argv[2] ?? '0.0002';

async function device(name, build = 'chrome-mv3-test') {
  const EXTENSION = BUILD(build);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `walnero-${name}-`));
  const context = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, viewport: { width: 380, height: 600 }, args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  await page.waitForFunction(() => window.walnero);
  const call = (m, p) => page.evaluate(([a, b]) => window.walnero.call(a, b), [m, p]);
  const live = async () => { for (;;) { const t = await call('timing'); if (t?.phase === 'live') return; if (t?.phase === 'failed') throw new Error(`${name} failed`); await page.waitForTimeout(500); } };
  return { name, context, page, call, live, close: async () => { await context.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const line = async (d) => {
  const h = await d.call('home');
  const txs = await d.call('activity');
  const pool = txs.filter((t) => !t.confirmed).map((t) => `${t.incoming ? 'in' : 'out'} ${t.amount} ${t.hash.slice(0, 8)}`).join(', ');
  return `${d.name}: balance ${h.balance} unlocked ${h.unlocked} height ${h.height}${pool ? `  pool: ${pool}` : ''}`;
};

// B runs the build from before the fix (kept in chrome-mv3-test-before), C the fixed one.
// late: B and C only open after A's payment is already waiting in the pool, like the failed test did.
const LATE = process.argv[3] === 'late';
const [a, b, c] = await Promise.all([device('A'), device('B (before fix)', 'chrome-mv3-test-before'), device('C (fixed)')]);
const open = async () => {
  for (const d of [b, c]) {
    await d.call('testImport', { seed: truth.seed, password: PASSWORD, restoreHeight: truth.restoreHeight, walletPassword: truth.walletPassword, base: 'http://127.0.0.1:8788', savedAt: truth.savedAt });
    await d.call('unlock', { password: PASSWORD });
  }
  await Promise.all([b.live(), c.live()]);
};
try {
  await a.call('restore', { seed: wallet.seed, password: PASSWORD, restoreHeight: 2243700 });
  await a.call('unlock', { password: PASSWORD }).catch(() => {});
  if (!LATE) await open();
  await a.live();
  await new Promise((r) => setTimeout(r, 5000));
  console.log('before:'); for (const d of LATE ? [a] : [a, b, c]) console.log(' ', await line(d));

  const review = await a.call('estimate', { address: second.address, amount: AMOUNT });
  const { hash } = await a.call('send', { review: review.review });
  console.log(`A sent ${AMOUNT} + fee ${review.fee}, tx ${hash.slice(0, 16)}`);
  if (LATE) { await open(); console.log('B and C opened while it waits:'); for (const d of [b, c]) console.log('   ', await line(d)); }
  const start = Date.now();
  let mined = false;
  for (let i = 0; i < 40 && !mined; i++) {
    await new Promise((r) => setTimeout(r, 15000));
    const txs = await b.call('activity');
    const seen = txs.find((t) => t.hash === hash);
    mined = Boolean(seen?.confirmed);
    console.log(`${Math.round((Date.now() - start) / 1000)} s${seen ? '' : ' (B has not seen it yet)'}`);
    for (const d of [b, c]) console.log('   ', await line(d));
  }
  console.log('after:'); for (const d of [a, b, c]) console.log(' ', await line(d));
} finally {
  await a.close(); await b.close(); await c.close();
}
