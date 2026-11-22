// Stage 1.4's last proof: a real stagenet payment. It skips itself until the test wallet has unlocked faucet coins,
// because the faucet has a CAPTCHA that a person has to solve.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, SHOTS } from './harness';

const dir = import.meta.dirname;
const wallet = JSON.parse(fs.readFileSync(path.resolve(dir, 'stagenet-test-wallet.json'), 'utf8'));
const second = JSON.parse(fs.readFileSync(path.resolve(dir, 'stagenet-second-wallet.json'), 'utf8'));
const BEFORE_FAUCET = 2243700;
const AMOUNT = '0.001';

test('send real test coins and find them on the explorer', async ({ popup }) => {
  await popup.getByTestId('restore').click();
  await popup.getByTestId('restore-seed').fill(wallet.seed);
  await popup.getByTestId('restore-password').fill('test-network-password');
  await popup.getByTestId('restore-height').fill(String(BEFORE_FAUCET));
  await popup.getByTestId('restore-go').click();
  await expect(popup.getByTestId('sync-label')).toHaveText('Up to date', { timeout: 300_000 });

  const home = await popup.evaluate(() => (window as any).walnero.call('home'));
  console.log(`balance ${home.balance}, unlocked ${home.unlocked}`);
  test.skip(Number(home.unlocked) < 0.002, 'No unlocked faucet coins yet');
  await popup.waitForTimeout(800);
  await popup.screenshot({ path: path.join(SHOTS, '1.4-funded-home.png') });

  await popup.getByTestId('send').click();
  await popup.getByTestId('send-amount').fill(AMOUNT);
  await popup.getByTestId('amount-next').click();
  await popup.getByTestId('send-address').fill(second.address);
  await popup.getByTestId('review-go').click();
  await expect(popup.getByTestId('review')).toBeVisible({ timeout: 60_000 });
  console.log('network fee', await popup.getByTestId('fee').innerText());
  await popup.screenshot({ path: path.join(SHOTS, '1.4-review.png') });

  // Slide to send with a real drag.
  const slide = await popup.getByTestId('slide').boundingBox();
  await popup.mouse.move(slide!.x + 40, slide!.y + slide!.height / 2);
  await popup.mouse.down();
  await popup.mouse.move(slide!.x + slide!.width, slide!.y + slide!.height / 2, { steps: 14 });
  await popup.mouse.up();

  await expect(popup.getByTestId('tx-hash')).toBeVisible({ timeout: 90_000 });
  await popup.waitForTimeout(1200);
  const hash = (await popup.getByTestId('tx-hash').innerText()).trim();
  console.log('tx hash', hash);
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  await popup.screenshot({ path: path.join(SHOTS, '1.4-sent.png') });

  // Servers the wallet didn't talk to have to know this transaction, or it didn't really happen.
  for (const node of ['http://node2.monerodevs.org:38089', 'https://stagenet.xmr.kernal.eu:38089']) {
    await expect.poll(async () => {
      const res = await fetch(`${node}/get_transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txs_hashes: [hash] }) });
      return Boolean((await res.json()).txs?.length);
    }, { timeout: 180_000, intervals: [10_000] }).toBe(true);
    console.log(`${node} has the transaction`);
  }
});
