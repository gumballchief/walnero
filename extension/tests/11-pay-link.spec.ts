// Paying from a website: a real checkout page with a monero: link, on the test network. Never pays by itself, always names the real
// site, and a page can't trigger it with a scripted click. Sends a tiny amount of valueless test coin.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { test, expect, SHOTS } from './harness';

const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3-test');
const SYNTH = path.resolve(import.meta.dirname, '../../feed/data/synth');
const PASSWORD = 'test-network-password';
const launch = (dir: string) => chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, viewport: { width: 380, height: 640 }, args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
const extensionIdOf = async (context: BrowserContext) => new URL((context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))).url()).host;
const call = (page: Page, method: string, params?: unknown) => page.evaluate(([m, p]) => (window as any).walnero.call(m, p), [method, params] as const);
const shot = (page: Page, name: string) => { fs.mkdirSync(SHOTS, { recursive: true }); return page.screenshot({ path: path.join(SHOTS, name) }); };

test('pays a checkout page only after a real click, a review and a slide', async () => {
  test.setTimeout(420_000);
  const truth = JSON.parse(fs.readFileSync(path.join(SYNTH, 'month-old.json'), 'utf8'));
  const second = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'stagenet-second-wallet.json'), 'utf8'));
  const checkout = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Checkout</title><h1>Order 1042</h1>
      <a id="pay" href="monero:${second.address}?tx_amount=0.0001&recipient_name=Test%20Shop&tx_description=Order%201042">Pay 0.0001 XMR</a>
      <a id="bad" href="monero:notanaddress?tx_amount=1">Bad link</a>
      <a id="sneaky" href="monero:${second.address}?tx_amount=5">Hidden</a>`);
  });
  await new Promise<void>((resolve) => checkout.listen(8791, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnero-pay-'));
  const context = await launch(dir);
  try {
    const id = await extensionIdOf(context);
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${id}/popup.html`);
    await setup.waitForFunction(() => (window as any).walnero);
    await call(setup, 'testImport', { seed: truth.seed, password: PASSWORD, restoreHeight: truth.restoreHeight, walletPassword: truth.walletPassword, base: 'http://127.0.0.1:8788', savedAt: truth.savedAt });

    const shop = await context.newPage();
    await shop.goto('http://127.0.0.1:8791/');

    // A page clicking its own link in script: nothing may happen.
    let opened = 0;
    context.on('page', () => { opened++; });
    await shop.evaluate(() => (document.getElementById('sneaky') as HTMLAnchorElement).click());
    await shop.waitForTimeout(1500);
    expect(opened).toBe(0);

    // A broken link: nothing may happen.
    await shop.click('#bad');
    await shop.waitForTimeout(1500);
    expect(opened).toBe(0);

    // The script on web pages shares our extension id, but it must get nothing from the wallet. Run from inside that script's own
    // isolated world, the way a hacked tab would.
    const cdp = await context.newCDPSession(shop);
    const worlds: any[] = [];
    cdp.on('Runtime.executionContextCreated', (e: any) => worlds.push(e.context));
    await cdp.send('Runtime.enable');
    await shop.waitForTimeout(300);
    const ours = worlds.find((c) => String(c.origin).startsWith('chrome-extension://'));
    expect(ours, 'the page script is running').toBeTruthy();
    const attempt = await cdp.send('Runtime.evaluate', { contextId: ours.id, awaitPromise: true, returnByValue: true, expression: `chrome.runtime.sendMessage({ target: 'wallet', method: 'state' }).then((r) => JSON.stringify(r ?? 'no answer'), (e) => 'refused: ' + e.message)` });
    console.log('a page script asking the wallet for its state got:', attempt.result.value);
    expect(String(attempt.result.value)).not.toContain('exists');
    const lockAttempt = await cdp.send('Runtime.evaluate', { contextId: ours.id, awaitPromise: true, returnByValue: true, expression: `chrome.runtime.sendMessage({ target: 'wallet', method: 'send' }).then((r) => JSON.stringify(r ?? 'no answer'), (e) => 'refused: ' + e.message)` });
    expect(String(lockAttempt.result.value)).not.toContain('"ok"');
    await cdp.detach();

    // A real click.
    const [wallet] = await Promise.all([context.waitForEvent('page'), shop.click('#pay')]);
    await wallet.waitForLoadState();
    expect(wallet.url()).toContain('popup.html');
    await expect(wallet.getByTestId('unlock-password')).toBeVisible();
    await wallet.getByTestId('unlock-password').fill(PASSWORD);
    await wallet.getByTestId('unlock-go').click();

    await expect(wallet.getByTestId('pay-domain')).toHaveText('127.0.0.1', { timeout: 20_000 });
    await expect(wallet.getByTestId('pay-note')).toHaveText('Order 1042');
    await expect(wallet.getByTestId('send-amount')).toHaveValue('0.0001');
    await expect(wallet.getByTestId('send-amount')).toBeDisabled();
    await expect(wallet.getByTestId('send-address')).toHaveValue(second.address);
    await expect(wallet.getByTestId('send-address')).toBeDisabled();
    await wallet.waitForTimeout(400);
    await shot(wallet, '5.1-pay-request.png');

    // It must wait for a person. Nothing has been sent after sitting here.
    for (;;) { const t = await call(wallet, 'timing'); if (t?.phase === 'live') break; expect(t?.phase).not.toBe('slow'); await wallet.waitForTimeout(250); }
    await wallet.waitForTimeout(16_000);
    const before = await call(wallet, 'activity');
    expect(before.map((t: any) => t.hash).sort()).toEqual(truth.txs);

    await wallet.getByTestId('review-go').click();
    await expect(wallet.getByTestId('review')).toBeVisible({ timeout: 90_000 });
    await shot(wallet, '5.1-pay-review.png');

    // A second review somewhere else must make the first one's slide refuse, rather than send the wrong payment.
    const other = await context.newPage();
    await other.goto(`chrome-extension://${id}/popup.html`);
    await other.waitForFunction(() => (window as any).walnero);
    const second1 = await call(other, 'estimate', { address: second.address, amount: '0.0002' });
    const second2 = await call(other, 'estimate', { address: second.address, amount: '0.0003' });
    expect(second1.review).not.toBe(second2.review);
    const refused = await call(other, 'send', { review: second1.review }).catch((e: any) => String(e.message));
    console.log('sliding on an out of date review says:', refused);
    expect(refused).toContain('Review this one again');
    await call(other, 'send', {}).then(() => { throw new Error('a send with no review went through'); }, () => {});
    await other.close();
    await wallet.reload();
    await expect(wallet.getByTestId('review-go')).toBeVisible({ timeout: 20_000 });
    await wallet.getByTestId('review-go').click();
    await expect(wallet.getByTestId('review')).toBeVisible({ timeout: 90_000 });
    const slide = await wallet.getByTestId('slide').boundingBox();
    await wallet.mouse.move(slide!.x + 40, slide!.y + slide!.height / 2);
    await wallet.mouse.down();
    await wallet.mouse.move(slide!.x + slide!.width, slide!.y + slide!.height / 2, { steps: 14 });
    await wallet.mouse.up();
    await wallet.waitForFunction(async () => (await (window as any).walnero.call('activity')).some((t: any) => !t.incoming && !t.confirmed), null, { timeout: 90_000 }).catch(() => {});
    await wallet.waitForTimeout(16_000);
    const after = await call(wallet, 'activity');
    const fresh = after.filter((t: any) => !truth.txs.includes(t.hash));
    console.log('new payment:', JSON.stringify(fresh));
    expect(fresh.length).toBe(1);
    expect(fresh[0].incoming).toBe(false);
    expect(fresh[0].amount).toContain('0.0001');
  } finally {
    await context.close();
    checkout.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
