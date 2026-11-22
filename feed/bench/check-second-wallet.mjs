// Did the money really arrive? Opens the receiving test wallet on its own and reads its balance.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../extension/package.json', import.meta.url));
const moneroTs = require('monero-ts');
const lib = moneroTs.default ?? moneroTs;
const second = JSON.parse(fs.readFileSync(new URL('../../extension/tests/stagenet-second-wallet.json', import.meta.url), 'utf8'));

const wallet = await lib.createWalletFull({ networkType: lib.MoneroNetworkType.STAGENET, password: 'x', seed: second.seed, restoreHeight: 2243800, server: { uri: 'http://node2.monerodevs.org:38089' }, proxyToWorker: false });
await wallet.sync();
const txs = await wallet.getTxs();
console.log(`second wallet balance ${lib.MoneroUtils.atomicUnitsToXmr(await wallet.getBalance(0))} XMR, height ${await wallet.getHeight()}`);
for (const tx of txs) console.log(`  ${tx.getHash()} incoming ${lib.MoneroUtils.atomicUnitsToXmr(tx.getIncomingAmount() ?? 0n)}`);
process.exit(0);
