// Makes a throwaway stagenet wallet with Node so the browser result can be compared against it. Stagenet coins have no value.
import moneroTs from 'monero-ts';
const w = await moneroTs.createWalletKeys({ networkType: moneroTs.MoneroNetworkType.STAGENET, language: 'English', proxyToWorker: false });
console.log(JSON.stringify({ seed: await w.getSeed(), address: await w.getPrimaryAddress() }));
await w.close();
process.exit(0);
