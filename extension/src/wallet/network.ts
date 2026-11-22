// Which Monero this build talks to. Fixed when it's built, never switched at runtime:
//   npm run build, npm run build:test                  Monero's free test network (stagenet)
//   npm run build:mainnet, npm run build:mainnet-test  real Monero
import { SERVERS } from '@/wallet/servers';

export const MAINNET = import.meta.env.MODE === 'mainnet' || import.meta.env.MODE === 'mainnet-test';
export const NETWORK_NAME = MAINNET ? 'mainnet' : 'stagenet';
export const NETWORK = SERVERS[NETWORK_NAME];
/** How screens talk about the network: "a Monero address" or "a test network address". */
export const NETWORK_WORDS = MAINNET ? 'Monero' : 'test network';
