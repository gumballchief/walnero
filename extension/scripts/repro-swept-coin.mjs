// The second gap: a coin arrives while Walnero is closed, then the same wallet spends it from another device and nothing comes
// back here. The scan can't see that spend (it doesn't know the new coin's key image yet). This recreates it on demand: the
// scan is told to miss one real past payment, the way it would miss a send-everything payment. Stagenet coins only, nothing
// is sent. Needs: npm run build:test and the stagenet feed on 8787.
//   N: normal open, the truth.   B: the scan misses payment X, spend check off (how it was).   C: same miss, spend check on.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3-test');
const wallet = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../tests/stagenet-test-wallet.json'), 'utf8'));
const NODE = 'http://node.monerodevs.org:38089';
const PASSWORD = 'test-network-password';
const FROM = 2243700;

async function device(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `walnero-${name}-`));
  const context = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, viewport: { width: 380, height: 600 }, args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  await page.waitForFunction(() => window.walnero);
  const call = (m, p) => page.evaluate(([a, b]) => window.walnero.call(a, b), [m, p]);
  const live = async () => { for (;;) { const t = await call('timing'); if (t?.phase === 'live') return t; if (t?.phase === 'failed' || t?.phase === 'slow') throw new Error(`${name}: ${t.phase} ${t.fellBack}`); await page.waitForTimeout(500); } };
  return { name, call, live, close: async () => { await context.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const heightOf = async (hash) => {
  for (const node of [NODE, 'http://node3.monerodevs.org:38089', 'https://stagenet.xmr.kernal.eu:38089', 'http://node2.monerodevs.org:38089']) {
    try { return (await (await fetch(`${node}/get_transactions`, { method: 'POST', body: JSON.stringify({ txs_hashes: [hash] }), signal: AbortSignal.timeout(15000) })).json()).txs[0].block_height; } catch {}
  }
  throw new Error('no server answered');
};

const n = await device('N');
let b, c;
try {
  await n.call('restore', { seed: wallet.seed, password: PASSWORD, restoreHeight: FROM });
  await n.live();
  await new Promise((r) => setTimeout(r, 4000));
  const truth = await n.call('home');
  const txs = await n.call('activity');
  const tip = truth.target;
  let x;
  for (const tx of txs.filter((t) => !t.incoming && t.confirmed)) { const h = await heightOf(tx.hash); if (h < tip - 15) { x = { ...tx, height: h }; break; } }
  console.log(`truth: balance ${truth.balance} at ${tip}; payment X = ${x.hash.slice(0, 16)} (${x.amount} out) in block ${x.height}`);

  [b, c] = await Promise.all([device('B'), device('C')]);
  await b.call('testDropHits', { heights: [x.height], check: false });
  await c.call('testDropHits', { heights: [x.height], check: true });
  await Promise.all([b.call('restore', { seed: wallet.seed, password: PASSWORD, restoreHeight: FROM }), c.call('restore', { seed: wallet.seed, password: PASSWORD, restoreHeight: FROM })]);
  await Promise.all([b.live(), c.live()]);
  let t;
  for (let i = 0; i < 120; i++) { t = await c.call('timing'); if (t.spendCheck && (t.spendCheck.found || t.spendCheck.leads === 0 || i > 100)) break; await new Promise((r) => setTimeout(r, 500)); }
  await new Promise((r) => setTimeout(r, 3000));
  const hb = await b.call('home'); const hc = await c.call('home');
  const ca = await c.call('activity');
  console.log(`B (scan missed X, no check): balance ${hb.balance}`);
  console.log(`C (scan missed X, check on): balance ${hc.balance}, spend check ${JSON.stringify(t.spendCheck)}`);
  const row = ca.find((r) => r.hash === x.hash);
  console.log(`C's Activity has X as: ${row ? `${row.incoming ? 'in' : 'out'} ${row.amount}` : 'missing'}`);
  const missed = Number(hb.balance) - Number(hc.balance);
  console.log(`coins C took off: ${missed.toFixed(12)}; X's row says ${row?.amount}`);
} finally {
  await n.close(); await b?.close(); await c?.close();
}
