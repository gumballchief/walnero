// Stage 1.2 and 1.3: create, lock, unlock, restore, nothing readable on disk, and a real synced block height.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, SHOTS } from './harness';

const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'stagenet-test-wallet.json'), 'utf8'));
const NODE = 'http://node2.monerodevs.org:38089';
const PASSWORD = 'test-network-password';
const shot = (page: any, name: string) => { fs.mkdirSync(SHOTS, { recursive: true }); return page.screenshot({ path: path.join(SHOTS, name) }); };

// Everything saved on disk, decoded as text so a plain seed word would show up in it.
const diskDump = (page: any) => page.evaluate(async () => {
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open('walnero'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const store = db.transaction('kv').objectStore('kv');
  const keys: string[] = await new Promise((res) => { const r = store.getAllKeys(); r.onsuccess = () => res(r.result as string[]); });
  const values: any[] = await new Promise((res) => { const r = store.getAll(); r.onsuccess = () => res(r.result); });
  const text = (v: any): string => {
    if (v instanceof Uint8Array) return new TextDecoder('latin1').decode(v);
    if (v && typeof v === 'object') return Object.values(v).map(text).join(' ');
    return String(v);
  };
  return { keys, text: values.map(text).join(' ') + JSON.stringify({ ...localStorage }) };
});

test('create, lock, unlock', async ({ popup }) => {
  await popup.getByTestId('create').click();
  await popup.getByTestId('password').fill(PASSWORD);
  await popup.getByTestId('password2').fill(PASSWORD);
  await shot(popup, '1.2-password.png');
  await popup.getByTestId('password-go').click();

  const seedBox = popup.getByTestId('seed');
  await expect(seedBox).toBeVisible({ timeout: 90_000 });
  await popup.waitForTimeout(800);
  await shot(popup, '1.2-seed.png');
  const words = (await seedBox.locator('div').allInnerTexts()).map((t) => t.replace(/^\d+\s*/, '').trim());
  expect(words).toHaveLength(25);

  await popup.getByTestId('seed-done').click();
  await expect(popup.getByTestId('balance')).toBeVisible({ timeout: 30_000 });

  const dump = await diskDump(popup);
  console.log('stored keys:', dump.keys.join(', '));
  const found = words.filter((w) => w.length > 4 && dump.text.includes(w));
  console.log('seed words readable on disk:', found.length, 'of 25');
  expect(dump.text).not.toContain(words.join(' '));
  expect(found).toHaveLength(0);
  expect(dump.text).not.toContain(PASSWORD);

  await popup.getByTestId('tab-settings').click();
  await popup.getByTestId('lock').click();
  await expect(popup.getByTestId('unlock-password')).toBeVisible({ timeout: 30_000 });
  await popup.getByTestId('unlock-password').fill('wrong-password');
  await popup.getByTestId('unlock-go').click();
  await expect(popup.getByTestId('unlock-error')).toHaveText('Wrong password', { timeout: 30_000 });
  await shot(popup, '1.2-locked.png');
  await popup.getByTestId('unlock-password').fill(PASSWORD);
  await popup.getByTestId('unlock-go').click();
  await expect(popup.getByTestId('balance')).toBeVisible({ timeout: 90_000 });
});

test('restore gives the same wallet, and syncs to the real block height', async ({ popup }) => {
  await popup.getByTestId('restore').click();
  await popup.getByTestId('restore-seed').fill('not a real seed');
  await popup.getByTestId('restore-password').fill(PASSWORD);
  await popup.getByTestId('restore-go').click();
  await expect(popup.getByTestId('restore-error')).toContainText('25 words');

  const info = await (await fetch(`${NODE}/get_info`)).json();
  await popup.getByTestId('restore-seed').fill(fixture.seed);
  await popup.getByTestId('restore-height').fill(String(info.height - 30));
  await popup.getByTestId('restore-go').click();
  await expect(popup.getByTestId('balance')).toBeVisible({ timeout: 90_000 });

  // The screen answers straight away while the slow first catch-up runs behind it.
  const started = Date.now();
  await expect(popup.getByTestId('sync-label')).toHaveText(/Checking|Setting up/, { timeout: 20_000 });
  await popup.waitForTimeout(20_000);
  await shot(popup, '1.3-home-catching-up.png');
  const midway = await popup.getByTestId('sync-label').innerText();
  console.log(`20 s in, the screen is alive and says: ${midway}`);
  // Honest about the one slow case, and it mustn't let someone start a payment that would hang.
  if (midway === 'Setting up') await expect(popup.getByTestId('send')).toBeDisabled();
  await popup.getByTestId('tab-activity').click();
  await expect(popup.getByTestId('activity')).toBeVisible();
  await popup.getByTestId('tab-home').click();
  await expect(popup.getByTestId('sync-label')).toHaveText('Up to date', { timeout: 300_000 });
  await expect(popup.getByTestId('send')).toBeEnabled();
  console.log(`first catch-up finished ${Math.round((Date.now() - started) / 1000)} s after the screen appeared`);

  // Only now, because the engine answers nothing else during a sync.
  const { address } = await popup.evaluate(() => (window as any).walnero.call('primaryAddress'));
  expect(address).toBe(fixture.address);
  // Up to date has to mean the real tip, not just a label, so check against the server after a moment to settle.
  await popup.waitForTimeout(3000);
  await popup.getByTestId('tab-settings').click();
  const label = await popup.getByTestId('height').innerText();
  const shown = Number(label.match(/^([\d,]+) of/)![1].replace(/,/g, ''));
  const now = (await (await fetch(`${NODE}/get_info`)).json()).height;
  console.log(`popup says block ${shown}, the server says ${now}`);
  expect(Math.abs(shown - now)).toBeLessThanOrEqual(3);
  await popup.waitForTimeout(600);
  await shot(popup, '1.3-home-synced.png');
  await popup.getByTestId('tab-activity').click();
  await popup.waitForTimeout(500);
  await shot(popup, '1.3-activity.png');
});
