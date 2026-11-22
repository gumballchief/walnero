// The Wallets screens on the iPhone build, in WebKit at iPhone size, on brand-new empty real-Monero wallets (nothing is sent):
// a first wallet is made, a second one is added and used, switching back works, the active wallet survives a lock,
// the keys page checks the password and reveals the keys, a wallet can be renamed and removed (wrong password refused),
// and the first wallet's words are tried in a restore (recorded as information, not pass/fail).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { webkit } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '../.output/phone-web');
const SHOTS = path.resolve(import.meta.dirname, '../test-shots');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', TYPES[path.extname(f)] ?? 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
}).listen(4592);

const PASS = 'wallets-pass-1';
const HEX64 = /^[0-9a-f]{64}$/i;
const browser = await webkit.launch();
const checks = [];
const check = (ok, what) => checks.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
const info = (what) => checks.push(`INFO ${what}`);
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
await ctx.addInitScript(`window.__walneroNet = 'mainnet';`);
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: path.join(SHOTS, `wallets-${n}.png`) });
const isVisible = (testid) => page.getByTestId(testid).isVisible().catch(() => false);

// The active wallet's name in the header of the current screen.
const title = async () => ((await page.locator('.screen > .head span').first().innerText().catch(() => '')) || '').trim();
const waitTitle = async (want) => { for (let i = 0; i < 90 && (await title()) !== want; i++) await page.waitForTimeout(2000); return (await title()) === want; };
// Switching wallets restarts the engine, so allow up to 3 minutes.
const waitSynced = async () => {
  for (let i = 0; i < 90; i++) {
    if ((await isVisible('sync-label')) && (await page.getByTestId('sync-label').innerText().catch(() => '')) === 'Up to date') return true;
    await page.waitForTimeout(2000);
  }
  return false;
};
// The 25 words: each grid cell is a div holding a number and a word.
const readWords = (testid) => page.getByTestId(testid).evaluate((el) => [...el.children].filter((c) => c.tagName === 'DIV').map((c) => c.textContent.replace(/[0-9]/g, '').trim()));
const walletIds = () => page.locator('[data-testid^="wallet-row-"]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-testid').slice('wallet-row-'.length)))]);
const isCur = (id) => page.getByTestId(`wallet-row-${id}`).first().evaluate((el) => el.classList.contains('cur') || !!el.parentElement?.classList.contains('cur'));
const activeId = async () => { for (const id of await walletIds()) if (await isCur(id)) return id; return null; };

// Back out of sub pages until the tab bar is showing, then open Home.
const goHome = async () => {
  for (let i = 0; i < 5; i++) {
    if (await isVisible('tab-home')) { await page.getByTestId('tab-home').click(); break; }
    if (await isVisible('back')) { await page.getByTestId('back').click(); await page.waitForTimeout(500); } else break;
  }
  await page.waitForTimeout(500);
};
// Home -> Settings -> Wallets list.
const openWallets = async () => {
  await goHome();
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('set-wallets').waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  await page.getByTestId('set-wallets').click();
  await page.getByTestId('wallet-list').waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
};

