// The Node screen in the real-Monero Chrome extension build: a new empty wallet, Settings, Network, Node, every built-in node
// tested, and picking one moves the wallet there. Adding a node needs Chrome's permission prompt, which only a person can answer.
import path from 'node:path';
import { chromium } from '@playwright/test';

const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3-mainnet');
const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const id = new URL(worker.url()).host;
const page = await context.newPage();
await page.setViewportSize({ width: 380, height: 600 });
const checks = [];
const check = (ok, what) => checks.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
try {
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.getByTestId('create').click();
  await page.getByTestId('password').fill('ext-node-pass-1');
  await page.getByTestId('password2').fill('ext-node-pass-1');
  await page.getByTestId('password-go').click();
  await page.getByTestId('seed').waitFor({ timeout: 120000 });
  await page.getByTestId('seed-done').click();
  for (let i = 0; i < 150; i++) { if ((await page.getByTestId('sync-label').innerText().catch(() => '')) === 'Up to date') break; await page.waitForTimeout(2000); }
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('set-network').click();
  await page.getByTestId('set-node').click();
  await page.getByTestId('node-list').waitFor();
  for (let i = 0; i < 30 && (await page.locator('.nstat .ms', { hasText: 'Testing' }).count()); i++) await page.waitForTimeout(500);
  const rows = await page.locator('.nrow').count();
  const answered = await page.locator('.sig').count();
  check(rows === 13 && answered >= 10, `all ${rows} Chrome nodes listed, ${answered} answered with a speed`);
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../test-shots/ext-node-list.png'), fullPage: false });
  await page.getByTestId('node-node.monerodevs.org:18089').click();
  for (let i = 0; i < 20 && (await page.locator('.nrow.cur .nmain').getAttribute('data-testid')) !== 'node-node.monerodevs.org:18089'; i++) await page.waitForTimeout(500);
  check((await page.locator('.nrow.cur .nmain').getAttribute('data-testid')) === 'node-node.monerodevs.org:18089', 'picking MoneroDevs (Chrome only) moves the wallet there');
  await page.getByTestId('tab-home').click();
  for (let i = 0; i < 30; i++) { if ((await page.getByTestId('sync-label').innerText()) === 'Up to date') break; await page.waitForTimeout(1000); }
  check((await page.getByTestId('sync-label').innerText()) === 'Up to date', 'Home is up to date on MoneroDevs');
} catch (error) {
  console.log('FAILED:', error.message);
} finally {
  console.log(checks.join('\n'));
  await context.close();
}
