// Every state someone can actually land in: servers down, and coming back, with the last balance kept on screen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { test, expect, SHOTS } from './harness';

const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3-test');
const SYNTH = path.resolve(import.meta.dirname, '../../feed/data/synth');
const REAL_NODES = ['http://node2.monerodevs.org:38089', 'http://node3.monerodevs.org:38089', 'https://stagenet.xmr.kernal.eu:38089'];
const PASSWORD = 'test-network-password';
const launch = (dir: string) => chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, viewport: { width: 380, height: 600 }, args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
const extensionIdOf = async (context: BrowserContext) => new URL((context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))).url()).host;
const call = (page: Page, method: string, params?: unknown) => page.evaluate(([m, p]) => (window as any).walnero.call(m, p), [method, params] as const);
const shot = (page: Page, name: string) => { fs.mkdirSync(SHOTS, { recursive: true }); return page.screenshot({ path: path.join(SHOTS, name) }); };

test('servers down: last balance stays, Send says why, and it recovers by itself', async () => {
  test.setTimeout(420_000);
  const truth = JSON.parse(fs.readFileSync(path.join(SYNTH, 'month-old.json'), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnero-state-'));
  const context = await launch(dir);
  try {
    const id = await extensionIdOf(context);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup.html`);
    await page.waitForFunction(() => (window as any).walnero);
    await call(page, 'testImport', { seed: truth.seed, password: PASSWORD, restoreHeight: truth.restoreHeight, walletPassword: truth.walletPassword, base: 'http://127.0.0.1:8788', savedAt: truth.savedAt });

    // Get a real balance saved first.
    await call(page, 'unlock', { password: PASSWORD });
    for (;;) { const t = await call(page, 'timing'); if (t?.phase === 'live') break; await page.waitForTimeout(250); }
    await page.waitForTimeout(16_000);
    const known = await call(page, 'home');
    expect(Number(known.balance)).toBeGreaterThan(0);
    await call(page, 'lock');

    // Every server gone.
    await call(page, 'testNodes', { nodes: ['http://127.0.0.1:9', 'http://127.0.0.1:10'] });
    await call(page, 'unlock', { password: PASSWORD });
    await page.reload();
    await expect(page.getByTestId('offline-note')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('sync-label')).toHaveText('Offline');
    const offline = await call(page, 'home');
    expect(offline.balance).toBe(known.balance);
    expect(offline.synced).toBe(false);
    await expect(page.getByTestId('send')).toBeDisabled();
    await page.waitForTimeout(600);
    await shot(page, '4.2-offline.png');

    // Receive still works, from the addresses saved ahead of time.
    const { address } = await call(page, 'receive');
    expect(address.length).toBe(95);

    // Servers come back: no tap needed.
    await call(page, 'testNodes', { nodes: REAL_NODES });
    await expect(page.getByTestId('sync-label')).toHaveText('Up to date', { timeout: 240_000 });
    const back = await call(page, 'home');
    expect(back.balance).toBe(known.balance);
    await expect(page.getByTestId('send')).toBeEnabled();
    console.log('came back by itself, balance', back.balance);
  } finally {
    await context.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a brand new wallet: nothing to show, and it says what to do', async ({ popup }) => {
  test.setTimeout(240_000);
  await popup.getByTestId('create').click();
  await popup.getByTestId('password').fill(PASSWORD);
  await popup.getByTestId('password2').fill(PASSWORD);
  await popup.getByTestId('password-go').click();
  await expect(popup.getByTestId('seed')).toBeVisible({ timeout: 90_000 });
  await popup.getByTestId('seed-done').click();
  await expect(popup.getByTestId('balance')).toBeVisible({ timeout: 30_000 });
  await expect(popup.getByTestId('sync-label')).toHaveText(/Checking|Setting up/);
  await expect(popup.getByTestId('send')).toBeDisabled();
  await popup.waitForTimeout(800);
  await shot(popup, '4.2-new-wallet.png');
  await popup.getByTestId('receive').click();
  await expect(popup.getByTestId('qr')).toBeVisible({ timeout: 30_000 });
  await popup.getByTestId('back').click();
  await popup.getByTestId('tab-activity').click();
  await expect(popup.getByTestId('activity')).toContainText('Nothing here yet');
  await popup.waitForTimeout(500);
  await shot(popup, '4.2-empty-activity.png');
});
