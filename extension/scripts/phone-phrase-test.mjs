// The 12-word phrase on the iPhone build, in WebKit at iPhone size, with brand-new empty real-Monero wallets (nothing is sent).
// A new wallet gets 12 words, and its address is the one Cake Wallet would open from them. Cake's own test phrase restores
// to Cake's expected wallet, its 25 Monero words show on request, the same wallet's 25 words are recognised as the same
// wallet, and a typo in the 12 words is caught.
// Run with: node --experimental-strip-types scripts/phone-phrase-test.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { webkit } from '@playwright/test';
import { rootKey, moneroSpendKey } from '../src/wallet/phrase.ts';

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
}).listen(4594);

// What Cake Wallet makes of a phrase: its Monero address and 25 words.
const cakeWallet = async (phrase) => {
  const keys = await lib.createWalletKeys({ networkType: lib.MoneroNetworkType.MAINNET, privateSpendKey: moneroSpendKey(await rootKey(phrase)) });
  return { address: await keys.getPrimaryAddress(), seed: await keys.getSeed() };
};
const CAKE_PHRASE = 'meadow tip best belt boss eyebrow control affair eternal piece very shiver';
const CAKE_SEED = 'tasked eight afraid laboratory tail feline rift reinvest vane cafe bailed foggy dormant paper jigsaw king hazard suture king dapper dummy jolted dating dwindling king';
const NODES = ['https://xmr-node.cakewallet.com:18081', 'https://monero.definitelynotafed.com', 'https://xmr.support:18089', 'https://xmr-01.tari.com'];
const tip = await Promise.any(NODES.map(async (n) => (await (await fetch(`${n}/get_info`, { signal: AbortSignal.timeout(10000) })).json()).height));
const START = String(tip - 20);

const PASS = 'phrase-pass-1';
const browser = await webkit.launch();
const checks = [];
const check = (ok, what) => checks.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
await ctx.addInitScript(`window.__walneroNet = 'mainnet';`);
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: path.join(SHOTS, `phrase-${n}.png`) });
const isVisible = (testid) => page.getByTestId(testid).isVisible().catch(() => false);
const readWords = (testid) => page.getByTestId(testid).evaluate((el) => [...el.children].map((c) => c.textContent.replace(/[0-9]/g, '').trim()).join(' '));
const waitSynced = async () => {
  for (let i = 0; i < 90; i++) {
    if ((await isVisible('sync-label')) && (await page.getByTestId('sync-label').innerText().catch(() => '')) === 'Up to date') return true;
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
const openSettings = async () => { await goHome(); await page.getByTestId('tab-settings').click(); await page.getByTestId('set-wallets').waitFor({ timeout: 30000 }); await page.waitForTimeout(400); };
const activeAddress = async () => {
  await openSettings();
  await page.getByTestId('set-wallets').click();
  await page.getByTestId('wallet-list').waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  const cur = await page.locator('.srow.cur [data-testid^="wallet-more-"]').first().getAttribute('data-testid');
  await page.getByTestId(cur).click();
  await page.getByTestId('wd-keys').click();
  await page.getByTestId('keys-password').fill(PASS);
  await page.getByTestId('keys-show').click();
  await page.getByTestId('keys-address').waitFor({ timeout: 60000 });
  return (await page.getByTestId('keys-address').innerText()).trim();
};
const revealWords = async () => {
  await openSettings();
  await page.getByTestId('set-security').click();
  await page.getByTestId('set-words').click();
  await page.getByTestId('words-password').fill(PASS);
  await page.getByTestId('show-words').click();
  await page.getByTestId('reveal-seed').waitFor({ timeout: 60000 });
};
const errorOf = async (testid) => { await page.getByTestId(testid).waitFor({ timeout: 60000 }).catch(() => {}); return (await page.getByTestId(testid).innerText().catch(() => '')).trim(); };

try {
  // 1. A brand-new wallet gets 12 words, and its address is the one Cake would open from them.
  await page.goto('http://localhost:4594/index.html');
  await page.getByTestId('create').click();
  await page.getByTestId('password').fill(PASS);
  await page.getByTestId('password2').fill(PASS);
  await page.getByTestId('password-go').click();
  await page.getByTestId('seed').waitFor({ timeout: 120000 });
  const phrase = await readWords('seed');
  check(phrase.split(' ').length === 12, `a new wallet shows 12 words (${phrase.split(' ').length})`);
  await shot('1-new-words');
  const expected = await cakeWallet(phrase);
  await page.getByTestId('seed-done').click();
  check(await waitSynced(), 'the new wallet reaches Up to date');
  check((await activeAddress()) === expected.address, 'its address is the one Cake Wallet makes from the same 12 words');

  // 2. Recovery words in Settings: the same 12, and the 25 Monero words on request.
  await revealWords();
  check((await readWords('reveal-seed')) === phrase, 'Settings shows the same 12 words');
  await shot('2-reveal-12');
  await page.getByTestId('toggle-monero-words').click();
  check((await readWords('reveal-monero')) === expected.seed, 'Show the 25 Monero words gives the matching Monero seed');
  await shot('3-reveal-25');

  // 3. A typo in 12 words is caught.
  await openSettings();
  await page.getByTestId('set-wallets').click();
  await page.getByTestId('wallet-add').click();
  await page.getByTestId('aw-restore').click();
  await page.getByTestId('aw-seed').fill(CAKE_PHRASE.replace('shiver', 'shovel'));
  await page.getByTestId('aw-go').click();
  const said = await errorOf('aw-error');
  check(/don't check out/i.test(said), `a mistyped phrase is refused ("${said}")`);

  // 4. Cake's own test phrase restores Cake's expected wallet.
  await page.getByTestId('aw-seed').fill(CAKE_PHRASE);
  await page.getByTestId('aw-height').fill(START);
  await page.getByTestId('aw-go').click();
  check(await waitSynced(), "Cake's test phrase restores and reaches Up to date");
  const cake = await cakeWallet(CAKE_PHRASE);
  check(cake.seed === CAKE_SEED, "the test's own Cake derivation matches Cake's published result");
  check((await activeAddress()) === cake.address, "the restored address is Cake's wallet for that phrase");
  await revealWords();
  await page.getByTestId('toggle-monero-words').click();
  check((await readWords('reveal-monero')) === CAKE_SEED, "its 25 Monero words are exactly the ones Cake's test expects");

  // 5. Those 25 words are the same wallet, so adding them is refused as a duplicate.
  await openSettings();
  await page.getByTestId('set-wallets').click();
  await page.getByTestId('wallet-add').click();
  await page.getByTestId('aw-restore').click();
  await page.getByTestId('aw-seed').fill(CAKE_SEED);
  await page.getByTestId('aw-go').click();
  const dup = await errorOf('aw-error');
  check(/already here/i.test(dup), `the 25-word form of the same wallet is recognised ("${dup}")`);
} catch (error) {
  console.log('FAILED:', error.message);
  await shot('failed').catch(() => {});
} finally {
  console.log(checks.join('\n'));
  await browser.close();
  server.close();
  process.exit(0);
}
