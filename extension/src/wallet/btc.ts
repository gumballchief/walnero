// Bitcoin, as a token inside the Monero wallet, from the same 12 words. Native SegWit addresses (bc1q..., BIP84), the kind
// most wallets use, found with the standard gap limit of 20, so a phrase used in another wallet shows the same coins here.
//
// Balances and history come from public Esplora servers: mempool.space, with Blockstream's as the backup. Like most phone
// wallets, those servers see which addresses are asked about. Nothing secret leaves the device: payments are built and
// signed here, and only the finished, signed payment is handed over to be broadcast.
import { HDKey } from '@scure/bip32';
import { Address, NETWORK, OutScript, TEST_NETWORK, Transaction, p2wpkh, selectUTXO } from '@scure/btc-signer';
import { hex } from '@scure/base';

export interface BtcNet { coin: 0 | 1; network: typeof NETWORK; apis: string[]; explorer: string; name: string }
// The test network uses Bitcoin's testnet4, whose coins have no value, the way Monero's test network uses stagenet.
export const btcNet = (mainnet: boolean): BtcNet => (mainnet
  ? { coin: 0, network: NETWORK, apis: ['https://mempool.space/api', 'https://blockstream.info/api'], explorer: 'https://mempool.space/tx/', name: 'Bitcoin' }
  : { coin: 1, network: TEST_NETWORK, apis: ['https://mempool.space/testnet4/api'], explorer: 'https://mempool.space/testnet4/tx/', name: 'test Bitcoin' });

export const accountPath = (net: BtcNet) => `m/84'/${net.coin}'/0'`;
// The account's public key: enough to list addresses and read balances, never to spend.
export const accountKey = (root: HDKey, net: BtcNet) => root.derive(accountPath(net)).publicExtendedKey;

const GAP = 20; // unused addresses in a row before a full scan stops (BIP44's standard)
const LOOK_AHEAD = 3; // past the last used one, on later refreshes
const AT_ONCE = 8;
export const DUST = 546; // the smallest payment every Bitcoin node relays
export const SATS = 100_000_000;

export interface BtcAddr { chain: 0 | 1; index: number; address: string; txs: number; balance: number; pending: number }
// A transaction cut down to what the wallet needs: each input's and output's address and amount, in satoshis.
interface RawTx { txid: string; fee: number; confirmed: boolean; height: number; time: number; vin: [string, number][]; vout: [string, number][] }
export interface BtcTx { txid: string; incoming: boolean; amount: number; fee?: number; confirmed: boolean; confirmations: number; time: number; height?: number; to?: string[]; on?: string; self?: boolean }
export interface BtcState { used: BtcAddr[]; next: [number, number]; balance: number; pending: number; raw: RawTx[]; height: number; updated: number }
export const BLANK_BTC: BtcState = { used: [], next: [0, 0], balance: 0, pending: 0, raw: [], height: 0, updated: 0 };

export class BtcAccount {
  private chains: [HDKey, HDKey];
  private made = new Map<string, string>();
  readonly net: BtcNet;
  constructor(xpub: string, net: BtcNet) {
    this.net = net;
    const key = HDKey.fromExtendedKey(xpub);
    this.chains = [key.deriveChild(0), key.deriveChild(1)];
  }
  publicKey(chain: 0 | 1, index: number) {
    return this.chains[chain].deriveChild(index).publicKey!;
  }
  address(chain: 0 | 1, index: number) {
    const id = `${chain}/${index}`;
    let address = this.made.get(id);
    if (!address) { address = p2wpkh(this.publicKey(chain, index), this.net.network).address!; this.made.set(id, address); }
    return address;
  }
}

// One server request, moving on to the backup server if the first can't answer.
async function api(net: BtcNet, path: string, init?: RequestInit): Promise<Response> {
  let failure: unknown;
  for (const base of net.apis) {
    try {
      const response = await fetch(base + path, { ...init, signal: AbortSignal.timeout(15000) });
      if (response.ok) return response;
      const text = (await response.text()).slice(0, 300);
      failure = new Error(response.status === 429 ? 'The Bitcoin server is busy. Try again in a moment.' : text || `Bitcoin server error ${response.status}`);
      if (init?.method === 'POST' && response.status === 400) break; // the payment itself was refused; another server would say the same
    } catch (error) {
      failure = error;
    }
  }
  throw failure instanceof Error && /fetch|network|load failed|abort|time/i.test(failure.message) ? new Error("Couldn't reach a Bitcoin server. Check your connection.") : failure;
}

async function stats(net: BtcNet, address: string) {
  const j = await (await api(net, `/address/${address}`)).json();
  const c = j.chain_stats, m = j.mempool_stats;
  return { txs: c.tx_count + m.tx_count, balance: c.funded_txo_sum - c.spent_txo_sum + m.funded_txo_sum - m.spent_txo_sum, pending: m.funded_txo_sum - m.spent_txo_sum };
}

