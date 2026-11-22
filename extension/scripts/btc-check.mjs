// Bitcoin checks with no money involved.
//  1. BIP84's published test vectors: the "abandon ... about" phrase gives the standard first addresses and account key.
//  2. A payment built from made-up coins at this wallet's own addresses: every input's signature verifies against the coin's
//     public key, the fee is what the rate says, change goes back to the wallet, and sending everything leaves no change.
//  3. A real read-only scan of that public test phrase on mainnet (lots of people have sent it dust), to prove the scan,
//     the gap limit and the history parsing work against the live servers.
// Run with: node --experimental-strip-types scripts/btc-check.mjs
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { OutScript, SigHash, p2wpkh } from '@scure/btc-signer';
import { rootKey } from '../src/wallet/phrase.ts';
import { BLANK_BTC, BtcAccount, accountKey, btcHistory, btcNet, planPayment, signPayment, syncBtc, receiveAddress, btcFees, toBtc } from '../src/wallet/btc.ts';

const results = [];
const check = (ok, what) => results.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const net = btcNet(true);
const root = await rootKey(PHRASE);
const acct = new BtcAccount(accountKey(root, net), net);

// 1. BIP84 test vectors (github.com/bitcoin/bips/blob/master/bip-0084.mediawiki).
check(acct.address(0, 0) === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', `first receive address (${acct.address(0, 0)})`);
check(acct.address(0, 1) === 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g', `second receive address (${acct.address(0, 1)})`);
check(acct.address(1, 0) === 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el', `first change address (${acct.address(1, 0)})`);

// 2. A payment from made-up coins at our own addresses 0/0, 0/1 and 1/0.
const coin = (chain, index, sats, n) => ({ txid: hex.decode(n.toString(16).padStart(64, '0')), index: 0, witnessUtxo: { script: p2wpkh(acct.publicKey(chain, index), net.network).script, amount: BigInt(sats) }, chain, at: index });
const coins = [coin(0, 0, 40_000, 1), coin(0, 1, 25_000, 2), coin(1, 0, 60_000, 3)];
const state = { ...BLANK_BTC, next: [2, 1] };
const verifyAll = (tx, plan) => plan.keys.every(({ chain, index }, i) => {
  const input = tx.getInput(i);
  const [sig, pub] = input.finalScriptWitness;
  const mine = acct.publicKey(chain, index);
  if (hex.encode(pub) !== hex.encode(mine)) return false;
  const script = OutScript.encode({ type: 'pkh', hash: p2wpkh(pub).hash });
  const digest = tx.preimageWitnessV0(i, script, SigHash.ALL, input.witnessUtxo.amount);
  return sig[sig.length - 1] === SigHash.ALL && secp256k1.verify(sig.slice(0, -1), digest, pub, { prehash: false, format: 'der' });
});
const outside = 'bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c'; // BIP84 vector from another phrase, not ours
let plan = planPayment(acct, state, coins, outside, 50_000, 5);
let signed = signPayment(plan, root, net);
const vsize = plan.tx.vsize;
check(verifyAll(plan.tx, plan), `every input of a 0.0005 BTC payment has a valid signature (${plan.keys.length} inputs)`);
const outs = Array.from({ length: plan.tx.outputsLength }, (_, i) => plan.tx.getOutput(i));
const toOut = outs.find((o) => hex.encode(o.script) === hex.encode(OutScript.encode({ type: 'wpkh', hash: p2wpkh(acct.publicKey(0, 0)).hash })));
check(!toOut, 'nothing is paid back to a used receive address');
const change = outs.find((o) => hex.encode(o.script) === hex.encode(p2wpkh(acct.publicKey(1, 1), net.network).script));
const paid = outs.find((o) => o.amount === 50_000n);
check(Boolean(paid) && Boolean(change), 'the payment pays 50,000 sats and sends change to the next change address (1/1)');
const inputSum = plan.keys.reduce((s, k) => s + Number(coins.find((c) => c.chain === k.chain && c.at === k.index).witnessUtxo.amount), 0);
check(inputSum === 50_000 + plan.fee + Number(change?.amount ?? 0n), `inputs = payment + fee + change (fee ${plan.fee} sats)`);
check(plan.fee >= vsize * 5 && plan.fee <= vsize * 5 + 50, `the fee matches 5 sat/vB for ${vsize} vbytes (${plan.fee})`);
check(/^[0-9a-f]{64}$/.test(signed.txid) && signed.raw.length > 200, `a txid and raw payment come out (${signed.txid.slice(0, 12)}...)`);

plan = planPayment(acct, state, coins, outside, 'all', 3);
signed = signPayment(plan, root, net);
check(verifyAll(plan.tx, plan) && plan.tx.outputsLength === 1 && plan.amount === 125_000 - plan.fee, `sending everything: one output of ${plan.amount} sats, all inputs signed`);
let refused = '';
try { planPayment(acct, state, coins, outside, 200_000, 5); } catch (e) { refused = e.message; }
check(/enough/i.test(refused), `more than the balance is refused ("${refused}")`);
try { planPayment(acct, state, coins, 'bc1qnotanaddress', 1000, 5); refused = ''; } catch (e) { refused = e.message; }
check(/valid/i.test(refused), `a bad address is refused ("${refused}")`);
try { planPayment(acct, state, coins, 'tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl', 1000, 5); refused = ''; } catch (e) { refused = e.message; }
check(/valid/i.test(refused), 'a test-network address is refused on mainnet');

// 3. Live, read-only scan of the public test phrase.
const started = Date.now();
const live = await syncBtc(acct, BLANK_BTC, true);
const txs = btcHistory(acct, live);
check(live.used.length > 0 && live.height > 900_000, `live scan found ${live.used.length} used addresses at height ${live.height} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
check(txs.length > 0 && txs.every((t) => /^[0-9a-f]{64}$/.test(t.txid)), `history parsed: ${txs.length} transactions, balance ${toBtc(live.balance)} BTC`);
check(receiveAddress(acct, live) === acct.address(0, live.next[0]), `next receive address is ${live.next[0]} (after the last used one)`);
const again = await syncBtc(acct, live, false);
check(again.used.length === live.used.length && again.balance === live.balance, 'a quick refresh agrees with the full scan');
const fees = await btcFees(net);
check(fees.slow >= 1 && fees.normal >= fees.slow && fees.fast >= fees.normal, `fee rates: slow ${fees.slow}, normal ${fees.normal}, fast ${fees.fast} sat/vB`);

console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
