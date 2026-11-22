// Checks the 12-word to Monero derivation against Cake Wallet's own test phrases (cw_monero/test/bip39_seed_test.dart).
// Run with: node --experimental-strip-types scripts/phrase-vectors.mjs
import { createRequire } from 'node:module';
import { rootKey, moneroSpendKey, isPhrase } from '../src/wallet/phrase.ts';

const require = createRequire(import.meta.url);
const monero = require('monero-ts');
const lib = monero.default ?? monero;

const VECTORS = [
  ['meadow tip best belt boss eyebrow control affair eternal piece very shiver', 0, 'tasked eight afraid laboratory tail feline rift reinvest vane cafe bailed foggy dormant paper jigsaw king hazard suture king dapper dummy jolted dating dwindling king'],
  ['meadow tip best belt boss eyebrow control affair eternal piece very shiver', 1, 'palace pairing axes mohawk rekindle excess awful juvenile shipped talent nibs efficient dapper biggest swung fight pact innocent emerge issued titans affair nearby noises emerge'],
  ['color ranch color remove subway public water embrace before begin liberty fault', 0, 'somewhere problems gauze gigantic intended foxes upcoming saved waffle pipeline lurk bogeys empty wipeout abbey italics novelty tucks rafts elite lunar obnoxious awful bugs elite'],
  ['color ranch color remove subway public water embrace before begin liberty fault', 1, 'playful toxic wildly eluded mesh fainted february mugged maps repent vigilant hitched seventh threaten clue fetches sample diet number alkaline future cottage tuition vegan alkaline'],
];
let failed = 0;
for (const [phrase, account, want] of VECTORS) {
  const spend = moneroSpendKey(await rootKey(phrase), account);
  const keys = await lib.createWalletKeys({ networkType: lib.MoneroNetworkType.MAINNET, privateSpendKey: spend });
  const got = await keys.getSeed();
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} account ${account} of "${phrase.split(' ').slice(0, 3).join(' ')}..."${ok ? '' : `\n  got  ${got}\n  want ${want}`}`);
}
console.log(`${isPhrase('meadow tip best belt boss eyebrow control affair eternal piece very shiver') ? 'PASS' : 'FAIL'} a real phrase passes its checksum`);
console.log(`${!isPhrase('meadow tip best belt boss eyebrow control affair eternal piece very very') ? 'PASS' : 'FAIL'} a mistyped phrase fails its checksum`);
process.exit(failed ? 1 : 0);
