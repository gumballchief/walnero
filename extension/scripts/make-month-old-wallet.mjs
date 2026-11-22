// Makes a truly month-old saved wallet on the test network: the real test wallet, stopped a month behind and saved exactly
// as it stood. Then it carries on with a normal block by block sync through the same month, for the time to beat and for the
// true balance the fast path has to match. Stagenet coins only.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('monero-ts').default ?? require('monero-ts');
const OUT = path.resolve(import.meta.dirname, '../../feed/data/synth');
const NODE = process.argv[2] ?? 'http://node.monerodevs.org:38089';
const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../tests/stagenet-test-wallet.json'), 'utf8'));
const seconds = (from) => +((Date.now() - from) / 1000).toFixed(1);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const tip = (await (await fetch(`${NODE}/get_info`)).json()).height - 1;
const restoreHeight = tip - 30 * 720;
const walletPassword = 'month-old-test';
log(`tip ${tip}, restoring from ${restoreHeight}`);
const wallet = await lib.createWalletFull({ networkType: lib.MoneroNetworkType.STAGENET, password: walletPassword, seed: fixture.seed, restoreHeight, server: { uri: NODE }, proxyToWorker: false });

let stoppedAt = 0;
const stopAt = restoreHeight + 200;
const listener = new (class extends lib.MoneroWalletListener {
  async onSyncProgress(height) {
    if (!stoppedAt && height >= stopAt) {
      stoppedAt = height;
      log(`reached ${height}, stopping here`);
      wallet.stopSyncing();
    }
  }
})();
await wallet.addListener(listener);
let t = Date.now();
await wallet.sync();
log(`first sync ended after ${seconds(t)} s at height ${await wallet.getHeight()}`);
if (!stoppedAt) throw new Error('never reached the stop height');

const height = await wallet.getHeight();
const [keys, cache] = await wallet.getData();
fs.writeFileSync(path.join(OUT, 'month-old-keys.bin'), keys);
fs.writeFileSync(path.join(OUT, 'month-old-cache.bin'), cache);
log(`saved at height ${height}: keys ${keys.length} bytes, cache ${(cache.length / 1048576).toFixed(1)} MB, balance then ${await wallet.getBalance(0)}`);
await wallet.removeListener(listener);

t = Date.now();
await wallet.sync();
const normalSeconds = seconds(t);
const after = await wallet.getHeight();
const balance = String(await wallet.getBalance(0));
const txs = (await wallet.getTxs()).map((x) => x.getHash()).sort();
log(`normal sync through the gap: ${normalSeconds} s for ${after - height} blocks, balance ${balance}, ${txs.length} transactions`);
fs.writeFileSync(path.join(OUT, 'month-old.json'), JSON.stringify({ seed: fixture.seed, walletPassword, restoreHeight, savedAt: height, normalSeconds, normalBlocks: after - height, truthHeight: after, balance, txs }, null, 1));
await wallet.close();
log('done');
process.exit(0);
