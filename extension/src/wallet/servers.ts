// The servers each network talks to. Plain data, so the build config can read it to set the extension's site permissions.

export type NetworkName = 'stagenet' | 'mainnet';

export const SERVERS: Record<NetworkName, { nodes: string[]; feed: string }> = {
  // Monero's free test network.
  stagenet: {
    nodes: ['http://node.monerodevs.org:38089', 'http://node2.monerodevs.org:38089', 'http://node3.monerodevs.org:38089', 'https://stagenet.xmr.kernal.eu:38089'],
    // The scan feed. During development it runs locally (feed/src/feed.mjs).
    feed: 'http://127.0.0.1:8787',
  },
  // Real Monero. Public servers only, HTTPS only, each run by someone different, so no one of them is the whole story. All of
  // them answered every call the wallet and its feed checks make on 2026-11-07 (picked from monero.fail's list).
  mainnet: {
    nodes: [
      'https://xmr-node.cakewallet.com:18081',
      'https://monero.definitelynotafed.com',
      'https://xmr.support:18089',
      'https://xmr-01.tari.com',
      'https://xmr.unshakled.net',
      'https://chad.fiatfaucet.com',
      'https://xmr.marritt.ca',
      'https://xmr1.doggett.tech:18089',
      'https://monero.openinternet.io',
      // Also in Cake Wallet's built-in list; added 2026-11-21 after they answered.
      'https://node.sethforprivacy.com:443',
      'https://node.monerodevs.org:18089',
      'https://node2.monerodevs.org:18089',
      'https://node3.monerodevs.org:18089',
    ],
    // Local feed for development. A public release must point at a hosted feed (check-release.mjs refuses this one).
    feed: 'http://127.0.0.1:8797',
  },
};

/** The build mode decides the network: `mainnet` and `mainnet-test` are real Monero, everything else is the test network. */
export const networkOfMode = (mode: string | undefined): NetworkName => (mode?.startsWith('mainnet') ? 'mainnet' : 'stagenet');

/** Chrome site permission for one server address, port included. */
export const sitePattern = (url: string) => { const u = new URL(url); return `${u.protocol}//${u.host}/*`; };
