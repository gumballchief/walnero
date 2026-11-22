// Stage 2.1 baseline on real Monero mainnet. Uses a throwaway empty wallet to read public blocks: no funds, nothing sent.
// Answers: how long does a normal wallet take after one day offline, and how long does skipping those blocks take?
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../extension/package.json', import.meta.url));
const moneroTs = require('monero-ts');
const lib = moneroTs.default ?? moneroTs;

const NODE = process.argv[2] ?? 'http://node.monerodevs.org:18089';
const DAY = 720;
const seconds = (from) => +((Date.now() - from) / 1000).toFixed(1);
const report = { node: NODE, measuredAt: new Date().toISOString() };

const info = await (await fetch(`${NODE}/get_info`)).json();
const tip = info.height;
const offlineFrom = tip - DAY;
report.tip = tip;

const keys = await lib.createWalletKeys({ networkType: lib.MoneroNetworkType.MAINNET, language: 'English', proxyToWorker: false });
const seed = await keys.getSeed();
await keys.close();
const config = { networkType: lib.MoneroNetworkType.MAINNET, password: 'x', server: { uri: NODE }, proxyToWorker: false };

// Step 1: what a brand-new wallet pays, walking the block list up to its start height. Stop right after it, which
// leaves a wallet exactly as it would be if its owner closed it a day ago.
let t = Date.now();
const first = await lib.createWalletFull({ ...config, seed, restoreHeight: offlineFrom });
report.createSeconds = seconds(t);
t = Date.now();
let walkDone = 0;
let walkStart = 0;
await first.addListener(new (class extends lib.MoneroWalletListener {
  async onSyncProgress(height, start, end, percent) {
    if (!walkStart) { walkStart = start; console.log(`first progress: height ${height}, start ${start}, end ${end}`); }
    if (!walkDone && height >= offlineFrom) { walkDone = seconds(t); console.log(`block list walked in ${walkDone}s, stopping`); first.stopSyncing().catch(() => {}); }
  }
})());
await first.sync().catch((e) => console.log('sync stopped:', String(e.message ?? e).slice(0, 100)));
report.firstOpenWalkSeconds = walkDone || seconds(t);
report.firstOpenWalkedFrom = walkStart;
report.stoppedAtHeight = await first.getHeight();
const [keysData, cacheData] = await first.getData();
report.cacheMB = +(cacheData.length / 1048576).toFixed(1);
report.keysKB = +(keysData.length / 1024).toFixed(1);
await first.close();
console.log(`saved state at height ${report.stoppedAtHeight}, cache ${report.cacheMB} MB`);

const reopen = async () => {
  const started = Date.now();
  const wallet = await lib.openWalletFull({ ...config, keysData, cacheData });
  return { wallet, seconds: seconds(started) };
};

// Step 2: the normal way. Open the saved wallet and download and scan every block since.
const normal = await reopen();
report.reopenSeconds = normal.seconds;
t = Date.now();
const normalResult = await normal.wallet.sync();
report.normalCatchUpSeconds = seconds(t);
report.normalBlocksFetched = normalResult.getNumBlocksFetched();
report.normalHeight = await normal.wallet.getHeight();
report.normalBalance = String(await normal.wallet.getBalance(0));
await normal.wallet.close();
console.log(`normal catch-up: ${report.normalCatchUpSeconds}s for ${report.normalBlocksFetched} blocks`);

// Step 3: the skip. The feed says nothing here is ours, so jump to the top: only block hashes are fetched.
const skip = await reopen();
t = Date.now();
await skip.wallet.setRestoreHeight((await (await fetch(`${NODE}/get_info`)).json()).height - 1);
const skipResult = await skip.wallet.sync();
report.skipCatchUpSeconds = seconds(t);
report.skipBlocksFetched = skipResult.getNumBlocksFetched();
report.skipHeight = await skip.wallet.getHeight();
report.skipBalance = String(await skip.wallet.getBalance(0));
await skip.wallet.close();
console.log(`skip catch-up: ${report.skipCatchUpSeconds}s, ${report.skipBlocksFetched} blocks scanned, height ${report.skipHeight}`);

fs.writeFileSync(new URL('mainnet-gap-result.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
process.exit(0);