try {
  await page.goto('http://localhost:4592/index.html');
  await page.getByTestId('create').click();
  await page.getByTestId('password').fill(PASS);
  await page.getByTestId('password2').fill(PASS);
  await page.getByTestId('password-go').click();
  await page.getByTestId('seed').waitFor({ timeout: 120000 });
  const mainWords = await readWords('seed');
  check(mainWords.length === 25 && mainWords.every(Boolean), `first wallet shows its 25 words (${mainWords.length})`);
  await page.getByTestId('seed-done').click();
  check(await waitSynced(), 'first wallet reaches Up to date');
  check((await title()) === 'Main wallet', `Home title is Main wallet (${await title()})`);

  // 2. One wallet, and it is the active one.
  await openWallets();
  const rowCount2 = await page.locator('[data-testid^="wallet-row-"]').count();
  check(rowCount2 === 1 && (await activeId()) === 'main', `Wallets list has 1 wallet, active (${rowCount2} rows, active ${await activeId()})`);
  await shot('list');

  // 3. Add Savings: 25 words, then Home switches to it and syncs.
  await page.getByTestId('wallet-add').click();
  await page.getByTestId('aw-label').waitFor({ timeout: 30000 });
  await page.getByTestId('aw-label').fill('Savings');
  await page.getByTestId('aw-create').click();
  await page.getByTestId('aw-words').waitFor({ timeout: 120000 });
  await page.waitForTimeout(500);
  const savingsWords = await readWords('aw-words');
  check(savingsWords.length === 25, `new wallet shows 25 words (${savingsWords.length})`);
  await shot('words');
  await page.getByTestId('aw-words-done').click();
  check(await waitTitle('Savings'), 'Home title becomes Savings');
  check(await waitSynced(), 'Savings reaches Up to date');
  const bal = await page.getByTestId('balance').innerText().catch(() => '');
  check(/\d/.test(bal), `Savings balance shows digits (${bal.trim()})`);

  // 4. Two wallets listed; tapping Main wallet switches back to it.
  await openWallets();
  const rowCount4 = await page.locator('[data-testid^="wallet-row-"]').count();
  check(rowCount4 === 2, `Wallets list has 2 rows (${rowCount4})`);
  await page.getByTestId('wallet-row-main').click();
  await page.waitForTimeout(500);
  await goHome();
  check(await waitTitle('Main wallet'), 'tapping Main wallet switches back to Main wallet');

  // 5. Lock, unlock: the active wallet is still Main wallet.
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('lock').waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  await page.getByTestId('lock').click();
  await page.getByTestId('unlock-password').waitFor({ timeout: 30000 });
  await page.getByTestId('unlock-password').fill(PASS);
  await page.getByTestId('unlock-go').click();
  await page.getByTestId('unlock-password').waitFor({ state: 'hidden', timeout: 120000 });
  await goHome();
  check(await waitTitle('Main wallet'), 'after lock and unlock the Home title is still Main wallet');

  // 6. Keys page: wrong password refused, right password reveals the keys.
  await openWallets();
  await page.getByTestId('wallet-more-main').click();
  await page.getByTestId('wd-keys').waitFor({ timeout: 30000 });
  await page.getByTestId('wd-keys').click();
  await page.getByTestId('keys-password').waitFor({ timeout: 30000 });
  await page.getByTestId('keys-password').fill('not-the-password');
  await page.getByTestId('keys-show').click();
  await page.getByTestId('keys-error').waitFor({ timeout: 30000 });
  const keysErr = await page.getByTestId('keys-error').innerText();
  check(/Wrong password/.test(keysErr), `keys page refuses a wrong password ("${keysErr.trim()}")`);

  await page.getByTestId('keys-password').fill(PASS);
  await page.getByTestId('keys-show').click();
  await page.getByTestId('keys-address').waitFor({ timeout: 30000 });
  const address = (await page.getByTestId('keys-address').innerText()).trim();
  check(address.startsWith('4') && address.length === 95, `primary address starts with 4 and is 95 characters (${address.length})`);
  const viewMasked = (await page.getByTestId('keys-view').innerText()).trim();
  const spendMasked = (await page.getByTestId('keys-spend').innerText()).trim();
  check(!HEX64.test(viewMasked) && !HEX64.test(spendMasked), 'view and spend keys start masked');
  await page.getByTestId('keys-reveal-view').click();
  await page.getByTestId('keys-reveal-spend').click();
  await page.waitForTimeout(500);
  const viewKey = (await page.getByTestId('keys-view').innerText()).trim();
  const spendKey = (await page.getByTestId('keys-spend').innerText()).trim();
  check(HEX64.test(viewKey), 'view key shows as 64 hex characters after reveal');
  check(HEX64.test(spendKey), 'spend key shows as 64 hex characters after reveal');
  check(viewKey !== spendKey, 'view and spend keys are different');
  const height = (await page.getByTestId('keys-height').innerText()).trim();
  check(/\d/.test(height), `restore height is a number (${height})`);
  await shot('keys');

  // 7. Rename Main wallet to Everyday.
  await page.getByTestId('back').click();
  await page.getByTestId('wd-label').waitFor({ timeout: 30000 });
  await page.getByTestId('wd-label').fill('Everyday');
  await page.getByTestId('wd-rename').click();
  await page.waitForTimeout(800);
  await page.getByTestId('back').click();
  await page.getByTestId('wallet-list').waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  const renamed = await page.locator('[data-testid^="wallet-row-"]').filter({ hasText: 'Everyday' }).count();
  check(renamed > 0, 'Wallets list shows the row renamed to Everyday');

  // 8. Remove Savings: wrong password refused, right password removes it.
  const otherId = (await walletIds()).find((id) => id !== 'main');
  await page.getByTestId(`wallet-more-${otherId}`).click();
  await page.getByTestId('wd-remove').waitFor({ timeout: 30000 });
  await page.getByTestId('wd-remove').click();
  await page.getByTestId('rm-password').waitFor({ timeout: 30000 });
  await page.getByTestId('rm-password').fill('not-the-password');
  await page.getByTestId('rm-go').click();
  await page.getByTestId('rm-error').waitFor({ timeout: 30000 });
  const rmErr = await page.getByTestId('rm-error').innerText();
  check(/Wrong password/.test(rmErr), `remove refuses a wrong password ("${rmErr.trim()}")`);
  await page.getByTestId('rm-password').fill(PASS);
  await page.getByTestId('rm-go').click();
  await page.getByTestId('wallet-list').waitFor({ timeout: 60000 });
  for (let i = 0; i < 15 && (await page.locator('[data-testid^="wallet-row-"]').count()) !== 1; i++) await page.waitForTimeout(2000);
  const rowCount8 = await page.locator('[data-testid^="wallet-row-"]').count();
  check(rowCount8 === 1, `after removing Savings the list has 1 wallet (${rowCount8})`);
  await shot('removed');

  // 9. Restore the first wallet's words into a new wallet. Recorded as information only.
  await page.getByTestId('wallet-add').click();
  await page.getByTestId('aw-label').waitFor({ timeout: 30000 });
  await page.getByTestId('aw-label').fill('Restored');
  await page.getByTestId('aw-restore').click();
  await page.getByTestId('aw-seed').waitFor({ timeout: 30000 });
  await page.getByTestId('aw-seed').fill(mainWords.join(' '));
  await page.getByTestId('aw-go').click();
  let outcome = '';
  for (let i = 0; i < 30 && !outcome; i++) {
    await page.waitForTimeout(2000);
    if ((await title()) === 'Restored') { outcome = 'accepted, Home now shows Restored'; break; }
    const errors = page.locator('[data-testid*="err"]');
    for (let j = 0; j < (await errors.count()); j++) {
      const el = errors.nth(j);
      const text = ((await el.isVisible().catch(() => false)) && (await el.innerText().catch(() => ''))) || '';
      if (text.trim()) { outcome = `refused, error shown: "${text.trim()}"`; break; }
    }
  }
  info(`restoring the first wallet's words into a new wallet: ${outcome || `no result after 60 s, still on "${await title()}"`}`);
  await page.waitForTimeout(800);
  await shot('restored');
} catch (error) {
  console.log('FAILED:', error.message);
} finally {
  console.log(checks.join('\n'));
  await browser.close();
  server.close();
}