async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += AT_ONCE) out.push(...await Promise.all(items.slice(i, i + AT_ONCE).map(work)));
  return out;
}

const cut = (t: any): RawTx => ({
  txid: t.txid, fee: t.fee ?? 0, confirmed: Boolean(t.status?.confirmed), height: t.status?.block_height ?? 0, time: t.status?.block_time ?? 0,
  vin: (t.vin ?? []).map((i: any) => [i.prevout?.scriptpubkey_address ?? '', i.prevout?.value ?? 0]),
  vout: (t.vout ?? []).map((o: any) => [o.scriptpubkey_address ?? '', o.value ?? 0]),
});

// Brings the account up to date. The first sync of a session walks both chains to the gap limit; after that it re-reads the
// addresses already used and a few past them, and history only for addresses whose numbers moved.
export async function syncBtc(acct: BtcAccount, prev: BtcState, full: boolean): Promise<BtcState> {
  const net = acct.net;
  const before = new Map(prev.used.map((a) => [a.address, a]));
  const used: BtcAddr[] = [];
  for (const chain of [0, 1] as const) {
    const known = full ? [] : prev.used.filter((a) => a.chain === chain);
    const found = await inBatches(known, async (a) => ({ ...a, ...(await stats(net, a.address)) }));
    let last = Math.max(-1, ...found.filter((a) => a.txs > 0).map((a) => a.index));
    let index = full ? 0 : Math.max(last + 1, prev.next[chain]);
    const need = full ? GAP : LOOK_AHEAD;
    for (;;) {
      const batch = Array.from({ length: full ? 10 : LOOK_AHEAD }, (_, k) => index + k);
      const seen = await inBatches(batch, async (i) => ({ chain, index: i, address: acct.address(chain, i), ...(await stats(net, acct.address(chain, i))) }));
      for (const a of seen) if (a.txs > 0) { found.push(a); last = Math.max(last, a.index); }
      index += batch.length;
      if (index - last - 1 >= need) break;
    }
    used.push(...found.filter((a) => a.txs > 0));
  }
  used.sort((a, b) => a.chain - b.chain || a.index - b.index);
  const next: [number, number] = [0, 1].map((chain) => Math.max(0, ...used.filter((a) => a.chain === chain).map((a) => a.index + 1))) as [number, number];

  // History: only addresses that changed, or still have something waiting for a block.
  const raw = new Map(prev.raw.map((t) => [t.txid, t]));
  const stale = used.filter((a) => { const b = before.get(a.address); return full || !b || b.txs !== a.txs || b.pending !== 0 || a.pending !== 0; });
  for (const list of await inBatches(stale, async (a) => (await (await api(net, `/address/${a.address}/txs`)).json()) as any[])) {
    for (const t of list) raw.set(t.txid, cut(t));
  }
  const height = Number(await (await api(net, '/blocks/tip/height')).text()) || prev.height;
  const kept = [...raw.values()].sort((a, b) => Number(a.confirmed) - Number(b.confirmed) || b.height - a.height).slice(0, 100);
  return {
    used, next, raw: kept, height, updated: Date.now(),
    balance: used.reduce((sum, a) => sum + a.balance, 0),
    pending: used.reduce((sum, a) => sum + Math.max(0, a.pending), 0),
  };
}

// What each transaction meant for this wallet: money in, money out (to whom, and the fee), or a move between its own addresses.
export function btcHistory(acct: BtcAccount, state: BtcState): BtcTx[] {
  const ours = new Set(state.used.map((a) => a.address));
  for (const chain of [0, 1] as const) for (let i = 0; i < state.next[chain] + LOOK_AHEAD; i++) ours.add(acct.address(chain, i));
  return state.raw.map((t) => {
    const spent = t.vin.reduce((sum, [a, v]) => sum + (ours.has(a) ? v : 0), 0);
    const back = t.vout.filter(([a]) => ours.has(a));
    const away = t.vout.filter(([a]) => !ours.has(a));
    const base = { txid: t.txid, confirmed: t.confirmed, confirmations: t.confirmed && state.height ? state.height - t.height + 1 : 0, time: t.time || Math.floor(state.updated / 1000), ...(t.height && { height: t.height }) };
    if (!spent) return { ...base, incoming: true, amount: back.reduce((sum, [, v]) => sum + v, 0), on: back[0]?.[0] };
    const amount = away.reduce((sum, [, v]) => sum + v, 0);
    return { ...base, incoming: false, amount, fee: t.fee, to: away.map(([a]) => a).filter(Boolean), ...(!amount && { self: true }) };
  });
}

// The first receive address nobody has paid yet. It stays the same until it's used, like most Bitcoin wallets.
export const receiveAddress = (acct: BtcAccount, state: BtcState) => acct.address(0, state.next[0]);

export function checkAddress(net: BtcNet, address: string) {
  try {
    OutScript.encode(Address(net.network).decode(address.trim()));
  } catch {
    throw new Error(`That isn't a valid ${net.name} address`);
  }
}

