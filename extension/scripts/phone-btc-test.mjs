// Bitcoin on the iPhone build, in WebKit at iPhone size, with brand-new empty wallets (nothing is sent).
// A wallet made from 12 words also holds Bitcoin at its native SegWit addresses (bc1q..., BIP84). Its first receive address is
// the one any BIP84 wallet would show from the same words. Sending is refused without funds, and a 25-word wallet is told it
// needs 12 words for Bitcoin.
// Run with: node --experimental-strip-types scripts/phone-btc-test.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { webkit } from '@playwright/test';
import { rootKey } from '../src/wallet/phrase.ts';
import { BtcAccount, accountKey, btcNet } from '../src/wallet/btc.ts';

const require = createRequire(import.meta.url);
const monero = require('monero-ts');
const lib = monero.default ?? monero;
const ROOT = path.resolve(import.meta.dirname, '../.output/phone-web');
const SHOTS = path.resolve(import.meta.dirname, '../test-shots');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', TYPES[path.extname(f)] ?? 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
}).listen(4595);

const NODES = ['https://xmr-node.cakewallet.com:18081', 'https://monero.definitelynotafed.com', 'https://xmr.support:18089', 'https://xmr-01.tari.com'];
const tip = await Promise.any(NODES.map(async (n) => (await (await fetch(`${n}/get_info`, { signal: AbortSignal.timeout(10000) })).json()).height));
const START = String(tip - 20);

const PASS = 'btc-pass-1';
const BAD_ADDRESS = 'bc1qnotanaddressxxxxxxxxxxxxxxxxxx';
const GOOD_ADDRESS = 'bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c';
const browser = await webkit.launch();
const checks = [];
const check = (ok, what) => checks.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
await ctx.addInitScript(`window.__walneroNet = 'mainnet';`);
const page = await ctx.newPage();
let pageErrors = 0;
page.on('pageerror', () => { pageErrors++; });
const shot = (n) => page.screenshot({ path: path.join(SHOTS, `btc-${n}.png`) });
const isVisible = (testid) => page.getByTestId(testid).isVisible().catch(() => false);
const readWords = (testid) => page.getByTestId(testid).evaluate((el) => [...el.children].map((c) => c.textContent.replace(/[0-9]/g, '').trim()).join(' '));
const textOf = (testid) => page.getByTestId(testid).innerText().then((t) => t.trim()).catch(() => '');
// Polls an element's text until it matches, up to the given number of seconds.
const waitText = async (testid, pattern, secs = 60) => {
  for (let i = 0; i < secs; i++) {
    const t = await textOf(testid);
    if (pattern.test(t)) return t;
    await page.waitForTimeout(1000);
  }
  return textOf(testid);
};
const waitSynced = async () => {
  for (let i = 0; i < 90; i++) {
    if ((await isVisible('sync-label')) && (await textOf('sync-label')) === 'Up to date') return true;
    await page.waitForTimeout(2000);
  }
  return false;
};
const goHome = async () => {
  for (let i = 0; i < 5; i++) {
    if (await isVisible('tab-home')) { await page.getByTestId('tab-home').click(); break; }
    if (await isVisible('back')) { await page.getByTestId('back').click(); await page.waitForTimeout(500); } else break;
  }
  await page.waitForTimeout(500);
};
const goBack = async () => { await page.getByTestId('back').click(); await page.waitForTimeout(600); };
const openSettings = async () => { await goHome(); await page.getByTestId('tab-settings').click(); await page.getByTestId('set-wallets').waitFor({ timeout: 30000 }); await page.waitForTimeout(400); };
// Opens the add-wallet restore form, fills in the phrase and the restore height, and submits it.
const addWallet = async (phrase, height) => {
  await openSettings();
  await page.getByTestId('set-wallets').click();
  await page.getByTestId('wallet-add').click();
  await page.getByTestId('aw-restore').click();
  await page.getByTestId('aw-seed').fill(phrase);
  if (height) await page.getByTestId('aw-height').fill(height);
  await page.getByTestId('aw-go').click();
};

// What the Bitcoin account of a 12-word phrase should show first, computed here from the same words.
const btcFirstAddress = async (phrase) => {
  const net = btcNet(true);
  const acct = new BtcAccount(accountKey(await rootKey(phrase), net), net);
  return acct.address(0, 0);
};

