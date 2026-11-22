// The promise: a wallet closed for a month opens at once. A real stagenet wallet, really a month behind, with real coins in
// the gap, in a browser started from cold. Needs the feed (8787) and make-month-old-wallet.mjs's output (served on 8788).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { test, expect, SHOTS } from './harness';

const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3-test');
const SYNTH = path.resolve(import.meta.dirname, '../../feed/data/synth');
const RESULT = path.resolve(import.meta.dirname, '../../feed/bench/instant-result.json');
const PASSWORD = 'test-network-password';
const TYPING_MS = 3000; // About how long a person takes to type a password.

const launch = (dir: string) => chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, viewport: { width: 380, height: 600 }, args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
const extensionIdOf = async (context: BrowserContext) => new URL((context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))).url()).host;
const shot = (page: Page, name: string) => { fs.mkdirSync(SHOTS, { recursive: true }); return page.screenshot({ path: path.join(SHOTS, name) }); };
const call = (page: Page, method: string, params?: unknown) => page.evaluate(([m, p]) => (window as any).walnero.call(m, p), [method, params] as const);

// Opens the popup the way the toolbar button does and times it from inside the page, so test overhead doesn't count.
async function openPopup(context: BrowserContext, id: string, ready: string) {
  const page = await context.newPage();
  await page.bringToFront();
  await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'commit' });
  await page.waitForSelector(ready, { timeout: 30_000 });
  const timing = await page.evaluate(() => {
    const at = (name: string) => { const e = performance.getEntriesByName(name)[0]; return e ? Math.round(e.startTime) : null; };
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    return { firstPaint: at('walnero-painted'), now: Math.round(performance.now()), marks: { responseEnd: Math.round(nav.responseEnd), domInteractive: Math.round(nav.domInteractive), script: at('walnero-script'), view: at('walnero-view'), painted: at('walnero-painted'), fcp: at('first-contentful-paint') } };
  });
  return { page, ...timing };
}