export interface Fees { slow: number; normal: number; fast: number }
// Rates in satoshis per virtual byte for about an hour, half an hour and the next block. mempool.space's own estimate first,
// Blockstream's backup estimate otherwise. Never under 1, the network's floor.
export async function btcFees(net: BtcNet): Promise<Fees> {
  let rates: Fees;
  try {
    const j = await (await api({ ...net, apis: net.apis.filter((a) => a.includes('mempool.space')) }, '/v1/fees/recommended')).json();
    rates = { slow: j.hourFee, normal: j.halfHourFee, fast: j.fastestFee };
  } catch {
    const j = await (await api(net, '/fee-estimates')).json();
    rates = { slow: j['6'], normal: j['3'], fast: j['1'] };
  }
  const floor = (n: number) => Math.max(1, Math.ceil(Number(n) || 1));
  return { slow: floor(rates.slow), normal: Math.max(floor(rates.normal), floor(rates.slow)), fast: Math.max(floor(rates.fast), floor(rates.normal)) };
}

// Coins that can be spent: confirmed ones, plus this wallet's own change still waiting for a block (it can't be pulled back
// by someone else, so building on it is safe).
interface Spendable { txid: Uint8Array; index: number; witnessUtxo: { script: Uint8Array; amount: bigint }; chain: 0 | 1; at: number }
export async function spendable(acct: BtcAccount, state: BtcState): Promise<Spendable[]> {
  const net = acct.net;
  const list = await inBatches(state.used.filter((a) => a.balance > 0), async (a) => {
    const utxos = (await (await api(net, `/address/${a.address}/utxo`)).json()) as any[];
    const script = p2wpkh(acct.publicKey(a.chain, a.index), net.network).script;
    return utxos.filter((u) => u.status?.confirmed || a.chain === 1).map((u) => ({ txid: hex.decode(u.txid), index: u.vout, witnessUtxo: { script, amount: BigInt(u.value) }, chain: a.chain, at: a.index }));
  });
  return list.flat();
}

export interface BtcPlan { tx: Transaction; fee: number; amount: number; to: string; keys: { chain: 0 | 1; index: number }[] }
// Picks coins and builds the payment, unsigned. 'all' sends everything, less the fee.
export function planPayment(acct: BtcAccount, state: BtcState, coins: Spendable[], to: string, amount: number | 'all', feeRate: number): BtcPlan {
  const net = acct.net;
  checkAddress(net, to);
  const opts = { feePerByte: BigInt(feeRate), network: net.network, createTx: true, bip69: true };
  const inputs = coins.map(({ txid, index, witnessUtxo }) => ({ txid, index, witnessUtxo }));
  const picked = amount === 'all'
    ? selectUTXO(inputs, [], 'all', { ...opts, changeAddress: to.trim() })
    : selectUTXO(inputs, [{ address: to.trim(), amount: BigInt(amount) }], 'default', { ...opts, changeAddress: acct.address(1, state.next[1]) });
  if (!picked?.tx || picked.fee === undefined) throw new Error(coins.length ? "You don't have enough Bitcoin for that and its fee" : 'No Bitcoin ready to send yet. Coins can be sent once they have a confirmation.');
  const keys = picked.inputs.map((input: any) => {
    const coin = coins.find((c) => hex.encode(c.txid) === hex.encode(input.txid) && c.index === input.index)!;
    return { chain: coin.chain, index: coin.at };
  });
  const sent = amount === 'all' ? Number(picked.outputs.reduce((sum: bigint, o: any) => sum + BigInt(o.amount), 0n)) : amount;
  if (sent < DUST) throw new Error('That amount is too small to send on Bitcoin, after the fee.');
  return { tx: picked.tx, fee: Number(picked.fee), amount: sent, to: to.trim(), keys };
}

// Signs every input with its own key, from the root key, and returns the finished payment.
export function signPayment(plan: BtcPlan, root: HDKey, net: BtcNet): { txid: string; raw: string } {
  plan.keys.forEach(({ chain, index }, i) => {
    const key = root.derive(`${accountPath(net)}/${chain}/${index}`).privateKey;
    if (!key) throw new Error("Couldn't sign the payment");
    plan.tx.signIdx(key, i);
  });
  plan.tx.finalize();
  return { txid: plan.tx.id, raw: plan.tx.hex };
}

export async function broadcast(net: BtcNet, raw: string): Promise<string> {
  const response = await api(net, '/tx', { method: 'POST', body: raw });
  return (await response.text()).trim();
}

export const toBtc = (sats: number) => (sats / SATS).toFixed(8);
export function fromBtc(text: string): number {
  const clean = text.trim();
  if (!/^\d*\.?\d{0,8}$/.test(clean) || clean === '' || clean === '.') throw new Error('Enter an amount, like 0.001');
  const [whole, fraction = ''] = clean.split('.');
  return Number(BigInt(whole || '0') * BigInt(SATS) + BigInt(fraction.padEnd(8, '0')));
}
