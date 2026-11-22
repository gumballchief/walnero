// Which Monero the iPhone app talks to. It's one app: Developer settings switches between real Monero and the free test
// network (stagenet). The choice lives in the native side, which sets window.__walneroNet before any script runs and reloads
// the page when it changes, so everything here can stay a plain constant.
//
// The app calls Monero servers straight from its web view, so it can only use servers that allow that (CORS) over HTTPS.
// Checked 2026-11-21: 6 of the 9 real-Monero servers do (not tari.com or marritt.ca, and chad.fiatfaucet.com answers the
// preflight without allowing Content-Type, which blocks the wallet engine's requests). On the test network only
// stagenet.xmr.kernal.eu does; the monerodevs.org servers are plain HTTP, which an iPhone app can't call.
import { SERVERS } from '../src/wallet/servers';

const NO_CORS = new Set(['https://xmr-01.tari.com', 'https://xmr.marritt.ca', 'https://chad.fiatfaucet.com', 'https://node.monerodevs.org:18089', 'https://node2.monerodevs.org:18089', 'https://node3.monerodevs.org:18089']);
const TEST = (globalThis as any).__walneroNet === 'stagenet';

export const MAINNET = !TEST;
export const NETWORK_NAME = (TEST ? 'stagenet' : 'mainnet') as 'stagenet' | 'mainnet';
export const NETWORK = {
  nodes: TEST ? ['https://stagenet.xmr.kernal.eu:38089'] : SERVERS.mainnet.nodes.filter((node) => !NO_CORS.has(node)),
  // Set when the app is built (WALNERO_FEED / WALNERO_FEED_TEST); otherwise the network's default feed.
  feed: ((TEST ? import.meta.env.VITE_FEED_STAGENET : import.meta.env.VITE_FEED_MAINNET) as string) || SERVERS[NETWORK_NAME].feed,
};
export const NETWORK_WORDS = TEST ? 'test network' : 'Monero';
