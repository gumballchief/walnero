// Monero fee levels on the iPhone build, in WebKit at iPhone size, on the test network (stagenet coins have no value).
// The project's stagenet test wallet is restored, a payment to its second wallet is reviewed (built, never sent), and each
// fee level (Auto, Medium, Fast) is picked in turn: the fee must go up each time, and the payment stays unsent.
// Run with: node scripts/phone-fee-test.mjs [buildDir]   (default .output/phone-web)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { webkit } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..', process.argv[2] ?? '.output/phone-web');
const SHOTS = path.resolve(import.meta.dirname, '../test-shots');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', TYPES[path.extname(f)] ?? 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
}).listen(4596);

const wallet = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../tests/stagenet-test-wallet.json'), 'utf8'));
const second = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../tests/stagenet-second-wallet.json'), 'utf8'));
const BEFORE_FAUCET = '2243700';

const browser = await webkit.launch();
const checks = [];
const check = (ok, what) => checks.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
await ctx.addInitScript(`window.__walneroNet = 'stagenet';`);
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: path.join(SHOTS, `fee-${n}.png`) });
const isVisible = (testid) => page.getByTestId(testid).isVisible().catch(() => false);
const waitSynced = async (tries = 150) => {
  for (let i = 0; i < tries; i++) {
    if ((await isVisible('sync-label')) && (await page.getByTestId('sync-label').innerText().catch(() => '')) === 'Up to date') return true;
    await page.waitForTimeout(2000);
  }
  return false;
};
const feeNow = async () => {
  for (let i = 0; i < 60; i++) {
    const text = (await page.getByTestId('fee').innerText().catch(() => '')).trim();
    if (/XMR$/.test(text)) return Number(text.replace(/[^0-9.]/g, ''));
    await page.waitForTimeout(1000);
  }
  return NaN;
};
const pick = async (level, before) => {
  await page.getByTestId(`speed-${level}`).click();
  for (let i = 0; i < 90; i++) {
    const text = (await page.getByTestId('fee').innerText().catch(() => '')).trim();
    if (/XMR$/.test(text) && Number(text.replace(/[^0-9.]/g, '')) !== before) break;
    await page.waitForTimeout(1000);
  }
  return feeNow();
};

try {
  await page.goto('http://localhost:4596/index.html');
  await page.getByTestId('restore').click();
  await page.getByTestId('restore-seed').fill(wallet.seed);
  await page.getByTestId('restore-password').fill('fee-test-password');
  await page.getByTestId('restore-height').fill(BEFORE_FAUCET);
  await page.getByTestId('restore-go').click();
  check(await waitSynced(), 'stagenet test wallet reaches Up to date');
  const balance = (await page.getByTestId('balance').innerText().catch(() => '')).replace(/[^0-9.]/g, '');
  console.log(`balance ${balance}`);
  if (!(Number(balance) > 0.002)) throw new Error(`the test wallet has no coins to build a payment from (${balance})`);

  await page.getByTestId('send').click();
  await page.getByTestId('send-amount').fill('0.001');
  await page.getByTestId('amount-next').click();
  await page.getByTestId('send-address').fill(second.address);
  await page.getByTestId('review-go').click();
  await page.getByTestId('review').waitFor({ timeout: 120000 });
  check(await isVisible('xmr-speeds'), 'the review shows the fee levels');
  check((await page.getByTestId('speed-auto').getAttribute('aria-pressed')) === 'true', 'Auto is picked by default');
  const auto = await feeNow();
  await shot('1-auto');
  const medium = await pick('medium', auto);
  await shot('2-medium');
  const fast = await pick('fast', medium);
  await shot('3-fast');
  console.log(`fees: auto ${auto}, medium ${medium}, fast ${fast} (x${(medium / auto).toFixed(2)}, x${(fast / auto).toFixed(2)})`);
  check(auto > 0 && medium > auto && fast > medium, `each level costs more: ${auto} < ${medium} < ${fast} XMR`);
  check((await page.getByTestId('speed-fast').getAttribute('aria-pressed')) === 'true', 'Fast shows as picked');
  const back = await pick('auto', fast);
  check(back === auto, `back to Auto gives the first fee again (${back})`);
  check(await isVisible('slide'), 'the payment is ready to slide, and was never sent');
} catch (error) {
  console.log('FAILED:', error.message);
  await shot('failed').catch(() => {});
} finally {
  console.log(checks.join('\n'));
  await browser.close();
  server.close();
  process.exit(0);
}