try {
  // 1. A brand-new wallet gets 12 words and a Bitcoin token that reads its balance.
  await page.goto('http://localhost:4595/index.html');
  await page.getByTestId('create').click();
  await page.getByTestId('password').fill(PASS);
  await page.getByTestId('password2').fill(PASS);
  await page.getByTestId('password-go').click();
  await page.getByTestId('seed').waitFor({ timeout: 120000 });
  const phrase = await readWords('seed');
  check(phrase.split(' ').length === 12, `a new wallet shows 12 words (${phrase.split(' ').length})`);
  const expectedBtc = await btcFirstAddress(phrase);
  await page.getByTestId('seed-done').click();
  check(await waitSynced(), 'the new wallet reaches Up to date');
  check(await isVisible('token-btc'), 'Home shows the Bitcoin row (token-btc)');
  const balance = await waitText('btc-balance', /^0\.00$/, 90);
  check(/^0\.00$/.test(balance), `the first Bitcoin read finishes with a 0.00 balance ("${balance}")`);

  // 2. The Bitcoin screen opens with its info and an empty activity list.
  await page.getByTestId('token-btc').click();
  await page.waitForTimeout(800);
  const header = await page.locator('.head > span:visible').allInnerTexts();
  check(header.map((s) => s.trim()).includes('Bitcoin'), `the Bitcoin screen header reads Bitcoin (${header.map((s) => s.trim()).join(' | ')})`);
  check(/BTC/.test(await textOf('token-info')), 'the token info card contains BTC');
  check(/No Bitcoin activity yet\./.test(await textOf('token-activity')), 'the activity list says No Bitcoin activity yet.');
  await shot('1-token');
  await goBack();

  // 3. Receive: a bc1q address that matches the one computed from the same 12 words, with a QR code.
  await page.getByTestId('token-btc').click();
  await page.getByTestId('token-receive').click();
  await page.getByTestId('btc-address').waitFor({ timeout: 30000 });
  const addr = (await textOf('btc-address')).replace(/\s+/g, '');
  check(addr.startsWith('bc1q'), `the receive address starts with bc1q (${addr})`);
  check(addr === expectedBtc, `the receive address is the first BIP84 address from the same 12 words (${expectedBtc})`);
  check(await isVisible('btc-qr'), 'the receive screen shows the QR code');
  await shot('2-receive');
  await goBack();
  await goBack();

  // 4. Send: fee speeds load, Fast can be picked, bad and unfunded payments are refused, Max fills Everything.
  await page.getByTestId('token-btc').click();
  await page.getByTestId('token-send').click();
  const speedText = await waitText('speed-normal', /sat\/vB/, 60);
  check(/sat\/vB/.test(speedText), `fee speeds load (normal: "${speedText}")`);
  check((await page.getByTestId('speed-normal').getAttribute('aria-pressed')) === 'true', 'Normal fee is picked by default');
  await page.getByTestId('speed-fast').click();
  await page.waitForTimeout(400);
  check((await page.getByTestId('speed-fast').getAttribute('aria-pressed')) === 'true', 'Fast fee can be picked');
  await page.getByTestId('btc-amount').fill('0.001');
  await page.getByTestId('btc-to').fill(BAD_ADDRESS);
  await page.getByTestId('btc-review-go').click();
  const badAddrErr = await waitText('btc-send-error', /valid Bitcoin address/, 20);
  check(/valid Bitcoin address/.test(badAddrErr), `a malformed address is refused ("${badAddrErr}")`);
  await page.getByTestId('btc-to').fill(GOOD_ADDRESS);
  await page.getByTestId('btc-review-go').click();
  const noFundsErr = await waitText('btc-send-error', /No Bitcoin ready|enough/i, 30);
  check(/No Bitcoin ready|enough/i.test(noFundsErr), `an empty wallet refuses to send ("${noFundsErr}")`);
  await page.getByTestId('btc-max').click();
  await page.waitForTimeout(400);
  const amountValue = await page.getByTestId('btc-amount').inputValue();
  check(amountValue === 'Everything', `Max sets the amount to Everything (got "${amountValue}")`);
  await shot('3-send');
  await goBack();
  await goBack();

  // 5. Manage tokens: Bitcoin can be switched off and back on.
  await goHome();
  await page.getByTestId('manage-tokens').click();
  const btcSwitch = page.locator('[role="switch"][aria-label="Bitcoin"]');
  await btcSwitch.waitFor({ timeout: 30000 });
  await btcSwitch.click();
  await page.waitForTimeout(600);
  check((await btcSwitch.getAttribute('aria-checked')) === 'false', 'the Bitcoin switch turns off');
  await goHome();
  check(!(await isVisible('token-btc')), 'with Bitcoin off, Home no longer shows token-btc');
  await page.getByTestId('manage-tokens').click();
  await btcSwitch.waitFor({ timeout: 30000 });
  await btcSwitch.click();
  await page.waitForTimeout(600);
  check((await btcSwitch.getAttribute('aria-checked')) === 'true', 'the Bitcoin switch turns back on');
  await goHome();
  await page.getByTestId('token-btc').waitFor({ timeout: 30000 }).catch(() => {});
  check(await isVisible('token-btc'), 'with Bitcoin back on, Home shows token-btc again');

  // 6. A 25-word wallet is told it needs 12 words for Bitcoin.
  const w25 = await lib.createWalletKeys({ networkType: lib.MoneroNetworkType.MAINNET, language: 'English' });
  const seed25 = await w25.getSeed();
  await addWallet(seed25, START);
  check(await waitSynced(), 'the 25-word wallet is added and reaches Up to date');
  await page.getByTestId('token-btc').waitFor({ timeout: 30000 }).catch(() => {});
  const btcRow = await textOf('token-btc');
  check(/Needs a 12-word wallet/.test(btcRow), `Home's Bitcoin row says Needs a 12-word wallet ("${btcRow.replace(/\s+/g, ' ')}")`);
  await page.getByTestId('token-btc').click();
  await page.getByTestId('btc-blocked').waitFor({ timeout: 30000 }).catch(() => {});
  const blocked = await textOf('btc-blocked');
  check(await isVisible('btc-blocked') && /12 words/.test(blocked), `the Bitcoin screen explains it needs 12 words ("${blocked.replace(/\s+/g, ' ')}")`);
  await shot('4-blocked');

  // 7. The Activity tab loads without page errors.
  const errorsBefore = pageErrors;
  await goHome();
  await page.getByTestId('tab-activity').click();
  await page.waitForTimeout(1500);
  check(pageErrors === errorsBefore, `the Activity tab loads without errors (page errors: ${pageErrors - errorsBefore})`);
} catch (error) {
  console.log('FAILED:', error.message);
  await shot('failed').catch(() => {});
} finally {
  console.log(checks.join('\n'));
  await browser.close();
  server.close();
  process.exit(0);
}
