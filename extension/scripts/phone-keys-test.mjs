// Import from keys on the iPhone build, in WebKit at iPhone size, with brand-new empty real-Monero wallets (nothing is sent):
// the first wallet is restored from an address and view key (view-only: Send off, no recovery words, no spend key shown),
// then a second wallet is imported with its spend key too (a whole wallet: its words match the original), and wrong or
// repeated keys are refused.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { webkit } from '@playwright/test';

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
}).listen(4593);

// Two throwaway wallets made here, never funded.
const net = lib.MoneroNetworkType.MAINNET;
const make = async () => { const w = await lib.createWalletKeys({ networkType: net, language: 'English' }); return { address: await w.getPrimaryAddress(), view: await w.getPrivateViewKey(), spend: await w.getPrivateSpendKey(), seed: await w.getSeed() }; };
const A = await make();
const B = await make();
const NODES = ['https://xmr-node.cakewallet.com:18081', 'https://monero.definitelynotafed.com', 'https://xmr.support:18089', 'https://xmr-01.tari.com'];
const tip = await Promise.any(NODES.map(async (n) => (await (await fetch(`${n}/get_info`, { signal: AbortSignal.timeout(10000) })).json()).height));
const START = String(tip - 20);

const PASS = 'keys-pass-1';
const browser = await webkit.launch();
const checks = [];
const check = (ok, what) => checks.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
await ctx.addInitScript(`window.__walneroNet = 'mainnet';`);
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: path.join(SHOTS, `keys-${n}.png`) });
const isVisible = (testid) => page.getByTestId(testid).isVisible().catch(() => false);
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
const openWallets = async () => {
  await goHome();
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('set-wallets').waitFor({ timeout: 30000 });
  await page.getByTestId('set-wallets').click();
  await page.getByTestId('wallet-list').waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
};
const rowIds = () => page.locator('[data-testid^="wallet-row-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').slice('wallet-row-'.length)));
const sendDisabled = () => page.getByTestId('send').isDisabled().catch(() => null);
const errorOf = async (testid) => { await page.getByTestId(testid).waitFor({ timeout: 60000 }).catch(() => {}); return (await page.getByTestId(testid).innerText().catch(() => '')).trim(); };

try {
  // 1. First wallet from keys: address + view key only.
  await page.goto('http://localhost:4593/index.html');
  await page.getByTestId('restore').click();
  await page.getByTestId('restore-switch').click();
  await page.getByTestId('restore-address').fill(A.address);
  await page.getByTestId('restore-view').fill(A.view);
  await page.getByTestId('restore-password').fill(PASS);
  await page.getByTestId('restore-height').fill(START);
  await shot('1-restore-keys');
  await page.getByTestId('restore-go').click();
  check(await waitSynced(), 'view-only wallet from keys reaches Up to date');
  check(await isVisible('view-only'), 'Home shows View only');
  check((await sendDisabled()) === true, 'Send is off on a view-only wallet');
  await shot('2-home-view-only');

  // 2. Its keys page: the same view key, no spend key.
  await openWallets();
  const [first] = await rowIds();
  check(await isVisible(`wallet-vo-${first}`), 'the wallet list marks it View only');
  await shot('3-list');
  await page.getByTestId(`wallet-more-${first}`).click();
  check(await isVisible('wd-viewonly'), 'the wallet page explains view-only');
  await page.getByTestId('wd-keys').click();
  await page.getByTestId('keys-password').fill(PASS);
  await page.getByTestId('keys-show').click();
  await page.getByTestId('keys-address').waitFor({ timeout: 60000 });
  check((await page.getByTestId('keys-address').innerText()).trim() === A.address, 'keys page shows the imported address');
  await page.getByTestId('keys-reveal-view').click();
  check((await page.getByTestId('keys-view').innerText()).trim() === A.view, 'keys page shows the imported view key');
  check(await isVisible('keys-spend-none'), 'keys page says the spend key is not on this device');
  await shot('4-keys-view-only');

  // 3. Recovery words: refused with a reason.
  await goHome();
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('set-security').click().catch(() => {});
  await page.getByTestId('set-words').click().catch(() => {});
  if (await page.getByTestId('words-password').isVisible().catch(() => false)) {
    await page.getByTestId('words-password').fill(PASS);
    await page.getByTestId('show-words').click();
    const said = await errorOf('words-error');
    check(/view-only/i.test(said), `recovery words refused for view-only ("${said}")`);
  } else {
    check(false, 'could not reach the recovery words page');
  }

  // 4. A wrong view key, then the same view-only wallet again: both refused.
  await openWallets();
  await page.getByTestId('wallet-add').click();
  await page.getByTestId('aw-keys').click();
  await page.getByTestId('ik-address').fill(B.address);
  await page.getByTestId('ik-view').fill(A.view);
  await page.getByTestId('ik-go').click();
  let said = await errorOf('ik-error');
  check(/doesn't belong/i.test(said), `a view key from another wallet is refused ("${said}")`);
  await page.getByTestId('ik-address').fill(A.address);
  await page.getByTestId('ik-view').fill(A.view);
  await page.getByTestId('ik-go').click();
  said = await errorOf('ik-error');
  check(/already here/i.test(said), `importing the same wallet twice is refused ("${said}")`);

  // 5. A second wallet with all three keys: a whole wallet, Send can come on, and its spend key is the original.
  await page.getByTestId('ik-address').fill(B.address);
  await page.getByTestId('ik-view').fill(B.view);
  await page.getByTestId('ik-spend').fill(B.spend);
  await page.getByTestId('ik-height').fill(START);
  await shot('5-import-full');
  await page.getByTestId('ik-go').click();
  check(await waitSynced(), 'wallet imported with its spend key reaches Up to date');
  check(!(await isVisible('view-only')), 'it is not marked View only');
  check((await sendDisabled()) === false, 'Send is on for it');
  await shot('6-home-full');
  await goHome();
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('set-security').click().catch(() => {});
  await page.getByTestId('set-words').click().catch(() => {});
  await page.getByTestId('words-password').fill(PASS);
  await page.getByTestId('show-words').click();
  await page.getByTestId('reveal-seed').waitFor({ timeout: 60000 });
  const words = await page.getByTestId('reveal-seed').evaluate((el) => [...el.children].map((c) => c.textContent.replace(/[0-9]/g, '').trim()).join(' '));
  check(words === B.seed, 'its recovery words are the original 25 words');
} catch (error) {
  console.log('FAILED:', error.message);
  await shot('failed').catch(() => {});
} finally {
  console.log(checks.join('\n'));
  await browser.close();
  server.close();
  process.exit(0);
}
