// Stage 1.1: Monero's real wallet code runs inside the extension, and gives the same address as plain Node for the same seed.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './harness';

const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'stagenet-test-wallet.json'), 'utf8'));

test('wallet engine runs in the extension', async ({ popup }) => {
  const started = Date.now();
  const { address } = await popup.evaluate((seed) => (window as any).walnero.call('addressFromSeed', { seed }), fixture.seed);
  console.log(`extension address ${address}\nnode address      ${fixture.address}\ntook ${Date.now() - started} ms`);
  expect(address).toBe(fixture.address);
});
