// The Node screen on the iPhone build, in WebKit at iPhone size, on a brand-new empty real-Monero wallet (nothing is sent):
// every node gets tested, picking one moves the wallet to it, Automatic goes back, adding a node that allows apps works,
// adding one that doesn't is refused with a reason, and removing it goes back to Automatic.
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
}).listen(4591);

const browser = await webkit.launch();
const checks = [];
const check = (ok, what) => checks.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
await ctx.addInitScript(`window.__walneroNet = 'mainnet';`);
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: path.join(SHOTS, `node-${n}.png`) });
const current = () => page.locator('.nrow.cur .nmain').getAttribute('data-testid');
const autoOn = async () => (await page.locator('[data-testid=node-auto] [role=switch]').getAttribute('aria-checked')) === 'true';
const settle = async () => { for (let i = 0; i < 30 && (await page.locator('.nstat .ms', { hasText: 'Testing' }).count()); i++) await page.waitForTimeout(500); };

try {
  await page.goto('http://localhost:4591/index.html');
  await page.getByTestId('create').click();
  await page.getByTestId('password').fill('node-test-pass-1');
  await page.getByTestId('password2').fill('node-test-pass-1');
  await page.getByTestId('password-go').click();
  await page.getByTestId('seed').waitFor({ timeout: 120000 });
  await page.getByTestId('seed-done').click();
  for (let i = 0; i < 150; i++) { if ((await page.getByTestId('sync-label').innerText().catch(() => '')) === 'Up to date') break; await page.waitForTimeout(2000); }

  await page.getByTestId('tab-settings').click();
  await page.getByTestId('set-network').click();
  await page.getByTestId('set-node').waitFor();
  await page.waitForTimeout(800);
  const row = (await page.getByTestId('set-node').innerText()).replace(/\s+/g, ' ');
  check(/Auto/.test(row), `Network shows the node row (${row})`);

  await page.getByTestId('set-node').click();
  await page.getByTestId('node-list').waitFor();
  await settle();
  const rows = await page.locator('.nrow').count();
  const answered = await page.locator('.sig').count();
  check(rows === 7 && answered >= 5, `all ${rows} iPhone nodes listed, ${answered} answered with a speed`);
  await page.waitForTimeout(400);
  await shot('list');

  // Pick Seth For Privacy: the wallet moves there and Automatic turns off.
  await page.getByTestId('node-node.sethforprivacy.com').click();
  for (let i = 0; i < 20 && (await current()) !== 'node-node.sethforprivacy.com'; i++) await page.waitForTimeout(500);
  check((await current()) === 'node-node.sethforprivacy.com', 'tapping Seth For Privacy moves the wallet to it');
  check(!(await autoOn()), 'Automatic turns off');
  await shot('picked');

  // Back to Automatic.
  await page.locator('[data-testid=node-auto] [role=switch]').click();
  for (let i = 0; i < 20 && !(await autoOn()); i++) await page.waitForTimeout(500);
  check(await autoOn(), `Automatic back on (${await current()})`);

  // Add a node that allows apps: it's tested, added, and used.
  await page.getByTestId('node-add').click();
  await page.getByTestId('an-label').fill('0xrpc');
  await page.getByTestId('an-address').fill('xmr.0xrpc.io');
  await page.waitForTimeout(300);
  await shot('add');
  await page.getByTestId('an-go').click();
  await page.getByTestId('node-list').waitFor({ timeout: 30000 });
  for (let i = 0; i < 20 && (await current()) !== 'node-xmr.0xrpc.io'; i++) await page.waitForTimeout(500);
  check((await current()) === 'node-xmr.0xrpc.io', 'adding xmr.0xrpc.io tests it and moves the wallet there');
  check((await page.getByTestId('node-xmr.0xrpc.io').innerText()).includes('0xrpc'), 'it shows under the name given');
  await settle();
  await shot('added');

  // A node that blocks apps is refused, with a reason.
  await page.getByTestId('node-add').click();
  await page.getByTestId('an-address').fill('monero.stackwallet.com');
  await page.getByTestId('an-port').fill('18081');
  await page.getByTestId('an-go').click();
  await page.getByTestId('an-error').waitFor({ timeout: 30000 });
  const err = await page.getByTestId('an-error').innerText();
  check(/Couldn't reach|didn't answer/.test(err), `a node that blocks apps is refused: "${err}"`);
  await shot('refused');

  // Remove the added node: back to Automatic.
  await page.getByTestId('back').click();
  await page.getByTestId('node-list').waitFor();
  await page.getByTestId('node-remove-xmr.0xrpc.io').click();
  for (let i = 0; i < 20 && (await page.getByTestId('node-xmr.0xrpc.io').count()); i++) await page.waitForTimeout(500);
  check(!(await page.getByTestId('node-xmr.0xrpc.io').count()), 'Remove takes it off the list');
  check(await autoOn(), 'and the wallet is back on Automatic');

  // The wallet still works after all the switching.
  await page.getByTestId('tab-home').click();
  for (let i = 0; i < 30; i++) { if ((await page.getByTestId('sync-label').innerText()) === 'Up to date') break; await page.waitForTimeout(1000); }
  check((await page.getByTestId('sync-label').innerText()) === 'Up to date', 'Home is still up to date after all the switching');
} catch (error) {
  console.log('FAILED:', error.message);
} finally {
  console.log(checks.join('\n'));
  await browser.close();
  server.close();
}
