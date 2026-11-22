// The hard question from Stage 2.1: if our own scanner finds a payment, can wallet2 take it without a full scan?
// Same stagenet seed, two wallets. "Normal" scans block by block from before the payment. "Fast" starts AFTER the payment
// and is simply told the transaction hash via scanTxs. Their balances must match exactly, or the idea is dead.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../extension/package.json', import.meta.url));
const moneroTs = require('monero-ts');
const lib = moneroTs.default ?? moneroTs;

const NODE = 'http://node.monerodevs.org:38089';
const dir = new URL('../../extension/tests/', import.meta.url);
const wallet = JSON.parse(fs.readFileSync(new URL('stagenet-test-wallet.json', dir), 'utf8'));
const claim = JSON.parse(fs.readFileSync(new URL('faucet-claim.json', dir), 'utf8'));
const BEFORE_PAYMENT = 2243800;

const seconds = (from) => +((Date.now() - from) / 1000).toFixed(1);
const nodeInfo = async () => (await fetch(`${NODE}/get_info`)).json();
const txStatus = async (hash) => {
  const res = await fetch(`${NODE}/get_transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txs_hashes: [hash] }) });
  return (await res.json()).txs?.[0];
};
const open = (restoreHeight) => lib.createWalletFull({ networkType: lib.MoneroNetworkType.STAGENET, password: 'x', seed: wallet.seed, restoreHeight, server: { uri: NODE }, proxyToWorker: false });
const money = async (w) => ({ balance: String(await w.getBalance(0)), unlocked: String(await w.getUnlockedBalance(0)), height: await w.getHeight(), txs: (await w.getTxs()).map((t) => t.getHash()) });

for (let i = 0; i < 60; i++) {
  const tx = await txStatus(claim.txid);
  if (tx && !tx.in_pool) { console.log(`faucet tx is in block ${tx.block_height}`); break; }
  console.log('faucet tx still waiting for a block');
  await new Promise((r) => setTimeout(r, 20000));
}
const report = { txid: claim.txid };

let t = Date.now();
const fastTip = (await nodeInfo()).height;
const fast = await open(fastTip);
report.fastOpen = seconds(t);
t = Date.now();
await fast.scanTxs([claim.txid]);
report.scanTxsSeconds = seconds(t);
report.fastRightAfterScan = await money(fast);
console.log('right after scanTxs, before any sync:', JSON.stringify(report.fastRightAfterScan), `${report.scanTxsSeconds}s`);

t = Date.now();
await fast.sync();
report.fastSyncSeconds = seconds(t);
report.fastAfterSync = await money(fast);
console.log('fast after sync:', JSON.stringify(report.fastAfterSync), `${report.fastSyncSeconds}s`);

t = Date.now();
const normal = await open(BEFORE_PAYMENT);
await normal.sync();
report.normalSyncSeconds = seconds(t);
report.normal = await money(normal);
console.log('normal full scan:', JSON.stringify(report.normal), `${report.normalSyncSeconds}s`);

report.balancesMatch = report.fastAfterSync.balance === report.normal.balance;
report.sameTxs = JSON.stringify(report.fastAfterSync.txs) === JSON.stringify(report.normal.txs);
console.log('BALANCES MATCH:', report.balancesMatch, '| SAME TRANSACTIONS:', report.sameTxs);

// The real test of "sending works": ask the fast wallet to build a payment. Nothing is broadcast.
const second = JSON.parse(fs.readFileSync(new URL('stagenet-second-wallet.json', dir), 'utf8'));
for (let i = 0; i < 40; i++) {
  await fast.sync();
  if ((await fast.getUnlockedBalance(0)) > 0n) break;
  console.log(`waiting for coins to unlock, block ${await fast.getHeight()}`);
  await new Promise((r) => setTimeout(r, 60000));
}
try {
  const built = await fast.createTx({ accountIndex: 0, address: second.address, amount: 1000000000n, relay: false });
  report.fastCanBuildSend = true;
  report.fastSendFee = String(built.getFee());
  console.log('FAST WALLET BUILT A VALID PAYMENT, fee', report.fastSendFee);
} catch (error) {
  report.fastCanBuildSend = false;
  report.fastSendError = String(error.message ?? error);
  console.log('FAST WALLET COULD NOT BUILD A PAYMENT:', report.fastSendError);
}
fs.writeFileSync(new URL('scan-tx-result.json', import.meta.url), JSON.stringify(report, null, 2));
console.log('done');
process.exit(0);
