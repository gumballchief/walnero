// Second hard check on the fast path. The test wallet has now received coins AND spent some, so a wrong result here would
// mean a wallet showing money it already spent. Fast wallet: told only the hashes, as whole blocks' worth of transactions
// so a server can't tell which one is ours. Normal wallet: scans block by block. They must match to the last unit.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../extension/package.json', import.meta.url));
const moneroTs = require('monero-ts');
const lib = moneroTs.default ?? moneroTs;

const NODE = 'http://node.monerodevs.org:38089';
const dir = new URL('../../extension/tests/', import.meta.url);
const wallet = JSON.parse(fs.readFileSync(new URL('stagenet-test-wallet.json', dir), 'utf8'));
const second = JSON.parse(fs.readFileSync(new URL('stagenet-second-wallet.json', dir), 'utf8'));
const RECEIVED_IN = 2243824;
const SPENT_IN = 2243835;
const RECEIVE = 'f3a8755cfc71c1091e0101972b1fa374b7719aba29317f031db2b76247d26d9c';
const SPEND = '845d79bc9c156667b9729939c1fc41925c500aa6219ae0f684222b04d8cc6745';

const rpc = async (method, params) => (await (await fetch(`${NODE}/json_rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }) })).json()).result;
const seconds = (from) => +((Date.now() - from) / 1000).toFixed(1);
const open = (restoreHeight) => lib.createWalletFull({ networkType: lib.MoneroNetworkType.STAGENET, password: 'x', seed: wallet.seed, restoreHeight, server: { uri: NODE }, proxyToWorker: false });
const state = async (w) => ({ balance: String(await w.getBalance(0)), unlocked: String(await w.getUnlockedBalance(0)), txs: (await w.getTxs()).map((t) => t.getHash()).sort() });

const blockTxs = async (height) => (await rpc('get_block', { height })).tx_hashes ?? [];
const receiveBlock = await blockTxs(RECEIVED_IN);
const spendBlock = await blockTxs(SPENT_IN);
console.log(`block ${RECEIVED_IN} has ${receiveBlock.length} txs, block ${SPENT_IN} has ${spendBlock.length} txs`);
const report = {};

let t = Date.now();
const tip = (await (await fetch(`${NODE}/get_info`)).json()).height;
const fast = await open(tip);
await fast.scanTxs([...new Set([...receiveBlock, ...spendBlock, RECEIVE, SPEND])]);
report.fastScanSeconds = seconds(t);
report.fastBeforeSync = await state(fast);
console.log('fast, told whole blocks of hashes:', JSON.stringify(report.fastBeforeSync), `${report.fastScanSeconds}s`);
t = Date.now();
await fast.sync();
report.fastSyncSeconds = seconds(t);
report.fast = await state(fast);
console.log('fast after sync:', JSON.stringify(report.fast), `${report.fastSyncSeconds}s`);

t = Date.now();
const normal = await open(RECEIVED_IN - 20);
await normal.sync();
report.normalSeconds = seconds(t);
report.normal = await state(normal);
console.log('normal:', JSON.stringify(report.normal), `${report.normalSeconds}s`);

report.balanceMatches = report.fast.balance === report.normal.balance;
report.txsMatch = JSON.stringify(report.fast.txs) === JSON.stringify(report.normal.txs);
report.neverShowsSpentMoney = BigInt(report.fast.balance) < 10000000000n;
console.log(`BALANCE MATCHES: ${report.balanceMatches} | SAME TXS: ${report.txsMatch} | SPENT COINS GONE: ${report.neverShowsSpentMoney}`);

// Telling a wallet about older money after it already knows newer money is the risky order on a server we don't trust.
const outOfOrder = await open(tip);
await outOfOrder.scanTxs([SPEND]);
try {
  await outOfOrder.scanTxs([RECEIVE]);
  report.outOfOrder = { result: 'accepted', ...(await state(outOfOrder)) };
} catch (error) {
  report.outOfOrder = { result: 'refused', message: String(error.message ?? error).slice(0, 160), ...(await state(outOfOrder)) };
}
console.log('newest first, then older:', JSON.stringify(report.outOfOrder));

try {
  const built = await fast.createTx({ accountIndex: 0, address: second.address, amount: 1000000000n, relay: false });
  report.fastCanSpendChange = String(built.getFee());
  console.log('fast wallet built a payment from its change, fee', report.fastCanSpendChange);
} catch (error) {
  report.fastSpendError = String(error.message ?? error).slice(0, 200);
  console.log('fast wallet could not spend yet:', report.fastSpendError);
}
fs.writeFileSync(new URL('scan-spend-result.json', import.meta.url), JSON.stringify(report, null, 2));
process.exit(0);
