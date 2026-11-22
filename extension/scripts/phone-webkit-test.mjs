// Runs the iPhone build (.output/phone-web) in WebKit, Safari's engine, at an iPhone's screen size. Makes brand new, empty
// wallets (nothing is ever sent) and clicks through everything on screen: Home, tap-to-hide, every Settings page, change
// password, recovery words, then the test network. Screens go to test-shots/phone-*.png.
// Off the phone there's no native side, so storage falls back to IndexedDB and the network is set the way the app sets it.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { webkit } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '../.output/phone-web');
const SHOTS = path.resolve(import.meta.dirname, '../test-shots');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(4590);

const browser = await webkit.launch();
const problems = [];
const checks = [];
const check = (ok, what) => { checks.push(`${ok ? 'PASS' : 'FAIL'} ${what}`); };
const started = Date.now();
const at = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;

async function phone(net) {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
  await context.addInitScript(`window.__walneroNet = '${net}';`);
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`${net} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Could not (connect|resolve)|access control|Failed to load resource/.test(m.text())) problems.push(`${net} console: ${m.text()}`); });
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `phone-${name}.png`) });
  const make = async (password) => {
    await page.goto('http://localhost:4590/index.html');
    await page.getByTestId('create').click();
    await page.getByTestId('password').fill(password);
    await page.getByTestId('password2').fill(password);
    await page.getByTestId('password-go').click();
    await page.getByTestId('seed').waitFor({ timeout: 120000 });
    await page.getByTestId('seed-done').click();
    await page.getByTestId('balance').waitFor({ timeout: 30000 });
  };
  return { context, page, shot, make };
}

try {
  // --- Real Monero -------------------------------------------------------------------------------------------------------
  const { context, page, shot, make } = await phone('mainnet');
  await make('first-password-1');
  console.log(`${at()} real wallet made`);
  for (let i = 0; i < 150; i++) { if ((await page.getByTestId('sync-label').innerText()) === 'Up to date') break; await page.waitForTimeout(2000); }
  console.log(`${at()} ${await page.getByTestId('sync-label').innerText()}`);
  await page.waitForTimeout(800);
  await shot('home');

  await page.getByTestId('balance').click();
  await page.waitForTimeout(400);
  const hidden = await page.getByTestId('balance').innerText();
  check(hidden.includes('*****') && !/\d/.test(hidden), `tap hides the balance (shows "${hidden.replace(/\s+/g, ' ')}")`);
  check((await page.getByTestId('token-xmr').innerText()).includes('*****'), 'the Monero row hides too');
  await shot('home-hidden');
  await page.getByTestId('balance').click();
  await page.waitForTimeout(400);
  check(/\d/.test(await page.getByTestId('balance').innerText()), 'tap again shows it');

  // The Monero screen: price, the day's change, a chart that answers a finger, every range, Info, then back.
  await page.getByTestId('token-price-line').waitFor({ timeout: 20000 }).catch(() => {});
  check(/\$\d/.test(await page.getByTestId('token-value').innerText()), `Home shows a dollar value (${await page.getByTestId('token-value').innerText()})`);
  await shot('home-prices');
  await page.getByTestId('token-xmr').click();
  await page.getByTestId('token-chart').waitFor({ timeout: 20000 });
  await page.mouse.move(2, 2); // the tap landed where the chart now is; take the pointer off it
  await page.waitForTimeout(1500);
  check(/Past day/.test(await page.getByTestId('token-change').innerText()), 'with nothing touched, the header shows the past day');
  for (let i = 0; i < 20 && (await page.locator('[data-testid=token-info] .skel').count()); i++) await page.waitForTimeout(1000);
  check(!(await page.locator('[data-testid=token-info] .skel').count()), `Info settles (${(await page.getByTestId('token-info').innerText()).replace(/\s+/g, ' ')})`);
  const price = await page.getByTestId('token-price').innerText();
  check(/^\$\d/.test(price), `the Monero screen shows the price (${price})`);
  check(/[+-]\$[\d.,]+/.test(await page.getByTestId('token-change').innerText()), `and the change (${(await page.getByTestId('token-change').innerText()).replace(/\s+/g, ' ')})`);
  check((await page.locator('[data-testid=token-chart] canvas').count()) > 0, 'the chart draws');
  check(/\$[\d.]+[BMK]/.test(await page.getByTestId('token-info').innerText()), 'Info has the market cap');
  await shot('token');
  const box = await page.getByTestId('token-chart').boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.55);
  await page.waitForTimeout(400);
  const moment = (await page.getByTestId('token-change').innerText()).replace(/\s+/g, ' ');
  check(/[A-Z][a-z]{2} \d/.test(moment) && (await page.getByTestId('token-price').innerText()) !== price, `touching the chart shows that moment's price (${moment})`);
  await shot('token-touch');
  await page.mouse.move(box.x + box.width / 2, box.y - 80);
  for (const r of ['1W', '1M', 'YTD', 'ALL']) {
    await page.getByTestId(`range-${r}`).click();
    for (let i = 0; i < 20 && (await page.locator('.tk-chart-wrap.loading').count()); i++) await page.waitForTimeout(500);
    check(!(await page.locator('.tk-chart-wrap.loading').count()) && !(await page.getByTestId('chart-failed').count()), `${r} chart loads`);
  }
  await page.waitForTimeout(600);
  await shot('token-all');
  await page.locator('.scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(500);
  await shot('token-bottom');
  await page.getByTestId('back').click();

  // The three lines next to Tokens: turning prices off takes the dollars away, and back on.
  await page.getByTestId('manage-tokens').click();
  await page.getByTestId('manage-prices').waitFor();
  await page.waitForTimeout(500);
  await shot('manage');
  await page.locator('[data-testid=manage-prices] [role=switch]').click();
  await page.getByTestId('back').click();
  check((await page.getByTestId('token-value').innerText()) === 'XMR', 'prices off: no dollar value on Home');
  await page.getByTestId('manage-tokens').click();
  await page.locator('[data-testid=manage-prices] [role=switch]').click();
  await page.getByTestId('back').click();
  console.log(`${at()} Monero screen checks done`);

  await page.getByTestId('tab-settings').click();
  await page.getByTestId('set-security').waitFor();
  await page.waitForTimeout(1500);
  check((await page.getByTestId('copy-main').innerText()).includes('…'), 'Settings shows the wallet address');
  await shot('settings');
  for (const [id, name] of [['set-security', 'security'], ['set-network', 'network'], ['set-developer', 'developer'], ['set-help', 'help']]) {
    await page.getByTestId(id).click();
    await page.getByTestId('back').waitFor();
    await page.waitForTimeout(500);
    await shot(`settings-${name}`);
    if (name === 'network') check(/\d/.test(await page.getByTestId('height').innerText()), 'Network shows the block height');
    if (name === 'developer') check(/up to date \d/.test(await page.getByTestId('open-speed').innerText()), `Open speed: ${await page.getByTestId('open-speed').innerText()}`);
    await page.getByTestId('back').click();
    await page.getByTestId('set-security').waitFor();
  }

  // Auto-lock choice, then the recovery words behind the password.
  await page.getByTestId('set-security').click();
  await page.getByTestId('lock-5').click();
  await page.waitForTimeout(300);
  check((await page.getByTestId('lock-5').getAttribute('class')).includes('on'), 'auto-lock picks 5 minutes');
  await page.getByTestId('set-words').click();
  await page.getByTestId('words-password').fill('wrong-password');
  await page.getByTestId('show-words').click();
  await page.getByTestId('words-error').waitFor({ timeout: 30000 });
  check((await page.getByTestId('words-error').innerText()).includes('Wrong password'), 'words refuse a wrong password');
  await page.getByTestId('words-password').fill('first-password-1');
  await page.getByTestId('show-words').click();
  await page.getByTestId('reveal-seed').waitFor({ timeout: 30000 });
  check((await page.getByTestId('reveal-seed').locator('div').count()) === 25, 'words show all 25 with the right password');
  await shot('settings-words');
  await page.getByTestId('hide-words').click();

  // Change the password, lock, and prove the new one opens it and the old one doesn't.
  await page.getByTestId('set-password').click();
  await page.getByTestId('pw-current').fill('first-password-1');
  await page.getByTestId('pw-new').fill('second-password-2');
  await page.getByTestId('pw-again').fill('second-password-2');
  await page.getByTestId('pw-go').click();
  await page.getByTestId('pw-done').waitFor({ timeout: 60000 });
  check(true, 'password changed');
  await shot('settings-password');
  await page.getByTestId('back').click();
  await page.getByTestId('back').click();
  await page.getByTestId('lock').click();
  await page.getByTestId('unlock-password').waitFor({ timeout: 20000 });
  await page.getByTestId('unlock-password').fill('first-password-1');
  await page.getByTestId('unlock-go').click();
  await page.getByTestId('unlock-error').waitFor({ timeout: 30000 });
  check((await page.getByTestId('unlock-error').innerText()).includes('Wrong password'), 'the old password no longer opens it');
  await page.getByTestId('unlock-password').fill('second-password-2');
  await page.getByTestId('unlock-go').click();
  await page.getByTestId('balance').waitFor({ timeout: 30000 });
  for (let i = 0; i < 90; i++) { if ((await page.getByTestId('sync-label').innerText()) === 'Up to date') break; await page.waitForTimeout(2000); }
  check((await page.getByTestId('sync-label').innerText()) === 'Up to date', 'the new password opens it and the wallet loads');
  console.log(`${at()} real-wallet checks done`);
  await context.close();

  // --- Test network ------------------------------------------------------------------------------------------------------
  const test = await phone('stagenet');
  await test.make('test-password-1');
  check(await test.page.getByTestId('test-banner').isVisible(), 'the test-network banner shows');
  check(await test.page.getByTestId('faucet').isVisible(), 'the faucet button shows on Home');
  await test.page.waitForTimeout(1200);
  await test.shot('test-home');
  await test.page.getByTestId('tab-settings').click();
  await test.page.getByTestId('set-developer').click();
  await test.page.waitForTimeout(600);
  await test.shot('test-developer');
  console.log(`${at()} test-network checks done`);
  await test.context.close();

  // --- A test-network wallet with real (value-less) history: Activity, a transaction's own screen, its explorer link --------
  const funded = await phone('stagenet');
  const w = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../tests/stagenet-test-wallet.json'), 'utf8'));
  await funded.page.goto('http://localhost:4590/index.html');
  await funded.page.getByTestId('restore').click();
  await funded.page.getByTestId('restore-seed').fill(w.seed);
  await funded.page.getByTestId('restore-password').fill('test-network-password');
  await funded.page.getByTestId('restore-height').fill('2243828');
  await funded.page.getByTestId('restore-go').click();
  await funded.page.getByTestId('balance').waitFor({ timeout: 120000 });
  for (let i = 0; i < 150; i++) { if ((await funded.page.getByTestId('sync-label').innerText()) === 'Up to date') break; await funded.page.waitForTimeout(2000); }
  console.log(`${at()} funded test wallet: ${await funded.page.getByTestId('sync-label').innerText()}, ${(await funded.page.getByTestId('balance').innerText()).replace(/\s+/g, '')}`);
  await funded.page.getByTestId('tab-activity').click();
  await funded.page.getByTestId('tx-row-0').waitFor({ timeout: 60000 });
  await funded.page.waitForTimeout(900);
  await funded.shot('test-activity');
  await funded.page.getByTestId('tx-row-0').click();
  await funded.page.getByTestId('tx-facts').waitFor();
  await funded.page.waitForTimeout(700);
  const href = await funded.page.getByTestId('tx-explorer').getAttribute('href');
  check(/^https:\/\/stagenet\.xmrchain\.net\/tx\/[0-9a-f]{64}$/.test(href ?? ''), `the explorer link points at this transaction (${href})`);
  const facts = (await funded.page.getByTestId('tx-facts').innerText()).replace(/\s+/g, ' ');
  check(/Date .*Status .*From .*To .*Block [\d,]+ .*Transaction ID/.test(facts), `the transaction screen lists its facts (${facts})`);
  await funded.shot('test-tx');
  await funded.page.getByTestId('back').click();
  // A sent one too, if the history has one: it shows the network fee.
  const rows = await funded.page.locator('[data-testid^=tx-row-]').all();
  for (const row of rows) {
    if (!(await row.innerText()).includes('Sent')) continue;
    await row.click();
    await funded.page.getByTestId('tx-facts').waitFor();
    await funded.page.waitForTimeout(700);
    const sentFacts = (await funded.page.getByTestId('tx-facts').innerText()).replace(/\s+/g, ' ');
    check(/Network fee [\d.]+ XMR/.test(sentFacts), `a sent payment shows its fee (${sentFacts})`);
    await funded.shot('test-tx-sent');
    await funded.page.getByTestId('back').click();
    break;
  }
  await funded.page.getByTestId('tab-home').click();
  await funded.page.getByTestId('token-xmr').click();
  await funded.page.getByTestId('token-activity').waitFor();
  check((await funded.page.locator('[data-testid=token-activity] [data-testid^=tx-row-]').count()) > 0, 'the Monero screen lists recent transactions');
  await funded.page.locator('.scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await funded.page.waitForTimeout(600);
  await funded.shot('test-token-bottom');
  console.log(`${at()} transaction checks done`);
  await funded.context.close();
} catch (error) {
  console.log('FAILED:', error.message);
} finally {
  console.log(checks.join('\n'));
  console.log(problems.length ? `problems:\n${problems.join('\n')}` : 'no page errors');
  await browser.close();
  server.close();
}
