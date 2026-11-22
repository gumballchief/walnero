// Stage 1.4, the parts that don't need coins: the receive address and QR are right, and bad sends are refused clearly.
import fs from 'node:fs';
import path from 'node:path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { test, expect, SHOTS } from './harness';

const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'stagenet-test-wallet.json'), 'utf8'));
const NODE = 'http://node2.monerodevs.org:38089';

test('receive shows a scannable address; send refuses bad input', async ({ popup }) => {
  const info = await (await fetch(`${NODE}/get_info`)).json();
  await popup.getByTestId('restore').click();
  await popup.getByTestId('restore-seed').fill(fixture.seed);
  await popup.getByTestId('restore-password').fill('test-network-password');
  await popup.getByTestId('restore-height').fill(String(info.height - 10));
  await popup.getByTestId('restore-go').click();
  await expect(popup.getByTestId('balance')).toBeVisible({ timeout: 90_000 });

  await popup.getByTestId('receive').click();
  const qr = popup.getByTestId('qr');
  await expect(qr).toBeVisible({ timeout: 30_000 });
  const address = await popup.getByTestId('address').innerText();
  expect(address.length).toBe(95);
  await popup.waitForTimeout(700);
  const png = PNG.sync.read(await qr.screenshot());
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  console.log('QR decodes to the shown address:', decoded?.data === address);
  expect(decoded?.data).toBe(address);
  await popup.screenshot({ path: path.join(SHOTS, '1.4-receive.png') });

  await popup.getByTestId('back').click();
  await expect(popup.getByTestId('send')).toBeVisible();
  await expect(popup.getByTestId('sync-label')).toHaveText('Up to date', { timeout: 300_000 });
  await popup.getByTestId('send').click();
  await popup.getByTestId('send-amount').fill('1');
  await popup.getByTestId('amount-next').click();
  await popup.getByTestId('send-address').fill('not-an-address');
  await popup.getByTestId('review-go').click();
  await expect(popup.getByTestId('send-error')).toContainText("isn't a valid");
  await popup.getByTestId('send-address').fill(address);
  await popup.getByTestId('review-go').click();
  await expect(popup.getByTestId('send-error')).toBeVisible({ timeout: 60_000 });
  await expect(popup.getByTestId('send-error')).not.toContainText("isn't a valid", { timeout: 30_000 });
  console.log('send with no coins says:', await popup.getByTestId('send-error').innerText());
  await popup.waitForTimeout(600);
  await popup.screenshot({ path: path.join(SHOTS, '1.4-send-refused.png') });
});
