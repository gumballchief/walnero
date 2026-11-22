// The swap screen with real, live prices. It must not be able to start a swap on the test network. Needs server/dev.mjs running.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, SHOTS } from './harness';

const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'stagenet-second-wallet.json'), 'utf8'));
const shot = (page: any, name: string) => { fs.mkdirSync(SHOTS, { recursive: true }); return page.screenshot({ path: path.join(SHOTS, name) }); };

test('live prices in both directions, every state, and no way to start a swap yet', async ({ popup }) => {
  test.setTimeout(240_000);
  const info = await (await fetch('http://node2.monerodevs.org:38089/get_info')).json();
  await popup.waitForFunction(() => (window as any).walnero);
  await popup.evaluate(([seed, h]) => (window as any).walnero.call('restore', { seed, password: 'test-network-password', restoreHeight: h }), [fixture.seed, info.height - 10] as const);
  await popup.reload();
  await expect(popup.getByTestId('balance')).toBeVisible({ timeout: 30_000 });
  await popup.getByTestId('swap').click();
  await expect(popup.getByTestId('swap-amount')).toBeVisible();
  await shot(popup, '3.3-swap-empty.png');

  // The price has to match what the partner itself says right now, not just be a number.
  await popup.getByTestId('swap-amount').fill('100');
  await expect(popup.getByTestId('swap-partner')).toHaveText('Exolix', { timeout: 15_000 });
  const shown = Number(await popup.locator('.swap-out').innerText());
  const direct = await (await fetch('https://exolix.com/api/v2/rate?coinFrom=USDT&networkFrom=TRX&coinTo=XMR&networkTo=XMR&amount=100&rateType=float')).json();
  console.log(`100 USDT: screen says ${shown} XMR, Exolix says ${direct.toAmount}`);
  expect(Math.abs(shown - direct.toAmount) / direct.toAmount).toBeLessThan(0.01);
  await popup.waitForTimeout(500);
  await shot(popup, '3.3-swap-quote.png');

  await popup.getByTestId('swap-go').waitFor();
  await expect(popup.getByTestId('swap-go')).toBeDisabled();

  await popup.getByTestId('swap-amount').fill('1');
  await expect(popup.getByTestId('swap-low')).toContainText('smallest swap', { timeout: 15_000 });
  await shot(popup, '3.3-swap-too-small.png');

  await popup.getByTestId('pick-coin').click();
  await expect(popup.getByTestId('coin-list')).toBeVisible();
  await popup.waitForTimeout(500);
  await shot(popup, '3.3-swap-coins.png');
  await popup.getByTestId('coin-btc').click();
  await popup.getByTestId('swap-amount').fill('0.01');
  await expect(popup.getByTestId('swap-facts')).toContainText('BTC', { timeout: 15_000 });
  console.log('0.01 BTC buys', await popup.locator('.swap-out').innerText(), 'XMR');

  await popup.getByTestId('swap-flip').click();
  await popup.getByTestId('swap-amount').fill('1');
  await expect(popup.getByTestId('swap-facts')).toContainText('1 XMR =', { timeout: 15_000 });
  console.log('1 XMR sells for', await popup.locator('.swap-out').innerText(), 'BTC');
  await popup.waitForTimeout(400);
  await shot(popup, '3.5-swap-out.png');

  // Server gone: says so instead of showing a stale number as if it were live.
  await popup.route('**/api/quote**', (route) => route.abort());
  await popup.getByTestId('swap-amount').fill('2');
  await expect(popup.getByTestId('swap-down')).toBeVisible({ timeout: 15_000 });
  await expect(popup.getByTestId('swap-facts')).toHaveCount(0);
  await expect(popup.locator('.swap-out')).toHaveText('0');
  await shot(popup, '3.3-swap-down.png');
});
