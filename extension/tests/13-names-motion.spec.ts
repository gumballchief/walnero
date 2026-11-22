// The fourth tab (Names) and the approved motion, on the real extension, with a real test-network send to a saved name.
// Records a video of the whole run to test-shots/motion.webm. Stagenet coins have no value.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, test, expect, type Page } from '@playwright/test';

const dir = import.meta.dirname;
const EXTENSION = path.resolve(dir, '../.output/chrome-mv3-test');
const SHOTS = path.resolve(dir, '../test-shots');
const wallet = JSON.parse(fs.readFileSync(path.resolve(dir, 'stagenet-test-wallet.json'), 'utf8'));
const second = JSON.parse(fs.readFileSync(path.resolve(dir, 'stagenet-second-wallet.json'), 'utf8'));
const BEFORE_FAUCET = 2243700;
const PASSWORD = 'test-network-password';
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, name) });

test('names tab, then send to a saved name with the full motion', async () => {
  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnero-video-'));
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, viewport: { width: 380, height: 600 }, deviceScaleFactor: 2,
    recordVideo: { dir: videoDir, size: { width: 760, height: 1200 } },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const popupUrl = `chrome-extension://${new URL(worker.url()).host}/popup.html`;
  const popup = await context.newPage();
  const problems: string[] = [];
  popup.on('pageerror', (e) => problems.push(e.message));
  await popup.goto(popupUrl);

  await popup.getByTestId('restore').click();
  await popup.getByTestId('restore-seed').fill(wallet.seed);
  await popup.getByTestId('restore-password').fill(PASSWORD);
  await popup.getByTestId('restore-height').fill(String(BEFORE_FAUCET));
  await popup.getByTestId('restore-go').click();
  await expect(popup.getByTestId('sync-label')).toHaveText('Up to date', { timeout: 420_000 });
  const before = await popup.evaluate(() => (window as any).walnero.call('home'));
  console.log(`balance ${before.balance}, unlocked ${before.unlocked}`);
  test.skip(Number(before.unlocked) < 0.002, 'No unlocked test coins');

  // Close and reopen like a person would: lock screen, then the opening on unlock.
  await popup.getByTestId('tab-settings').click();
  await popup.getByTestId('lock').click();
  await popup.waitForTimeout(1200);
  await popup.goto(popupUrl);
  await expect(popup.getByTestId('unlock-password')).toBeVisible();
  await popup.waitForTimeout(900);
  await shot(popup, 'motion-1-lock.png');
  await popup.getByTestId('unlock-password').fill(PASSWORD);
  await popup.getByTestId('unlock-go').click();
  await expect(popup.getByTestId('balance')).toBeVisible();
  await popup.waitForTimeout(250);
  await shot(popup, 'motion-2-opening.png');
  await popup.waitForTimeout(1800);
  await shot(popup, 'motion-3-home.png');
  await expect(popup.locator('nav button')).toHaveCount(4);
  await expect(popup.locator('nav')).toContainText('Names');

  // Names: empty, then save one.
  await popup.getByTestId('tab-names').click();
  await expect(popup.getByTestId('names-empty')).toBeVisible();
  await popup.waitForTimeout(700);
  await shot(popup, 'motion-4-names-empty.png');
  await popup.getByTestId('name-add').click();
  await popup.getByTestId('name-address').fill('not-an-address');
  await popup.getByTestId('name-input').pressSequentially('kestrel', { delay: 60 });
  await popup.getByTestId('name-save').click();
  await expect(popup.getByTestId('name-error')).toContainText("isn't a valid");
  await popup.getByTestId('name-address').fill(second.address);
  await popup.waitForTimeout(400);
  await shot(popup, 'motion-5-name-add.png');
  await popup.getByTestId('name-save').click();
  await expect(popup.getByTestId('name-row-kestrel')).toBeVisible({ timeout: 20_000 });
  await popup.waitForTimeout(800);
  await shot(popup, 'motion-6-names.png');

  // Send: keypad, Next, tap the saved name, slide.
  await popup.getByTestId('tab-home').click();
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('key-1')).toBeVisible();
  await popup.waitForTimeout(900);
  for (const k of ['0', '.', '0', '0', '1']) { await popup.getByTestId(`key-${k}`).click(); await popup.waitForTimeout(260); }
  await expect(popup.getByTestId('send-amount')).toHaveValue('0.001');
  await popup.waitForTimeout(400);
  await shot(popup, 'motion-7-amount.png');
  await popup.getByTestId('amount-next').click();
  await expect(popup.getByTestId('pick-kestrel')).toBeVisible();
  await popup.waitForTimeout(900);
  await shot(popup, 'motion-8-to.png');
  await popup.getByTestId('pick-kestrel').click();
  await expect(popup.getByTestId('review')).toBeVisible({ timeout: 60_000 });
  await expect(popup.getByTestId('send-to-full')).toHaveText(second.address);
  await popup.waitForTimeout(900);
  await shot(popup, 'motion-9-review.png');

  const slide = await popup.getByTestId('slide').boundingBox();
  await popup.mouse.move(slide!.x + 40, slide!.y + slide!.height / 2);
  await popup.mouse.down();
  await popup.mouse.move(slide!.x + slide!.width, slide!.y + slide!.height / 2, { steps: 24 });
  await popup.mouse.up();
  await expect(popup.getByTestId('sending')).toBeVisible();
  await popup.waitForTimeout(500);
  await shot(popup, 'motion-10-sending.png');
  await expect(popup.getByTestId('tx-hash')).toBeVisible({ timeout: 90_000 });
  await expect(popup.getByTestId('sent-line')).toHaveText('0.0010 XMR to @kestrel');
  const hash = (await popup.getByTestId('tx-hash').innerText()).trim();
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  console.log('tx hash', hash);
  await popup.waitForTimeout(1400);
  await shot(popup, 'motion-11-sent.png');

  // Back on Home: the balance rolls down, the Monero row lights its edge, Activity gets a dot.
  await popup.getByTestId('done').click();
  await expect(popup.getByTestId('balance')).toBeVisible();
  await popup.waitForTimeout(900);
  await shot(popup, 'motion-12-back-home.png');
  await expect(popup.getByTestId('activity-dot')).toBeVisible({ timeout: 60_000 });
  await popup.waitForTimeout(700);
  await shot(popup, 'motion-13-dot.png');
  await popup.getByTestId('tab-activity').click();
  await expect(popup.getByTestId('activity-dot')).toHaveCount(0);
  await popup.waitForTimeout(1200);

  // A server the wallet didn't talk to has to know the payment.
  await expect.poll(async () => {
    const res = await fetch('https://stagenet.xmr.kernal.eu:38089/get_transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txs_hashes: [hash] }) });
    return Boolean((await res.json()).txs?.length);
  }, { timeout: 180_000, intervals: [10_000] }).toBe(true);
  console.log('an independent server has the transaction');

  const video = popup.video();
  await context.close();
  if (video) fs.copyFileSync(await video.path(), path.join(SHOTS, 'motion.webm'));
  expect(problems, problems.join('\n')).toEqual([]);
});