test('a wallet closed for a month opens at once and matches the truth', async () => {
  test.setTimeout(1_200_000);
  const truth = JSON.parse(fs.readFileSync(path.join(SYNTH, 'month-old.json'), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnero-month-'));
  const report: any = { measured: new Date().toISOString(), gapBlocks: truth.truthHeight - truth.savedAt, normalSeconds: truth.normalSeconds };

  // Put the month-old wallet in place, then shut the browser completely.
  let context = await launch(dir);
  let id = await extensionIdOf(context);
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${id}/popup.html`);
  await setup.waitForFunction(() => (window as any).walnero);
  await call(setup, 'testImport', { seed: truth.seed, password: PASSWORD, restoreHeight: truth.restoreHeight, walletPassword: truth.walletPassword, base: 'http://127.0.0.1:8788', savedAt: truth.savedAt });
  await context.close();
  console.log(`wallet saved at block ${truth.savedAt}, ${report.gapBlocks} blocks behind the truth`);

  // Cold start: a new browser process, nothing warm.
  context = await launch(dir);
  id = await extensionIdOf(context);
  const cold = await openPopup(context, id, '[data-testid=unlock-password]');
  report.coldOpenFirstPaintMs = cold.firstPaint;
  report.coldOpenLockScreenMs = cold.now;
  console.log(`cold start: painted ${cold.firstPaint} ms, seen by test ${cold.now} ms`, JSON.stringify(cold.marks));
  await shot(cold.page, '2.4-cold-open.png');

  // Unlock: the time from pressing the button to seeing the wallet.
  await cold.page.waitForTimeout(TYPING_MS);
  await cold.page.getByTestId('unlock-password').fill(PASSWORD);
  const pressed = await cold.page.evaluate(() => new Promise<number>((resolve) => {
    const button = document.querySelector('[data-testid=unlock-go]') as HTMLButtonElement;
    const start = performance.now();
    (window as any).__unlockStart = start;
    new MutationObserver((_, obs) => {
      if (document.querySelector('[data-testid=balance]')) { obs.disconnect(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start))); }
    }).observe(document.body, { childList: true, subtree: true });
    button.click();
  }));
  report.unlockToWalletMs = Math.round(pressed);
  console.log(`unlock press to wallet on screen: ${report.unlockToWalletMs} ms`);
  await shot(cold.page, '2.4-first-frame.png');
  const firstLabel = await cold.page.getByTestId('sync-label').innerText();
  console.log(`first label: "${firstLabel}"`);
  expect(firstLabel).not.toBe('Up to date');

  // Everything after this happens behind a screen that's already usable.
  const started = Date.now();
  let timing: any;
  const labels = new Set<string>();
  for (;;) {
    timing = await call(cold.page, 'timing');
    labels.add(await cold.page.getByTestId('sync-label').innerText());
    if (timing?.phase === 'live') break;
    if (timing?.phase === 'slow') throw new Error(`fell back to the slow path: ${timing.fellBack}`);
    if (Date.now() - started > 600_000) throw new Error(`stuck in ${timing?.phase}`);
    await cold.page.waitForTimeout(200);
  }
  console.log('labels seen:', [...labels].join(' | '));
  const t = timing.times;
  const since = (name: string) => (t[name] ? +((t[name] - t.bootStart) / 1000).toFixed(2) : null);
  report.engineOpenS = since('engineOpen');
  report.scanS = t.scanDone ? +((t.scanDone - t.scanStart) / 1000).toFixed(2) : null;
  report.balanceRightS = since('balanceRight');
  report.liveS = since('live');
  report.scan = timing.scan;
  console.log('from unlock, seconds:', JSON.stringify(Object.fromEntries(Object.entries(t).map(([k, v]: any) => [k, +((v - t.bootStart) / 1000).toFixed(2)]))));
  console.log(`after unlock: engine open ${report.engineOpenS} s, scan ${report.scanS} s (${JSON.stringify(timing.scan)}), balance right ${report.balanceRightS} s, fully live ${report.liveS} s`);
  console.log(`normal sync through the same gap: ${truth.normalSeconds} s`);

  // The numbers have to match a normal sync exactly, or the fast path is wrong and wallet2 wins.
  await cold.page.waitForTimeout(16_000);
  const home = await call(cold.page, 'home');
  const expected = (Number(truth.balance) / 1e12).toFixed(12);
  console.log(`balance: fast ${home.balance}, normal ${expected}`);
  expect(home.balance).toBe(expected);
  const shown = (await call(cold.page, 'activity')).map((x: any) => x.hash).sort();
  console.log(`transactions: fast ${shown.length}, normal ${truth.txs.length}`);
  expect(shown).toEqual(truth.txs);
  await cold.page.reload();
  await cold.page.waitForSelector('[data-testid=balance]');
  await cold.page.waitForTimeout(500);
  await shot(cold.page, '2.4-after.png');

  // Open again while unlocked, the everyday case.
  const warm = await openPopup(context, id, '[data-testid=balance]');
  report.warmOpenFirstPaintMs = warm.firstPaint;
  report.warmOpenBalanceMs = warm.now;
  console.log(`open while unlocked: painted ${warm.firstPaint} ms, seen by test ${warm.now} ms`, JSON.stringify(warm.marks));

  // Can it build a payment right now?
  const second = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'stagenet-second-wallet.json'), 'utf8'));
  const build = Date.now();
  const estimate = await call(warm.page, 'estimate', { address: second.address, amount: '0.0001' }).catch((e: any) => ({ error: String(e.message ?? e) }));
  report.buildPaymentS = +((Date.now() - build) / 1000).toFixed(2);
  report.estimate = estimate;
  console.log(`built a payment in ${report.buildPaymentS} s:`, JSON.stringify(estimate));

  fs.writeFileSync(RESULT, JSON.stringify(report, null, 1));
  await context.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
