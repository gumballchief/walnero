// The wallet lives here, not in the service worker: Chrome kills service workers after about 30 seconds idle,
// while an offscreen document stays up and can run Monero's wallet code in a Web Worker.
// The password and seed never leave this page except the one time a new seed is shown to be written down.
//
// Rule for this file: nothing a screen is waiting on may wait on the engine or the network. Unlocking returns as soon as the
// saved balance can be read, then the engine opens and the wallet catches up behind the screen that's already showing.
import { deriveKey, kvGet, kvSet, PBKDF2_ITERATIONS, seal, sealJson, unseal, unsealJson, type Sealed } from '@/wallet/vault';
import { findSpends, makeTable, planChunks, readManifest, scanChunks, setFeedForTest, type Hit, type Manifest, type ScanKeys } from '@/wallet/scan-pool';
import { chainOutputs, compareWithChain, FeedRejected, pickSpots, rebuildBlock } from '@/wallet/feed-check';
import { MAINNET, NETWORK, NETWORK_NAME, NETWORK_WORDS } from '@/wallet/network';
import { cleanPhrase, isPhrase, moneroSpendKey, newPhrase, phraseWordCount, rootKey } from '@/wallet/phrase';
import { BLANK_BTC, BtcAccount, accountKey, broadcast, btcFees, btcHistory, btcNet, checkAddress, fromBtc, planPayment, receiveAddress, signPayment, spendable, syncBtc, toBtc, type BtcPlan, type BtcState } from '@/wallet/btc';
import { resolveAlias, type AliasCoin } from '@/wallet/openalias';

// The engine is 3 MB of code, so it only loads when something needs it. Background scanning never does.
let enginePromise: Promise<any> | null = null;
const engine = () => (enginePromise ??= import('monero-ts').then((m) => {
  const lib = m.default;
  lib.LibraryUtils.setWorkerDistPath(chrome.runtime.getURL('engine/monero.worker.js'));
  return lib;
}));

let NODES = [...NETWORK.nodes];
// Test only (set by testDropHits): blocks the scan pretends it never matched, and whether to skip the spend check.
let dropForTest = new Set<number>();
let skipSpendCheckForTest = false;
// The engine's name for the network this build is on.
const netType = (lib: any) => (MAINNET ? lib.MoneroNetworkType.MAINNET : lib.MoneroNetworkType.STAGENET);
// Settings the engine itself uses, kept in plain storage (nothing secret): how long before it locks itself, and whether to
// open through the fast feed. The screens keep the rest here: hidden balance, the timings line, and prices.
// node: 'auto' (the fastest healthy built-in node) or the address of the one the user picked. customNodes: nodes the user
// added, like Cake Wallet's "+", with an optional Trusted flag meant only for a node they run themselves.
interface CustomNode { url: string; label: string; trusted: boolean }
// btc: Bitcoin shown as a token (Manage tokens). Only 12-word wallets have it.
interface Prefs { autoLock: number; fastOpen: boolean; hidden: boolean; timings: boolean; prices: boolean; btc: boolean; node: string; customNodes: CustomNode[] }
const DEFAULT_PREFS: Prefs = { autoLock: 15, fastOpen: true, hidden: false, timings: false, prices: true, btc: true, node: 'auto', customNodes: [] };
const AUTO_LOCK_CHOICES = [1, 5, 15, 60];
let prefs: Prefs = { ...DEFAULT_PREFS };
// --- Wallets ---
// Every wallet on this device. The first one keeps the original storage names ('vault', 'data', 'snap', 'scan-keys',
// 'scan-state'), so nothing that already exists moves; each wallet added later keeps its own copies under `w:<id>:`. One
// password opens them all: the first wallet's vault is the password check, and every other wallet's words are sealed with the
// same key. Saved names and settings are shared by all wallets.
interface WalletEntry { id: string; label: string; address: string; created: number; viewOnly?: boolean }
interface WalletRegistry { active: string; list: WalletEntry[] }
let activeId = 'main';
const walletsLoaded = kvGet<WalletRegistry>('wallets').then((r) => { if (r?.active) activeId = r.active; }).catch(() => {});
const wk = (name: string, id = activeId) => (id === 'main' ? name : `w:${id}:${name}`);
const DEFAULT_LABEL = MAINNET ? 'Main wallet' : 'Test wallet';
async function readRegistry(): Promise<WalletRegistry> {
  await walletsLoaded;
  const saved = await kvGet<WalletRegistry>('wallets');
  if (saved?.list?.length) return saved;
  return { active: 'main', list: [{ id: 'main', label: DEFAULT_LABEL, address: '', created: 0 }] };
}
const writeRegistry = (registry: WalletRegistry) => kvSet('wallets', registry);

const prefsLoaded = kvGet<Prefs>('prefs').then((saved) => { if (saved) prefs = { ...DEFAULT_PREFS, ...saved }; }).catch(() => {});
const SAVE_EVERY_MS = 5 * 60 * 1000;
const REFRESH_EVERY_MS = 15 * 1000;
const SYNC_EVERY_MS = 20 * 1000;
const POOL_SIZE = 5;
const RETRY_OFFLINE_MS = 15 * 1000;
// wallet2 reads the last few blocks itself, which also covers the chain tip being rearranged.
const WALLET_READS_LAST = 10;
const DECOY_BLOCKS = 6;
const FETCH_AT_ONCE = 3;
const BACKGROUND_THREADS = 2;

interface VaultRecord { salt: Uint8Array<ArrayBuffer>; iterations: number; sealed: Sealed }
// seed: the 25 Monero words. mnemonic: the 12-word phrase (BIP39) a wallet made since 0.8 is backed up with; its 25 Monero
// words are worked out from it (see wallet/phrase.ts) and kept alongside. A view-only wallet has neither, only its address and
// private view key: it sees payments coming in and can't spend. (A wallet imported with its spend key is kept as its 25 words,
// since those words are that key written out.)
interface Secret { seed: string; restoreHeight: number; walletPassword: string; mnemonic?: string; address?: string; viewKey?: string }
type SecretFrom = Pick<Secret, 'seed' | 'mnemonic' | 'address' | 'viewKey'>;
// For the transaction screen: fee (sends only), block height, where a send went (known only when it was made on this device),
// and which of this wallet's addresses a payment came in on.
interface Tx { hash: string; incoming: boolean; amount: string; confirmations: number; confirmed: boolean; time: number; fee?: string; height?: number; to?: string[]; on?: string }
// elsewhere: payments this wallet made from another device that only the spend check found (see spendsOfNewCoins).
interface Elsewhere { hash: string; amount: string; height: number; time: number }
interface Snapshot { balance: string; unlocked: string; onTheWay: string; height: number; target: number; percent: number; txs: Tx[]; pool: string[]; elsewhere?: Elsewhere[] }
// opening: engine starting. checking: scanning the feed. applying: handing matches to wallet2. finishing: wallet2 reading the
// last blocks. live: up to date. slow: no feed, wallet2 is doing it block by block. offline: no server reachable right now.
type Phase = 'opening' | 'checking' | 'applying' | 'finishing' | 'live' | 'slow' | 'offline' | 'failed';

const BLANK: Snapshot = { balance: '0.000000000000', unlocked: '0.000000000000', onTheWay: '0.000000000000', height: 0, target: 0, percent: 0, txs: [], pool: [] };

interface Session {
  id: string; // Which wallet this is (see Wallets). Every save goes to this wallet's storage, never "whichever is active now".
  viewOnly: boolean; // Made from an address and view key only: it watches, it can't send.
  phrase: boolean; // Backed up with 12 words (so other coins, like Bitcoin, can come from the same words).
  pendingReview: string;
  key: CryptoKey;
  secret: Secret;
  wallet: any;
  node: string;
  pending: any;
  saved: number;
  syncing: boolean;
  refreshing: boolean;
  snap: Snapshot;
  phase: Phase;
  checked: { blocks: number; done: number; total: number };
  ready: Promise<void>;
  markReady: () => void;
  times: Record<string, number>;
  scan: { txs: number; bytes: number; fast: boolean; hits: number; threads: number; files: number; checkedBlocks: number; spotChecks: number } | null;
  feedRejected: boolean;
  full: { running: boolean; before: string; after: string; error: string } | null;
  fellBack: string;
  firstOpen: boolean; // Never been saved, so wallet2 still has to walk the chain's block list once before it can send.
  sendPaused: number; // When Send opened and background refreshes stopped, or 0.
  // Bitcoin from the same 12 words: the account's public key (lists addresses, can't spend), what was last read, and a payment
  // waiting for its review to be confirmed. Spending re-opens the words from the vault just for the signature.
  btc: { acct: BtcAccount; state: BtcState; syncing: Promise<void> | null; scanned: boolean; error: string } | null;
  btcPending: { plan: BtcPlan; review: string } | null;
  spendCheck?: { before: Set<number>; to: number; manifest: Manifest; result?: { coins: number; leads: number; found: number } };
  syncTimer?: ReturnType<typeof setTimeout>;
}
let session: Session | null = null;
let lastActive = Date.now();

// --- Servers ------------------------------------------------------------------------------------------------------------

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const allNodes = () => [...new Set([...NODES, ...prefs.customNodes.map((n) => n.url)])];

// One node's health: how long it took to answer, its height, and whether it's on this network and caught up.
async function askNode(node: string, ms = 6000) {
  const started = performance.now();
  const info = await (await fetch(`${node}/get_info`, { signal: AbortSignal.timeout(ms) })).json();
  const net = info.nettype ?? (info[NETWORK_NAME] ? NETWORK_NAME : '');
  if (net !== NETWORK_NAME) throw new Error(net ? `It's a ${net} node, not ${NETWORK_WORDS}` : `It isn't a ${NETWORK_WORDS} node`);
  if (!info.synchronized) throw new Error('It is still catching up with the network');
  return { ms: Math.round(performance.now() - started), height: info.height as number };
}

// Auto asks every built-in node at once and takes the first healthy answer, since public nodes vary a lot in speed. A node
// the user picked is used as it is, and if it's down the wallet says so instead of quietly going somewhere else.
async function pickNode(): Promise<string> {
  await prefsLoaded;
  if (prefs.node !== 'auto' && allNodes().includes(prefs.node)) {
    await askNode(prefs.node).catch(() => { throw new Error(`Your node ${hostOf(prefs.node)} isn't answering. Pick another in Settings, Network, Node.`); });
    return prefs.node;
  }
  try {
    return await Promise.any(NODES.map((node) => askNode(node).then(() => node)));
  } catch {
    throw new Error(`Couldn't reach a ${NETWORK_WORDS} server. Check your connection and try again.`);
  }
}

// Moves an open wallet to another node without closing it.
async function switchNode(s: Session, url: string) {
  if (s.full?.running) throw new Error('Wait for the full check to finish, then switch nodes.');
  const trusted = prefs.customNodes.find((n) => n.url === url)?.trusted ?? false;
  s.node = url;
  if (!s.wallet) return;
  await pauseSyncing(s);
  try {
    await s.wallet.setDaemonConnection(url, trusted);
  } finally {
    s.sendPaused = 0;
    resumeSyncing(s, 1500);
  }
}

async function nodeHeight(node: string): Promise<number> {
  const info = await (await fetch(`${node}/get_info`, { signal: AbortSignal.timeout(8000) })).json();
  return info.height;
}

// A block's transaction hashes, miner transaction first, the same order the feed uses. Public servers drop connections when
// they feel like it, so a failure moves on to the next one.
async function blockHashes(preferred: string, height: number): Promise<string[]> {
  let failure: unknown;
  for (const node of [preferred, ...NODES.filter((n) => n !== preferred)]) {
    try {
      return await blockHashesFrom(node, height);
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

async function blockHashesFrom(node: string, height: number): Promise<string[]> {
  const res = await fetch(`${node}/json_rpc`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_block', params: { height } }), signal: AbortSignal.timeout(15000) }).catch((e) => { throw new Error(`Block ${height} from ${node}: ${e.message}`); });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return [json.result.miner_tx_hash, ...(json.result.tx_hashes ?? [])];
}

// --- Payments made from another device ----------------------------------------------------------------------------------
//
// When the same wallet sends from somewhere else, wallet2 sees that payment's change coming back while it waits for a block,
// but not the coins going out, so the balance briefly reads too high. So the wallet reads the waiting payments itself: the
// whole pool, the same thing wallet2 downloads, so the server learns nothing about which ones are ours. Coins of ours that a
// waiting payment already spends come off the balance until the block lands and wallet2 catches up.
// A payment that just left the pool is usually in a block wallet2 hasn't read yet, so it's kept a while longer. If it was
// dropped instead, it stops counting after that.
const POOL_GRACE_MS = 10 * 60 * 1000;
const poolSpends = new Map<string, { images: string[]; gone?: number }>(); // waiting payment hash -> key images it spends
async function poolImages(node: string): Promise<Map<string, string>> {
  const post = async (path: string, body: unknown) => (await fetch(`${node}${path}`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })).json();
  try {
    const { tx_hashes: hashes = [] } = await post('/get_transaction_pool_hashes', {});
    const now = new Set<string>(hashes);
    for (const [hash, entry] of poolSpends) {
      if (now.has(hash)) delete entry.gone;
      else if (!entry.gone) entry.gone = Date.now();
      else if (Date.now() - entry.gone > POOL_GRACE_MS) poolSpends.delete(hash);
    }
    const fresh = hashes.filter((h: string) => !poolSpends.has(h));
    for (let i = 0; i < fresh.length; i += 100) {
      const { txs = [] } = await post('/get_transactions', { txs_hashes: fresh.slice(i, i + 100), decode_as_json: true, prune: true });
      for (const tx of txs) {
        const vin = JSON.parse(tx.as_json || '{}').vin ?? [];
        poolSpends.set(tx.tx_hash, { images: vin.map((input: any) => input.key?.k_image).filter(Boolean) });
      }
    }
  } catch (error) {
    console.warn('pool list not refreshed, using the last one', error);
  }
  const owner = new Map<string, string>();
  for (const [hash, { images }] of poolSpends) for (const image of images) owner.set(image, hash);
  return owner;
}

// Our unspent coins that a waiting payment already spends: how much in all, how much of it was spendable, and per payment.
async function leavingInPool(s: Session) {
  const leaving = { total: 0n, unlocked: 0n, byTx: new Map<string, bigint>() };
  const owner = await poolImages(s.node);
  if (!owner.size) return leaving;
  for (const out of await s.wallet.getOutputs({ isSpent: false })) {
    const hash = owner.get(out.getKeyImage()?.getHex() ?? '');
    if (!hash) continue;
    const amount: bigint = out.getAmount();
    leaving.total += amount;
    if (!out.getIsLocked()) leaving.unlocked += amount;
    leaving.byTx.set(hash, (leaving.byTx.get(hash) ?? 0n) + amount);
  }
  return leaving;
}

// --- The scanner's keys, kept so scanning can run while the wallet is locked -----------------------------------------------
//
// The view key can only reveal incoming history, never spend. It is sealed with a key this browser generated and can't
// export, so a background scan doesn't need the password. A copy of the disk could still read it, which is the same trade
// every wallet makes when it syncs without asking for a password.

interface ScanState { cursor: number; hits: Hit[]; images: number[] }

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));

async function deviceKey(): Promise<CryptoKey> {
  const existing = await kvGet<CryptoKey>('device');
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await kvSet('device', key);
  return key;
}

async function loadScanner(id?: string): Promise<{ view: Uint8Array; table: Uint8Array; state: ScanState; id: string } | null> {
  await walletsLoaded;
  const sealedKeys = await kvGet<Sealed>(wk('scan-keys', id ?? activeId));
  const sealedState = await kvGet<Sealed>(wk('scan-state', id ?? activeId));
  if (!sealedKeys || !sealedState) return null;
  const device = await deviceKey();
  const bytes = await unseal(device, sealedKeys);
  return { view: bytes.subarray(0, 32), table: bytes.subarray(32), state: await unsealJson<ScanState>(device, sealedState), id: id ?? activeId };
}

const saveState = async (state: ScanState, id = activeId) => kvSet(wk('scan-state', id), await sealJson(await deviceKey(), state));

async function prepareScanner(s: Session): Promise<{ view: Uint8Array; table: Uint8Array; state: ScanState; id: string }> {
  const existing = await loadScanner(s.id);
  if (existing) return existing;
  const view = fromHex(await s.wallet.getPrivateViewKey());
  const table = await makeTable(view, fromHex(await s.wallet.getPublicSpendKey()));
  const bytes = new Uint8Array(32 + table.length) as Uint8Array<ArrayBuffer>;
  bytes.set(view);
  bytes.set(table, 32);
  await kvSet(wk('scan-keys', s.id), await seal(await deviceKey(), bytes));
  const walletHeight = await s.wallet.getHeight();
  // A wallet that has synced before starts from its own height, a new one from where it says its history begins.
  const state: ScanState = { cursor: Math.max(s.secret.restoreHeight, walletHeight) - 1, hits: [], images: [] };
  await saveState(state, s.id);
  return { view, table, state, id: s.id };
}

const scanKeys = (view: Uint8Array, table: Uint8Array, state: ScanState): ScanKeys => ({ view, table, images: Uint32Array.from(state.images).sort() });

async function imagePrefixes(s: Session): Promise<number[]> {
  const outs = await s.wallet.getOutputs({ isSpent: false });
  const list: number[] = [];
  for (const out of outs) {
    const hex: string | undefined = out.getKeyImage()?.getHex();
    if (!hex) continue;
    const b = fromHex(hex.slice(0, 8));
    list.push(new DataView(b.buffer).getUint32(0, true));
  }
  return list;
}

let backgroundScan: AbortController | null = null;
let backgroundThreads = 0;
let backgroundDone: Promise<unknown> = Promise.resolve();
const allThreads = () => Math.max(2, Math.min(16, (navigator.hardwareConcurrency || 4) - 1));

// A quiet scan makes way, because someone is waiting now. One already running flat out just gets to finish.
async function backgroundOutOfTheWay() {
  if (backgroundScan && backgroundThreads < allThreads()) backgroundScan.abort();
  await backgroundDone;
}

// Runs through the feed from the cursor. Nothing it found counts until the chain agrees, and the checks run alongside the scan
// so they add no wait. The newest blocks stay unchecked and uncounted here, because wallet2 reads those itself.
async function advance(scanner: { view: Uint8Array; table: Uint8Array; state: ScanState; id?: string }, manifest: Manifest, threads: number, onProgress: (done: number, total: number, blocks: number) => void, signal?: AbortSignal) {
  const { state } = scanner;
  const chunks = planChunks(state.cursor, manifest);
  const blocks = manifest.tip - state.cursor;
  if (!chunks.length) return { txs: 0, bytes: 0, fast: true, files: 0, checkedBlocks: 0, spotChecks: 0 };
  const first = chunks[0].start;
  const trustedTo = manifest.tip - WALLET_READS_LAST;
  const spots = pickSpots(first, trustedTo, blocks);

  const checks = (async () => {
    const outs = trustedTo >= first ? await chainOutputs(NODES, first, trustedTo) : new Map<number, number>();
    const rebuilt = new Map<number, { txs: number; body: Uint8Array }>();
    for (let i = 0; i < spots.length; i += FETCH_AT_ONCE) {
      await Promise.all(spots.slice(i, i + FETCH_AT_ONCE).map(async (h) => rebuilt.set(h, await rebuildBlock(NODES, h))));
    }
    return { outs, rebuilt };
  })().then((value) => ({ value, failed: null }), (failed) => ({ value: null, failed }));

  const result = await scanChunks(chunks, scanKeys(scanner.view, scanner.table, state), threads, spots, (done, total) => onProgress(done, total, blocks), signal);
  if (!result.complete) return { txs: result.txs, bytes: result.bytes, fast: result.fast, files: chunks.length, checkedBlocks: 0, spotChecks: 0 };

  const { value, failed } = await checks;
  if (!value) throw new Error(`Couldn't check the feed against the chain: ${String((failed as any)?.message ?? failed)}`);
  const confirmedTo = compareWithChain(result.outs, value.outs, first, trustedTo, result.spots, value.rebuilt);

  const known = new Set(state.hits.map((h) => `${h.height}:${h.tx}:${h.kind}`));
  for (const hit of result.hits) {
    const id = `${hit.height}:${hit.tx}:${hit.kind}`;
    if (hit.height > state.cursor && !known.has(id)) { known.add(id); state.hits.push(hit); }
  }
  state.cursor = Math.max(state.cursor, confirmedTo);
  // Whichever wallet these keys belong to, open or not (the background scan runs while Walnero is closed).
  await saveState(state, scanner.id);
  return { txs: result.txs, bytes: result.bytes, fast: result.fast, files: chunks.length, checkedBlocks: value.outs.size, spotChecks: value.rebuilt.size };
}

// --- Saving and numbers ---------------------------------------------------------------------------------------------------

async function saveData(s: Session) {
  if (!s.wallet) return;
  const [keys, cache] = await s.wallet.getData();
  await kvSet(wk('data', s.id), { keys: await seal(s.key, new Uint8Array(keys)), cache: await seal(s.key, new Uint8Array(cache)) });
  s.saved = Date.now();
}

const saveSnap = async (s: Session) => kvSet(wk('snap', s.id), await sealJson(s.key, s.snap));

const toXmr = (atomic: bigint) => {
  const whole = atomic / 1000000000000n;
  const fraction = (atomic % 1000000000000n).toString().padStart(12, '0');
  return `${whole}.${fraction}`;
};
const fromXmr = (text: string): bigint => {
  const clean = text.trim();
  if (!/^\d*\.?\d{0,12}$/.test(clean) || clean === '' || clean === '.') throw new Error('Enter an amount, like 0.5');
  const [whole, fraction = ''] = clean.split('.');
  return BigInt(whole || '0') * 1000000000000n + BigInt(fraction.padEnd(12, '0'));
};

async function fillPool(s: Session) {
  while (s.snap.pool.length < POOL_SIZE) s.snap.pool.push((await s.wallet.createSubaddress(0)).getAddress());
}

// Reads fresh numbers from the engine. Only called when it isn't busy with a sync.
async function refresh(s: Session) {
  if (!s.wallet || s.syncing || s.refreshing) return;
  s.refreshing = true;
  try {
    const [rawBalance, rawUnlocked, height, target] = await Promise.all([s.wallet.getBalance(0), s.wallet.getUnlockedBalance(0), s.wallet.getHeight(), s.wallet.getDaemonHeight()]);
    const leaving = await leavingInPool(s).catch((error) => { console.warn('pool check skipped', error); return { total: 0n, unlocked: 0n, byTx: new Map<string, bigint>() }; });
    const balance = rawBalance > leaving.total ? rawBalance - leaving.total : 0n;
    const unlocked = rawUnlocked > leaving.unlocked ? rawUnlocked - leaving.unlocked : 0n;
    const txs: Tx[] = (await s.wallet.getTxs())
      .map((tx: any) => {
        const spent = tx.getIsConfirmed() ? undefined : leaving.byTx.get(tx.getHash());
        // A payment from another device: wallet2 only knows the change coming back, so show what actually left.
        const incoming = spent === undefined && Boolean(tx.getIsIncoming());
        const back: bigint = tx.getIncomingAmount() ?? 0n;
        const amount: bigint = spent !== undefined ? (spent > back ? spent - back : 0n) : ((incoming ? tx.getIncomingAmount() : tx.getOutgoingAmount()) ?? 0n);
        const fee: bigint | undefined = incoming ? undefined : tx.getFee();
        const to: string[] = incoming ? [] : (tx.getOutgoingTransfer()?.getDestinations() ?? []).map((d: any) => d.getAddress()).filter(Boolean);
        const on: string | undefined = incoming ? tx.getIncomingTransfers()?.[0]?.getAddress() : undefined;
        return {
          hash: tx.getHash(), incoming, amount: toXmr(amount), confirmations: tx.getNumConfirmations() ?? 0, confirmed: Boolean(tx.getIsConfirmed()),
          // Still waiting for a block: when this wallet first saw it instead.
          time: tx.getBlock()?.getTimestamp() ?? tx.getReceivedTimestamp?.() ?? tx.getLastRelayedTimestamp?.() ?? 0,
          ...(fee != null && { fee: toXmr(fee) }), ...(tx.getHeight() && { height: tx.getHeight() }), ...(to.length && { to }), ...(on && { on }),
        };
      })
      .concat((s.snap.elsewhere ?? []).map((e) => ({ hash: e.hash, incoming: false, amount: e.amount, confirmations: Math.max(1, height - e.height), confirmed: true, time: e.time, height: e.height })))
      .filter((tx: Tx, i: number, all: Tx[]) => all.findIndex((t) => t.hash === tx.hash) === i)
      .sort((a: Tx, b: Tx) => (a.confirmed === b.confirmed ? b.time - a.time : a.confirmed ? 1 : -1))
      .slice(0, 30);
    await fillPool(s);
    s.snap = { ...s.snap, balance: toXmr(balance), unlocked: toXmr(unlocked), onTheWay: toXmr(balance > unlocked ? balance - unlocked : 0n), height, target, percent: target ? Math.min(1, height / target) : 0, txs };
    await saveSnap(s);
    if (Date.now() - s.saved > SAVE_EVERY_MS) await saveData(s);
  } catch (error) {
    console.warn('refresh skipped', error);
  } finally {
    s.refreshing = false;
  }
}

// --- Catching up ----------------------------------------------------------------------------------------------------------

// Hands matches to wallet2. Each real block goes in whole, along with some random blocks, so a server can't tell which
// transaction mattered. wallet2 ignores what isn't ours and keeps the truth. It refuses older-after-newer, so every block
// here sits above what it has already seen.
async function applyHits(s: Session, state: ScanState, tip: number, from: number) {
  const walletHeight: number = await s.wallet.getHeight();
  const real = new Set(state.hits.map((h) => h.height).filter((h) => h >= walletHeight && !dropForTest.has(h)));
  if (real.size) {
    const low = Math.max(from + 1, walletHeight);
    const decoys = new Set<number>();
    for (let i = 0; i < DECOY_BLOCKS && tip > low; i++) decoys.add(low + Math.floor(Math.random() * (tip - low)));
    const sorted = [...new Set([...real, ...decoys])].sort((a, b) => a - b);
    const lists: string[][] = [];
    // A decoy that can't be fetched just gets left out. A real one has to arrive.
    for (let i = 0; i < sorted.length; i += FETCH_AT_ONCE) {
      lists.push(...await Promise.all(sorted.slice(i, i + FETCH_AT_ONCE).map((h) => blockHashes(s.node, h).catch((error) => {
        if (real.has(h)) throw error;
        return [] as string[];
      }))));
    }
    await s.wallet.scanTxs(lists.flat());
  }
  state.hits = [];
}

async function goLive(s: Session) {
  s.syncing = true;
  await s.wallet.sync();
  s.syncing = false;
  if (session !== s) return;
  await refresh(s);
  await saveData(s);
  await rememberProgress(s);
  s.phase = 'live';
  s.times.live = Date.now();
  if (session === s) resumeSyncing(s);
}

// Background refreshes every 20 s once live. Building a payment has to wait for a refresh that's running, so they stop while
// Send is open (stopping cuts a running one short at once) and pick up again when you're back on Home. The first one waits a
// full period, because going live just did a refresh.
function resumeSyncing(s: Session, delay = SYNC_EVERY_MS) {
  clearTimeout(s.syncTimer);
  s.syncTimer = setTimeout(() => {
    if (session === s && s.phase === 'live' && !s.full?.running && !s.sendPaused) s.wallet.startSyncing(SYNC_EVERY_MS).catch(() => {});
  }, delay);
}
async function pauseSyncing(s: Session) {
  s.sendPaused = Date.now();
  clearTimeout(s.syncTimer);
  // Only the background loop: never cut short the catch-up itself or a full check.
  if (s.wallet && s.phase === 'live' && !s.syncing && !s.full?.running) await s.wallet.stopSyncing().catch(() => {});
}

async function rememberProgress(s: Session) {
  const scanner = await loadScanner(s.id);
  if (!scanner) return;
  const height: number = await s.wallet.getHeight();
  scanner.state.cursor = Math.max(scanner.state.cursor, height - 1);
  scanner.state.images = await imagePrefixes(s);
  await saveState(scanner.state, s.id);
}

interface ScanOutcome { scanner: { view: Uint8Array; table: Uint8Array; state: ScanState }; manifest: Manifest; from: number }

async function runScan(s: Session, scanner: ScanOutcome['scanner']): Promise<ScanOutcome> {
  s.times.scanStart = Date.now();
  const manifest = await readManifest();
  // The feed only reaches back so far. Anything older takes the normal route.
  if (scanner.state.cursor + 1 < manifest.from) throw new Error('This wallet is older than the feed');
  const from = scanner.state.cursor;
  const threads = allThreads();
  const stats = await advance(scanner, manifest, threads, (done, total, blocks) => { s.checked = { done, total, blocks }; });
  s.times.scanDone = Date.now();
  s.scan = { ...stats, hits: scanner.state.hits.length, threads };
  return { scanner, manifest, from };
}

// Once its keys are saved the scanner doesn't need the engine, so it starts at the same moment and they run side by side.
async function scanWithoutEngine(s: Session): Promise<ScanOutcome | null> {
  await backgroundOutOfTheWay();
  const scanner = await loadScanner(s.id);
  return scanner ? runScan(s, scanner) : null;
}

async function fastCatchUp(s: Session, early: Promise<ScanOutcome | null | { failed: unknown }>) {
  const first = await early;
  if (first && 'failed' in first) throw first.failed;
  // The very first time, the keys have to come from the engine.
  const { scanner, manifest, from } = first ?? await runScan(s, await prepareScanner(s));
  if (session !== s) return;

  s.phase = 'applying';
  s.spendCheck = { before: new Set(scanner.state.images), to: scanner.state.cursor, manifest };
  await applyHits(s, scanner.state, manifest.tip, from);
  s.times.applied = Date.now();
  await saveState(scanner.state, s.id);
  await refresh(s);
  s.times.balanceRight = Date.now();

  // Everything up to the cursor has been scanned and checked against the chain, so wallet2 only fetches block hashes that far.
  const skipTo = scanner.state.cursor;
  if (skipTo > await s.wallet.getHeight()) await s.wallet.setRestoreHeight(skipTo);
  s.phase = 'finishing';
}

async function boot(s: Session) {
  s.times.bootStart = Date.now();
  s.phase = 'checking';
  await prefsLoaded;
  // With fast open switched off in Settings, the wallet reads the chain the normal way.
  const early = prefs.fastOpen ? scanWithoutEngine(s).catch((failed) => ({ failed })) : Promise.resolve({ failed: new Error('Fast open is off') });
  const lib = await engine();
  for (;;) {
    try {
      s.node = await pickNode();
      if (s.phase === 'offline') s.phase = 'checking';
      break;
    } catch {
      s.phase = 'offline';
      await new Promise((r) => setTimeout(r, RETRY_OFFLINE_MS));
      if (session !== s) return;
    }
  }
  const stored = await kvGet(wk('data', s.id));
  const config = { networkType: netType(lib), password: s.secret.walletPassword, server: { uri: s.node }, proxyToWorker: true };
  // A saved wallet that can't be read (a password change cut short, say) is rebuilt from the words instead of failing.
  let opened = null;
  if (stored) {
    try {
      opened = await lib.openWalletFull({ ...config, keysData: await unseal(s.key, stored.keys), cacheData: await unseal(s.key, stored.cache) });
    } catch (error) {
      console.warn('saved wallet unreadable, rebuilding it from the words', error);
    }
  }
  s.firstOpen = !opened;
  const from = s.viewOnly ? { primaryAddress: s.secret.address, privateViewKey: s.secret.viewKey } : { seed: s.secret.seed };
  const wallet = opened ?? await lib.createWalletFull({ ...config, ...from, restoreHeight: s.secret.restoreHeight });
  if (session !== s) { await wallet.close().catch(() => {}); return; }
  s.wallet = wallet;
  rememberAddress(s).catch(() => {});
  if (prefs.customNodes.some((n) => n.url === s.node && n.trusted)) await wallet.setDaemonConnection(s.node, true).catch(() => {});
  s.secret = { ...s.secret, seed: '', mnemonic: '' };
  s.times.engineOpen = Date.now();

  await wallet.addListener(new (class extends lib.MoneroWalletListener {
    async onSyncProgress(height: number, _start: number, end: number, percent: number) {
      s.snap.height = height;
      s.snap.target = end;
      s.snap.percent = percent;
    }
  })());
  await fillPool(s);
  await saveSnap(s);
  s.markReady();

  try {
    await fastCatchUp(s, early);
  } catch (error) {
    console.warn('fast path unavailable, using a normal sync:', error);
    s.fellBack = String((error as any)?.message ?? error);
    s.feedRejected = error instanceof FeedRejected;
    if (session === s) s.phase = 'slow';
  }
  if (session !== s) return;
  try {
    await goLive(s);
  } catch (error) {
    s.syncing = false;
    console.warn('sync stopped', error);
  }
  if (session === s && s.spendCheck && (s.phase as Phase) === 'live' && !skipSpendCheckForTest) spendsOfNewCoins(s).catch((error) => console.warn('spend check skipped', error));
}

// The scan spots our coins being spent by their key images, but a coin that arrived while Walnero was closed had no key image
// yet. If the same wallet then spent it from another device and nothing came back here (sending everything), the scan
// couldn't see it, and the coin would stay on the balance. Now that wallet2 knows those coins, read the same stretch of feed
// for their key images: no maths, and the files are still in the browser's cache. A match is checked against the real block,
// whole, like every other lookup, and then the coin is frozen so it's off the balance and never picked for a payment.
async function spendsOfNewCoins(s: Session) {
  const check = s.spendCheck!;
  const fresh = new Map<number, { image: string; amount: bigint }[]>();
  let start = Infinity;
  for (const out of await s.wallet.getOutputs({ isSpent: false, isFrozen: false })) {
    const image: string | undefined = out.getKeyImage()?.getHex();
    const height: number | undefined = out.getTx()?.getHeight();
    if (!image || !height) continue;
    const prefix = new DataView(fromHex(image.slice(0, 8)).buffer).getUint32(0, true);
    if (check.before.has(prefix)) continue;
    fresh.set(prefix, [...(fresh.get(prefix) ?? []), { image, amount: out.getAmount() }]);
    start = Math.min(start, height);
  }
  check.result = { coins: fresh.size, leads: 0, found: 0 };
  if (!fresh.size || start > check.to) return;
  const leads = await findSpends(planChunks(start - 1, { ...check.manifest, tip: check.to }), new Set(fresh.keys()));
  check.result.leads = leads.length;
  for (const height of new Set(leads.map((l) => l.height))) {
    const block = await fetch(`${s.node}/json_rpc`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_block', params: { height } }), signal: AbortSignal.timeout(15000) }).then((r) => r.json());
    const hashes: string[] = block.result?.tx_hashes ?? [];
    for (let i = 0; i < hashes.length; i += 100) {
      const { txs = [] } = await fetch(`${s.node}/get_transactions`, { method: 'POST', body: JSON.stringify({ txs_hashes: hashes.slice(i, i + 100), decode_as_json: true, prune: true }), signal: AbortSignal.timeout(20000) }).then((r) => r.json());
      for (const tx of txs) {
        let spent = 0n;
        for (const input of JSON.parse(tx.as_json || '{}').vin ?? []) {
          const image: string | undefined = input.key?.k_image;
          if (!image) continue;
          const coin = fresh.get(new DataView(fromHex(image.slice(0, 8)).buffer).getUint32(0, true))?.find((c) => c.image === image);
          if (!coin || session !== s) continue;
          await s.wallet.freezeOutput(image);
          spent += coin.amount;
          check.result.found++;
        }
        if (spent > 0n) {
          s.snap.elsewhere = [...(s.snap.elsewhere ?? []).filter((e) => e.hash !== tx.tx_hash), { hash: tx.tx_hash, amount: toXmr(spent), height, time: block.result?.block_header?.timestamp ?? 0 }];
        }
      }
    }
  }
  if (check.result.found) { await saveData(s); await refresh(s); }
}

function begin(key: CryptoKey, secret: Secret, snap: Snapshot, id = activeId) {
  let markReady = () => {};
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const s: Session = { id, viewOnly: !secret.seed && Boolean(secret.viewKey), phrase: Boolean(secret.mnemonic), pendingReview: '', key, secret, wallet: null, node: '', pending: null, saved: Date.now(), syncing: false, refreshing: false, snap, phase: 'opening', checked: { blocks: 0, done: 0, total: 0 }, ready, markReady, times: {}, scan: null, fellBack: '', firstOpen: false, feedRejected: false, full: null, sendPaused: 0, btc: null, btcPending: null };
  session = s;
  if (secret.mnemonic && !s.viewOnly) startBtc(s, secret.mnemonic).catch((error) => console.warn('bitcoin not started', error));
  boot(s).catch((error) => {
    console.warn('boot failed', error);
    s.fellBack = String(error?.message ?? error);
    if (session === s) s.phase = 'failed';
  });
}

// What a wallet can be made from: its 25 words, or its keys like Cake Wallet's "Restore from keys". Address and view key give a
// view-only wallet. Adding the spend key gives the whole wallet, which is kept as its 25 words (the same key, written out).
interface Source { seed?: string; address?: string; viewKey?: string; spendKey?: string }
async function walletSource({ seed, address, viewKey, spendKey }: Source): Promise<{ from: SecretFrom; address: string; viewOnly: boolean }> {
  const lib = await engine();
  if (seed?.trim()) {
    const words = cleanPhrase(seed);
    const count = phraseWordCount(words);
    if (count === 12 || count === 24) {
      if (!isPhrase(words)) throw new Error("Those words don't check out. Look for a typo or a word in the wrong place.");
      return { ...(await fromPhrase(words)), viewOnly: false };
    }
    if (count !== 25) throw new Error(`That's ${count} words. Recovery words are 12 or 25 words.`);
    let keys;
    try { keys = await lib.createWalletKeys({ networkType: netType(lib), seed: words, proxyToWorker: true }); } catch { throw new Error("Those words aren't a valid Monero seed"); }
    try { return { from: { seed: words }, address: await keys.getPrimaryAddress(), viewOnly: false }; } finally { await keys.close().catch(() => {}); }
  }
  const addr = String(address ?? '').replace(/\s+/g, '');
  const view = String(viewKey ?? '').trim().toLowerCase();
  const spend = String(spendKey ?? '').trim().toLowerCase();
  if (!addr) throw new Error('Paste the wallet\'s address');
  if (!/^[0-9a-f]{64}$/.test(view)) throw new Error('A private view key is 64 letters and numbers (0-9, a-f)');
  if (spend && !/^[0-9a-f]{64}$/.test(spend)) throw new Error('A private spend key is 64 letters and numbers (0-9, a-f)');
  let keys;
  try {
    keys = await lib.createWalletKeys({ networkType: netType(lib), primaryAddress: addr, privateViewKey: view, ...(spend && { privateSpendKey: spend }), proxyToWorker: true });
  } catch (error: any) {
    const text = String(error?.message ?? error);
    if (/view key/i.test(text)) throw new Error("That view key doesn't belong to this address");
    if (/spend key/i.test(text)) throw new Error("That spend key doesn't belong to this address");
    if (/address/i.test(text)) throw new Error(`That isn't a valid ${NETWORK_WORDS} address. Use the wallet's main address, the one starting with ${MAINNET ? '4' : '5'}.`);
    throw new Error(text);
  }
  try {
    if (spend) return { from: { seed: await keys.getSeed() }, address: addr, viewOnly: false };
    return { from: { seed: '', address: addr, viewKey: view }, address: addr, viewOnly: true };
  } finally {
    await keys.close().catch(() => {});
  }
}

// A 12-word phrase and the Monero wallet that comes from it (the same one Cake Wallet and Exodus open from these words).
async function fromPhrase(phrase: string): Promise<{ from: SecretFrom; address: string }> {
  const lib = await engine();
  const keys = await lib.createWalletKeys({ networkType: netType(lib), privateSpendKey: moneroSpendKey(await rootKey(phrase)), proxyToWorker: true });
  try { return { from: { seed: await keys.getSeed(), mnemonic: cleanPhrase(phrase) }, address: await keys.getPrimaryAddress() }; } finally { await keys.close().catch(() => {}); }
}

async function storeNew(password: string, from: SecretFrom, restoreHeight: number) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  const secret: Secret = { ...from, restoreHeight, walletPassword: crypto.randomUUID() };
  const record: VaultRecord = { salt, iterations: PBKDF2_ITERATIONS, sealed: await sealJson(key, secret) };
  await kvSet('vault', record);
  begin(key, secret, { ...BLANK });
}

// The password's key, checked against the first wallet's vault (which stays as the password check even if that wallet is removed).
async function passwordKey(password: string): Promise<CryptoKey> {
  const record = await kvGet<VaultRecord>('vault');
  if (!record) throw new Error('No wallet here yet');
  const key = await deriveKey(password, record.salt, record.iterations);
  try { await unsealJson(key, record.sealed); } catch { throw new Error('Wrong password'); }
  return key;
}

// A wallet's words and start height, opened with the password key.
async function secretOf(key: CryptoKey, id: string): Promise<Secret> {
  if (id === 'main') {
    const record = await kvGet<VaultRecord>('vault');
    if (!record) throw new Error('No wallet here yet');
    const secret = await unsealJson<Secret>(key, record.sealed);
    if (!secret?.seed && !secret?.viewKey) throw new Error('That wallet was removed');
    return secret;
  }
  const stored = await kvGet<{ sealed: Sealed }>(wk('vault', id));
  if (!stored?.sealed) throw new Error('That wallet is no longer on this device');
  return unsealJson<Secret>(key, stored.sealed);
}

// The list shows each wallet's address, saved the first time the wallet opens.
async function rememberAddress(s: Session) {
  const address: string = await s.wallet.getPrimaryAddress();
  const registry = await readRegistry();
  const entry = registry.list.find((w) => w.id === s.id);
  if (entry && (entry.address !== address || Boolean(entry.viewOnly) !== s.viewOnly)) { entry.address = address; entry.viewOnly = s.viewOnly; await writeRegistry(registry); }
}

// Saves everything and closes the open wallet (Lock, and the first half of switching wallets).
async function closeSession(s: Session) {
  if (session === s) session = null;
  clearTimeout(s.syncTimer);
  await saveSnap(s).catch(() => {});
  if (s.wallet) {
    await s.wallet.stopSyncing().catch(() => {});
    await rememberProgress(s).catch(() => {});
    await saveData(s).catch(() => {});
    await s.wallet.close().catch(() => {});
  }
}

// While a switch is under way no wallet is open for a moment. Calls arriving then wait for it, instead of seeing "locked".
let switching: Promise<void> | null = null;

// Closes the open wallet and opens another with the same password key.
async function openWallet(s: Session, id: string, secret: Secret, registry: WalletRegistry) {
  if (s.full?.running) throw new Error('Wait for the full check to finish, then switch wallets.');
  let release = () => {};
  switching = new Promise<void>((resolve) => { release = resolve; });
  try {
    const key = s.key;
    await closeSession(s);
    activeId = id;
    await writeRegistry({ ...registry, active: id });
    const sealedSnap = await kvGet<Sealed>(wk('snap', id));
    begin(key, secret, sealedSnap ? await unsealJson<Snapshot>(key, sealedSnap).catch(() => ({ ...BLANK })) : { ...BLANK }, id);
  } finally {
    switching = null;
    release();
  }
}
const SWITCHERS = new Set(['addWallet', 'switchWallet', 'removeWallet']);

// --- Bitcoin ------------------------------------------------------------------------------------------------------------

const BTC_NET = btcNet(MAINNET);
const BTC_REFRESH_MS = 60 * 1000;
const BTC_SPEEDS = { slow: 'About an hour', normal: 'About 30 minutes', fast: 'About 10 minutes' } as const;

// Works out the account's public key from the words (a moment's work, off the unlock path), shows the last saved Bitcoin
// numbers straight away, then reads fresh ones.
async function startBtc(s: Session, phrase: string) {
  const xpub = accountKey(await rootKey(phrase), BTC_NET);
  if (session !== s) return;
  const saved = await kvGet<Sealed>(wk('btc', s.id));
  const state = saved ? await unsealJson<BtcState>(s.key, saved).catch(() => ({ ...BLANK_BTC })) : { ...BLANK_BTC };
  s.btc = { acct: new BtcAccount(xpub, BTC_NET), state, syncing: null, scanned: false, error: '' };
  await prefsLoaded;
  if (prefs.btc) await syncBitcoin(s);
}

// The first read of a session walks the addresses to the gap limit; later ones only look at what can have changed.
function syncBitcoin(s: Session): Promise<void> {
  const b = s.btc;
  if (!b) return Promise.resolve();
  b.syncing ??= (async () => {
    try {
      b.state = await syncBtc(b.acct, b.state, !b.scanned);
      b.scanned = true;
      b.error = '';
      if (session === s) await kvSet(wk('btc', s.id), await sealJson(s.key, b.state));
    } catch (error: any) {
      b.error = String(error?.message ?? error);
    } finally {
      b.syncing = null;
    }
  })();
  return b.syncing;
}

function requireBtc(s: Session) {
  if (s.viewOnly) throw new Error('View-only wallets show Monero only.');
  if (!s.phrase) throw new Error('Bitcoin comes with a 12-word wallet. This one has 25 Monero words, which hold only Monero.');
  if (!s.btc) throw new Error('Bitcoin is still starting. Try again in a moment.');
  return s.btc;
}

const requireSession = () => {
  if (!session) throw new Error('Walnero is locked');
  return session;
};

async function validAddress(address: string) {
  const lib = await engine();
  try {
    await lib.MoneroUtils.validateAddress(address, netType(lib));
  } catch {
    throw new Error(`That isn't a valid ${NETWORK_WORDS} address`);
  }
}

const SLOW_MESSAGE = 'Still catching up. Try again in a moment.';
// wallet2's fee levels (MoneroTxPriority): 0 automatic, 2 normal, 3 elevated.
const XMR_PRIORITY: Record<string, number> = { auto: 0, medium: 2, fast: 3 };
const VIEW_ONLY_MESSAGE = "This wallet is view-only. It sees payments coming in but can't send.";

// Names you've saved for addresses, like @kestrel. Kept on this device only, sealed with the password key like everything else.
interface SavedName { name: string; address: string; added: number; used: number }
const cleanName = (name: string) => String(name ?? '').trim().replace(/^@+/, '').toLowerCase();
async function readNames(s: Session): Promise<SavedName[]> {
  const sealed = await kvGet<Sealed>('names');
  if (!sealed) return [];
  try { return await unsealJson<SavedName[]>(s.key, sealed); } catch { return []; }
}
const writeNames = async (s: Session, list: SavedName[]) => kvSet('names', await sealJson(s.key, list));
const byRecent = (a: SavedName, b: SavedName) => (b.used || b.added) - (a.used || a.added);

const methods: Record<string, (params: any) => Promise<unknown>> = {
  async state() {
    return { exists: Boolean(await kvGet('vault')), unlocked: Boolean(session), network: NETWORK_NAME };
  },

  async create({ password }: { password: string }) {
    if (await kvGet('vault')) throw new Error('A wallet already exists');
    const node = await pickNode();
    const restoreHeight = Math.max(0, (await nodeHeight(node)) - 10);
    const phrase = newPhrase();
    await storeNew(password, (await fromPhrase(phrase)).from, restoreHeight);
    return { seed: phrase };
  },

  // From 25 words, or from keys (address and view key, plus the spend key unless it's meant to be view-only).
  async restore({ password, restoreHeight, ...source }: Source & { password: string; restoreHeight?: number }) {
    if (await kvGet('vault')) throw new Error('A wallet already exists');
    const { from } = await walletSource(source);
    await storeNew(password, from, Math.max(0, Math.floor(Number(restoreHeight) || 0)));
    return { ok: true };
  },

  // The password opens the saved balance, and that's all this waits for. The engine starts behind the screen.
  async unlock({ password }: { password: string }) {
    const key = await passwordKey(password);
    const registry = await readRegistry();
    let id = registry.list.some((w) => w.id === registry.active) ? registry.active : registry.list[0]!.id;
    let secret: Secret | null = await secretOf(key, id).catch(() => null);
    for (const w of registry.list) { if (secret) break; secret = await secretOf(key, w.id).catch(() => null); if (secret) id = w.id; }
    if (!secret) throw new Error('No wallet here yet');
    activeId = id;
    const sealedSnap = await kvGet<Sealed>(wk('snap', id));
    begin(key, secret, sealedSnap ? await unsealJson<Snapshot>(key, sealedSnap).catch(() => ({ ...BLANK })) : { ...BLANK }, id);
    return { ok: true };
  },

  async prefs() {
    await prefsLoaded;
    return prefs;
  },

  async setPrefs(change: Partial<Prefs>) {
    await prefsLoaded;
    const next = { ...prefs };
    if (AUTO_LOCK_CHOICES.includes(Number(change.autoLock))) next.autoLock = Number(change.autoLock);
    for (const key of ['fastOpen', 'hidden', 'timings', 'prices', 'btc'] as const) if (typeof change[key] === 'boolean') next[key] = change[key];
    const btcTurnedOn = next.btc && !prefs.btc;
    prefs = next;
    if (btcTurnedOn && session?.btc) syncBitcoin(session).catch(() => {});
    await kvSet('prefs', prefs);
    return prefs;
  },

  // --- Wallets, like Phantom's accounts ---
  async wallets() {
    if (session) await rememberAddress(session).catch(() => {});
    const registry = await readRegistry();
    return { active: session?.id ?? activeId, list: registry.list };
  },

  // A brand-new wallet (its 25 words come back to be written down), one restored from words, or one imported from keys. It
  // opens straight away.
  async addWallet({ label, mode, restoreHeight, ...source }: Source & { label?: string; mode: 'create' | 'restore' | 'keys'; restoreHeight?: number }) {
    const s = requireSession();
    let from: SecretFrom;
    let height: number;
    let address: string;
    let viewOnly = false;
    if (mode === 'create') {
      height = Math.max(0, (await nodeHeight(await pickNode())) - 10);
      ({ from, address } = await fromPhrase(newPhrase()));
    } else {
      ({ from, address, viewOnly } = await walletSource(mode === 'restore' ? { seed: String(source.seed ?? '') } : { address: source.address, viewKey: source.viewKey, spendKey: source.spendKey }));
      height = Math.max(0, Math.floor(Number(restoreHeight) || 0));
    }
    await rememberAddress(s).catch(() => {});
    const registry = await readRegistry();
    const same = registry.list.find((w) => w.address === address);
    if (same) throw new Error(`That wallet is already here, as ${same.label}`);
    const id = toHex(crypto.getRandomValues(new Uint8Array(4)));
    const secret: Secret = { ...from, restoreHeight: height, walletPassword: crypto.randomUUID() };
    await kvSet(wk('vault', id), { sealed: await sealJson(s.key, secret) });
    const name = String(label ?? '').trim().slice(0, 32) || `Wallet ${registry.list.length + 1}`;
    const next = { ...registry, list: [...registry.list, { id, label: name, address, created: Date.now(), ...(viewOnly && { viewOnly }) }] };
    await openWallet(s, id, secret, next);
    return mode === 'create' ? { id, seed: from.mnemonic } : { id, viewOnly };
  },

  async switchWallet({ id }: { id: string }) {
    const s = requireSession();
    if (id === s.id) return { ok: true };
    const registry = await readRegistry();
    if (!registry.list.some((w) => w.id === id)) throw new Error('That wallet is no longer on this device');
    await openWallet(s, id, await secretOf(s.key, id), registry);
    return { ok: true };
  },

  async renameWallet({ id, label }: { id: string; label: string }) {
    const name = String(label ?? '').trim().slice(0, 32);
    if (!name) throw new Error('Give it a name');
    const registry = await readRegistry();
    const entry = registry.list.find((w) => w.id === id);
    if (!entry) throw new Error('That wallet is no longer on this device');
    entry.label = name;
    await writeRegistry(registry);
    return { ok: true };
  },

  // Deletes a wallet from this device, only with the password. Its coins stay on the chain; its words or keys bring it back.
  async removeWallet({ id, password }: { id: string; password: string }) {
    const key = await passwordKey(password);
    const registry = await readRegistry();
    if (!registry.list.some((w) => w.id === id)) throw new Error('That wallet is no longer on this device');
    const rest = registry.list.filter((w) => w.id !== id);
    if (!rest.length) throw new Error('This is your only wallet. Add another one before removing it.');
    if (session && session.id === id) await openWallet(session, rest[0]!.id, await secretOf(key, rest[0]!.id), { ...registry, list: rest });
    else if (activeId === id) activeId = rest[0]!.id;
    for (const name of ['data', 'snap', 'scan-keys', 'scan-state', 'btc']) await kvSet(wk(name, id), null);
    if (id === 'main') {
      // The first vault stays as the password check, with the words in it replaced.
      const record = await kvGet<VaultRecord>('vault');
      if (record) await kvSet('vault', { ...record, sealed: await sealJson(key, { removed: true }) });
    } else {
      await kvSet(wk('vault', id), null);
    }
    await writeRegistry({ active: activeId, list: rest });
    return { ok: true };
  },

  // Like Phantom's Show Private Key: the address, private view key, private spend key and start block, only with the password.
  async walletKeys({ id, password }: { id?: string; password: string }) {
    const key = await passwordKey(password);
    const registry = await readRegistry();
    const entry = registry.list.find((w) => w.id === (id ?? session?.id ?? activeId));
    if (!entry) throw new Error('That wallet is no longer on this device');
    const secret = await secretOf(key, entry.id);
    if (!secret.seed) return { label: entry.label, address: secret.address, viewKey: secret.viewKey, spendKey: '', viewOnly: true, restoreHeight: secret.restoreHeight };
    const lib = await engine();
    const keys = await lib.createWalletKeys({ networkType: netType(lib), seed: secret.seed, proxyToWorker: true });
    try {
      return { label: entry.label, address: await keys.getPrimaryAddress(), viewKey: await keys.getPrivateViewKey(), spendKey: await keys.getPrivateSpendKey(), restoreHeight: secret.restoreHeight };
    } finally {
      await keys.close().catch(() => {});
    }
  },

  // --- Nodes, like Cake Wallet's Manage nodes ---
  async nodeList() {
    await prefsLoaded;
    return { mode: prefs.node, current: session?.node || null, builtin: NODES, custom: prefs.customNodes };
  },

  // Tests every node at once: answer time, height, or why it can't be used.
  async checkNodes() {
    await prefsLoaded;
    return Promise.all(allNodes().map(async (url) => {
      try { return { url, ok: true, ...(await askNode(url, 7000)) }; } catch (error: any) { return { url, ok: false, error: /abort|timed? ?out/i.test(String(error?.message)) ? "Didn't answer in time" : /fetch|load failed|network/i.test(String(error?.message)) ? "Couldn't reach it" : String(error?.message ?? error) }; }
    }));
  },

  async useNode({ url }: { url: string }) {
    await prefsLoaded;
    if (url !== 'auto' && !allNodes().includes(url)) throw new Error("That node isn't in your list");
    if (url !== 'auto') await askNode(url).catch((error) => { throw new Error(`${hostOf(url)} can't be used right now. ${error?.message ?? ''}`.trim()); });
    prefs = { ...prefs, node: url };
    await kvSet('prefs', prefs);
    const target = url === 'auto' ? await pickNode() : url;
    if (session) await switchNode(session, target);
    return { node: target };
  },

  async addNode({ url, label, trusted }: { url: string; label?: string; trusted?: boolean }) {
    await prefsLoaded;
    let clean: string;
    try { const u = new URL(url.trim()); if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new Error(); clean = `${u.protocol}//${u.host}`; } catch { throw new Error('That address doesn\'t look right. Try node.example.com and a port.'); }
    if (allNodes().includes(clean)) throw new Error('That node is already in your list');
    // A plain read isn't enough: the wallet also posts JSON to the node, which some nodes block for apps.
    const posts = async () => { const r = await fetch(`${clean}/json_rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_block_count' }), signal: AbortSignal.timeout(8000) }); if (!(await r.json())?.result?.count) throw new Error('bad answer'); };
    await askNode(clean, 8000).then(posts).catch((error) => {
      const text = String(error?.message ?? error);
      throw new Error(/abort|timed? ?out/i.test(text) ? `${hostOf(clean)} didn't answer in time. Check the address, port and SSL setting.` : /fetch|load failed|network/i.test(text) ? `Couldn't reach ${hostOf(clean)}. Check the address, port and SSL setting.` : text);
    });
    prefs = { ...prefs, node: clean, customNodes: [...prefs.customNodes, { url: clean, label: (label ?? '').trim().slice(0, 40) || hostOf(clean), trusted: Boolean(trusted) }] };
    await kvSet('prefs', prefs);
    if (session) await switchNode(session, clean);
    return { url: clean };
  },

  async removeNode({ url }: { url: string }) {
    await prefsLoaded;
    const wasChosen = prefs.node === url;
    prefs = { ...prefs, customNodes: prefs.customNodes.filter((n) => n.url !== url), node: wasChosen ? 'auto' : prefs.node };
    await kvSet('prefs', prefs);
    if (session && session.node === url) await switchNode(session, await pickNode());
    return { ok: true };
  },

  // How fast this open was, for Developer settings and the timings line on Home.
  async speed() {
    const s = requireSession();
    const t = s.times;
    const sec = (at?: number) => (at && t.bootStart ? Math.round((at - t.bootStart) / 100) / 10 : null);
    return { balance: sec(t.balanceRight), live: sec(t.live), fast: !s.fellBack, phase: s.phase };
  },

  // The 25 words, only with the password, straight from the encrypted vault.
  async revealSeed({ password, id }: { password: string; id?: string }) {
    const key = await passwordKey(password);
    const secret = await secretOf(key, id ?? session?.id ?? activeId);
    if (!secret.seed) throw new Error("This wallet is view-only, so it has no recovery words. Its address and view key are in Wallets, under Show private keys.");
    // A 12-word wallet also shows its 25 Monero words on request, for Monero-only apps like Feather or the official wallet.
    return secret.mnemonic ? { seed: secret.mnemonic, monero: secret.seed } : { seed: secret.seed };
  },

  // Everything sealed with the old password's key is sealed again with the new one. All of it is prepared first, the vault is
  // written last, and if any write fails the old copies go back, so a failure leaves the old password working.
  async changePassword({ current, next }: { current: string; next: string }) {
    const s = requireSession();
    if (typeof next !== 'string' || next.length < 8) throw new Error('Use at least 8 characters');
    const record = await kvGet<VaultRecord>('vault');
    if (!record) throw new Error('No wallet here yet');
    const oldKey = await deriveKey(current, record.salt, record.iterations);
    let secret: Secret;
    try { secret = await unsealJson<Secret>(oldKey, record.sealed); } catch { throw new Error('Your current password is wrong'); }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const newKey = await deriveKey(next, salt);
    const plan: { key: string; next: unknown; old: unknown }[] = [];
    const ids = (await readRegistry()).list.map((w) => w.id);
    if (!ids.includes('main')) ids.push('main'); // its data may linger until removed; re-sealing it is harmless
    for (const id of ids) {
      const data = await kvGet<{ keys: Sealed; cache: Sealed }>(wk('data', id));
      if (data) {
        try { plan.push({ key: wk('data', id), next: { keys: await seal(newKey, await unseal(oldKey, data.keys)), cache: await seal(newKey, await unseal(oldKey, data.cache)) }, old: data }); } catch { /* unreadable: leave it */ }
      }
      for (const name of ['snap', 'btc']) {
        const sealed = await kvGet<Sealed>(wk(name, id));
        if (sealed) { try { plan.push({ key: wk(name, id), next: await seal(newKey, await unseal(oldKey, sealed)), old: sealed }); } catch { /* unreadable */ } }
      }
      if (id !== 'main') {
        const vault = await kvGet<{ sealed: Sealed }>(wk('vault', id));
        if (vault?.sealed) plan.push({ key: wk('vault', id), next: { sealed: await seal(newKey, await unseal(oldKey, vault.sealed)) }, old: vault });
      }
    }
    const names = await kvGet<Sealed>('names');
    if (names) { try { plan.push({ key: 'names', next: await seal(newKey, await unseal(oldKey, names)), old: names }); } catch { /* unreadable */ } }
    const vault: VaultRecord = { salt, iterations: PBKDF2_ITERATIONS, sealed: await sealJson(newKey, secret) };
    // Saves from here on use the new key, so a refresh landing mid-change can't write an old-key copy over a new one.
    s.key = newKey;
    const written: typeof plan = [];
    try {
      for (const step of plan) { await kvSet(step.key, step.next); written.push(step); }
      await kvSet('vault', vault);
    } catch {
      s.key = oldKey;
      for (const step of written) await kvSet(step.key, step.old).catch(() => {});
      throw new Error("The password couldn't be changed. Your old password still works.");
    }
    return { ok: true };
  },

  // Confirms the password without opening anything, for turning on Face ID in Settings.
  async checkPassword({ password }: { password: string }) {
    await passwordKey(password);
    return { ok: true };
  },

  async lock() {
    if (session) await closeSession(session);
    return { ok: true };
  },

  async home() {
    const s = requireSession();
    if (s.sendPaused) { s.sendPaused = 0; resumeSyncing(s, 1500); }
    const { txs: _txs, pool: _pool, ...numbers } = s.snap;
    return { ...numbers, viewOnly: s.viewOnly, phrase: s.phrase, phase: s.phase, checked: s.checked, syncing: s.syncing, ready: Boolean(s.wallet), firstOpen: s.firstOpen, feedRejected: s.feedRejected, full: s.full, synced: s.phase === 'live' && s.snap.height >= s.snap.target - 1, node: s.node };
  },

  async activity() {
    return requireSession().snap.txs;
  },

  async receive() {
    const s = requireSession();
    let address = s.snap.pool.shift();
    if (!address) {
      if (s.phase === 'slow') throw new Error(SLOW_MESSAGE);
      if (s.phase === 'offline' || s.phase === 'failed') throw new Error("Can't make a new address right now. Try again when you're back online.");
      await s.ready;
      address = (await s.wallet.createSubaddress(0)).getAddress();
    }
    await saveSnap(s);
    return { address };
  },

  // Only a block by block sync ties up the engine for long. Otherwise this waits for the engine to open, a moment at most.
  // speed, like Cake Wallet's fee levels: auto (wallet2 picks the lowest fee that still makes the next block, raising it only
  // when blocks are full), medium and fast (the node's higher fee tiers; on stagenet in Nov 2026 they came to about 4 and 11
  // times the automatic fee), to jump a queue when there is one.
  async estimate({ address, amount, speed = 'auto' }: { address: string; amount: string; speed?: string }) {
    const s = requireSession();
    if (s.viewOnly) throw new Error(VIEW_ONLY_MESSAGE);
    if (s.phase === 'slow' || (s.firstOpen && s.phase !== 'live')) throw new Error(SLOW_MESSAGE);
    if (s.phase === 'offline') throw new Error("No connection right now. Try again when you're back online.");
    if (s.phase === 'failed') throw new Error('The wallet engine did not start. Lock Walnero and open it again.');
    await s.ready;
    if (!s.sendPaused) await pauseSyncing(s);
    await validAddress(address.trim());
    const atomic = fromXmr(amount);
    if (atomic <= 0n) throw new Error('Enter an amount above zero');
    try {
      s.pending = await s.wallet.createTx({ accountIndex: 0, address: address.trim(), amount: atomic, relay: false, priority: XMR_PRIORITY[speed] ?? 0 });
      s.pendingReview = crypto.randomUUID();
    } catch (error: any) {
      const text = String(error?.message ?? error);
      throw new Error(/not enough|unlocked/i.test(text) ? "You don't have enough unlocked XMR for that" : text);
    }
    return { fee: toXmr(s.pending.getFee()), amount: toXmr(atomic), review: s.pendingReview, speed: speed in XMR_PRIORITY ? speed : 'auto' };
  },

  async send({ review }: { review?: string }) {
    const s = requireSession();
    if (s.viewOnly) throw new Error(VIEW_ONLY_MESSAGE);
    if (!s.pending) throw new Error('Review the payment first');
    if (!review || review !== s.pendingReview) throw new Error('Another payment was reviewed since this one. Review this one again.');
    const hash = await s.wallet.relayTx(s.pending);
    s.pending = null;
    s.pendingReview = '';
    s.sendPaused = 0;
    resumeSyncing(s, 2000);
    refresh(s);
    return { hash };
  },

  // Send just opened: stop background refreshes now, so the payment can be built the moment it's asked for.
  async sendOpen() {
    const s = requireSession();
    await pauseSyncing(s);
    // The first address check loads the engine's address code on this page, which takes a moment. Do it while the amount is
    // being typed, on one of our own addresses: nothing leaves the device.
    if (s.snap.pool[0]) validAddress(s.snap.pool[0]).catch(() => {});
    return { ok: true };
  },

  async names() {
    return (await readNames(requireSession())).sort(byRecent);
  },

  async saveName({ name, address }: { name: string; address: string }) {
    const s = requireSession();
    const clean = cleanName(name);
    if (!/^[a-z0-9][a-z0-9_-]{0,19}$/.test(clean)) throw new Error('Use up to 20 letters or numbers for the name');
    await validAddress(address.trim());
    const list = await readNames(s);
    if (list.some((n) => n.name === clean)) throw new Error(`You already have @${clean}`);
    list.push({ name: clean, address: address.trim(), added: Date.now(), used: 0 });
    await writeNames(s, list);
    return { name: clean };
  },

  async removeName({ name }: { name: string }) {
    const s = requireSession();
    await writeNames(s, (await readNames(s)).filter((n) => n.name !== cleanName(name)));
    return { ok: true };
  },

  async usedName({ name }: { name: string }) {
    const s = requireSession();
    const list = await readNames(s);
    const hit = list.find((n) => n.name === cleanName(name));
    if (hit) { hit.used = Date.now(); await writeNames(s, list); }
    return { ok: true };
  },

  async primaryAddress() {
    const s = requireSession();
    await s.ready;
    return { address: await s.wallet.getPrimaryAddress() };
  },

  async addressFromSeed({ seed }: { seed: string }) {
    const lib = await engine();
    const wallet = await lib.createWalletKeys({ networkType: netType(lib), seed, proxyToWorker: true });
    const address = await wallet.getPrimaryAddress();
    await wallet.close();
    return { address };
  },

  // Reads every block since this wallet began, with no feed involved, so nothing can have been hidden from it. Runs behind the
  // screen, which shows the progress. Coins can't change: this only rebuilds what the wallet knows.
  async fullCheck() {
    const s = requireSession();
    await s.ready;
    if (s.full?.running) return { started: false };
    const before = s.snap.balance;
    s.full = { running: true, before, after: '', error: '' };
    s.phase = 'slow';
    s.snap = { ...s.snap, percent: 0 };
    (async () => {
      try {
        // This wipes what the wallet knows and rebuilds it. Forget the scan progress first, or a check cut short halfway would
        // leave the next open skipping everything it hadn't got back to yet.
        const scanner = await loadScanner(s.id);
        if (scanner) await saveState({ cursor: s.secret.restoreHeight - 1, hits: [], images: scanner.state.images }, s.id);
        await s.wallet.stopSyncing().catch(() => {});
        s.syncing = true;
        await s.wallet.setRestoreHeight(s.secret.restoreHeight);
        await s.wallet.rescanBlockchain();
        s.syncing = false;
        await refresh(s);
        await saveData(s);
        await rememberProgress(s);
        s.feedRejected = false;
        s.phase = 'live';
        s.full = { running: false, before, after: s.snap.balance, error: '' };
        s.times.fullCheckDone = Date.now();
        if (session === s) resumeSyncing(s);
      } catch (error: any) {
        s.syncing = false;
        s.full = { running: false, before, after: '', error: String(error?.message ?? error) };
      }
    })();
    return { started: true };
  },

  // Called while the wallet is closed, so a long gap never builds up. On Chrome's timer it stays quiet on two threads. When the
  // popup opens someone is about to need it, so it uses everything and is often done before the password is typed.
  async catchup({ eager }: { eager?: boolean } = {}) {
    if (session) return { skipped: 'open' };
    const threads = eager ? allThreads() : BACKGROUND_THREADS;
    if (backgroundScan) {
      if (!eager || backgroundThreads >= threads) return { skipped: 'already running' };
      backgroundScan.abort();
      await backgroundDone;
    }
    const scanner = await loadScanner();
    if (!scanner) return { skipped: 'no wallet' };
    const manifest = await readManifest();
    if (scanner.state.cursor + 1 < manifest.from) return { skipped: 'older than the feed' };
    if (session) return { skipped: 'open' };
    const controller = new AbortController();
    backgroundScan = controller;
    backgroundThreads = threads;
    const started = Date.now();
    const work = advance(scanner, manifest, threads, () => {}, controller.signal);
    backgroundDone = work.catch(() => {}).finally(() => { if (backgroundScan === controller) backgroundScan = null; });
    let stats;
    try {
      stats = await work;
    } catch (error) {
      // A feed that fails its check gets nothing recorded. The next unlock finds out the same way and takes the long route.
      if (error instanceof FeedRejected) return { rejected: error.message, cursor: scanner.state.cursor };
      throw error;
    }
    return { ...stats, cursor: scanner.state.cursor, hits: scanner.state.hits.length, seconds: (Date.now() - started) / 1000 };
  },

  // OpenAlias: the address behind a name like donate.getmonero.org, checked to be a valid address for this network.
  async resolveAlias({ name, coin = 'xmr' }: { name: string; coin?: AliasCoin }) {
    const alias = await resolveAlias(String(name ?? ''), coin === 'btc' ? 'btc' : 'xmr');
    try {
      if (coin === 'btc') checkAddress(BTC_NET, alias.address); else await validAddress(alias.address);
    } catch {
      throw new Error(`${alias.name} gives an address that isn't for ${coin === 'btc' ? BTC_NET.name : NETWORK_WORDS}`);
    }
    return alias;
  },

  // --- Bitcoin, from the same 12 words ---
  // available: whether this wallet can have Bitcoin at all (12 words, not view-only), and why not.
  async btc() {
    const s = requireSession();
    const available = s.phrase && !s.viewOnly;
    const b = s.btc;
    const txs = b ? btcHistory(b.acct, b.state).slice(0, 30).map((t) => ({
      hash: t.txid, incoming: t.incoming, amount: toBtc(t.amount), confirmations: t.confirmations, confirmed: t.confirmed, time: t.time,
      ...(t.fee != null && { fee: toBtc(t.fee) }), ...(t.height && { height: t.height }), ...(t.to?.length && { to: t.to }), ...(t.on && { on: t.on }), ...(t.self && { self: true }),
    })) : [];
    return {
      available, why: s.viewOnly ? 'viewonly' : !s.phrase ? 'words25' : '', ready: Boolean(b), network: MAINNET ? 'bitcoin' : 'testnet4', explorer: BTC_NET.explorer,
      balance: toBtc(b?.state.balance ?? 0), pending: toBtc(b?.state.pending ?? 0), txs, height: b?.state.height ?? 0,
      updated: b?.state.updated ?? 0, syncing: Boolean(b?.syncing), scanned: Boolean(b?.scanned), error: b?.error ?? '',
    };
  },

  async btcRefresh() {
    const s = requireSession();
    await syncBitcoin(s);
    return { ok: true };
  },

  async btcReceive() {
    const b = requireBtc(requireSession());
    return { address: receiveAddress(b.acct, b.state) };
  },

  // Rates for a payment to land in about an hour, half an hour, or the next block (sat/vB).
  async btcFees() {
    requireBtc(requireSession());
    const rates = await btcFees(BTC_NET);
    return (['slow', 'normal', 'fast'] as const).map((speed) => ({ speed, rate: rates[speed], time: BTC_SPEEDS[speed] }));
  },

  // Builds the payment (not signed yet) so the review can show the exact fee. amount: BTC as text, or 'all'.
  async btcEstimate({ address, amount, speed = 'normal' }: { address: string; amount: string; speed?: 'slow' | 'normal' | 'fast' }) {
    const s = requireSession();
    const b = requireBtc(s);
    s.btcPending = null;
    const sats = amount === 'all' ? 'all' : fromBtc(amount);
    if (sats !== 'all' && sats <= 0) throw new Error('Enter an amount above zero');
    if (!b.scanned) await syncBitcoin(s);
    const rate = (await btcFees(BTC_NET))[speed in BTC_SPEEDS ? speed : 'normal'];
    const plan = planPayment(b.acct, b.state, await spendable(b.acct, b.state), String(address ?? ''), sats, rate);
    const review = crypto.randomUUID();
    s.btcPending = { plan, review };
    return { amount: toBtc(plan.amount), fee: toBtc(plan.fee), rate, time: BTC_SPEEDS[speed in BTC_SPEEDS ? speed : 'normal'], to: plan.to, review };
  },

  // Signs the reviewed payment with keys opened from the vault for this moment only, and broadcasts it.
  async btcSend({ review }: { review?: string }) {
    const s = requireSession();
    requireBtc(s);
    const pending = s.btcPending;
    if (!pending) throw new Error('Review the payment first');
    if (!review || review !== pending.review) throw new Error('Another payment was reviewed since this one. Review this one again.');
    s.btcPending = null;
    const secret = await secretOf(s.key, s.id);
    if (!secret.mnemonic) throw new Error("This wallet's words can't sign Bitcoin");
    const { txid, raw } = signPayment(pending.plan, await rootKey(secret.mnemonic), BTC_NET);
    const sent = await broadcast(BTC_NET, raw);
    setTimeout(() => { if (session === s) syncBitcoin(s).catch(() => {}); }, 2500);
    return { hash: /^[0-9a-f]{64}$/.test(sent) ? sent : txid, amount: toBtc(pending.plan.amount), fee: toBtc(pending.plan.fee), to: pending.plan.to };
  },

  // Loads the engine before it's asked for. No keys involved: it makes a throwaway wallet and closes it.
  async warm() {
    const lib = await engine();
    const started = Date.now();
    const keys = await lib.createWalletKeys({ networkType: netType(lib), language: 'English', proxyToWorker: true });
    await keys.close();
    return { seconds: (Date.now() - started) / 1000 };
  },

};

// Test builds only (npm run build:test). A release build has none of this in it, and scripts/check-release.mjs checks that.
if (import.meta.env.MODE === 'test' || import.meta.env.MODE === 'mainnet-test') {
  Object.assign(methods, {
  // Test only, removed before public release: puts a saved wallet in place exactly as it was left.
  async testImport({ seed, password, restoreHeight, walletPassword, base, savedAt }: { seed: string; password: string; restoreHeight: number; walletPassword: string; base: string; savedAt?: number }) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt);
    const record: VaultRecord = { salt, iterations: PBKDF2_ITERATIONS, sealed: await sealJson(key, { seed, restoreHeight, walletPassword } satisfies Secret) };
    const read = async (name: string) => new Uint8Array(await (await fetch(`${base}/${name}`)).arrayBuffer());
    await kvSet('data', { keys: await seal(key, await read('month-old-keys.bin')), cache: await seal(key, await read('month-old-cache.bin')) });
    await kvSet('vault', record);
    if (savedAt) {
      const lib = await engine();
      const keys = await lib.createWalletKeys({ networkType: netType(lib), seed, proxyToWorker: true });
      const view = fromHex(await keys.getPrivateViewKey());
      const table = await makeTable(view, fromHex(await keys.getPublicSpendKey()));
      await keys.close();
      const bytes = new Uint8Array(32 + table.length) as Uint8Array<ArrayBuffer>;
      bytes.set(view);
      bytes.set(table, 32);
      await kvSet('scan-keys', await seal(await deviceKey(), bytes));
      await saveState({ cursor: savedAt - 1, hits: [], images: [] });
    }
    return { ok: true };
  },

  // Test only, removed before public release: points the wallet at other servers, to prove what happens when they're down.
  async testNodes({ nodes }: { nodes: string[] }) {
    NODES = nodes;
    return { ok: true };
  },

  // Test only, removed before public release: points the wallet at another feed.
  async testFeed({ url }: { url: string }) {
    setFeedForTest(url);
    return { ok: true };
  },

  // Test only: makes the scan miss these blocks, the way it misses a spend that sent nothing back to this wallet.
  async testDropHits({ heights, check = true }: { heights: number[]; check?: boolean }) {
    dropForTest = new Set(heights);
    skipSpendCheckForTest = !check;
    return { ok: true };
  },

  async timing() {
    const s = session;
    return s ? { times: s.times, phase: s.phase, scan: s.scan, checked: s.checked, fellBack: s.fellBack, feedRejected: s.feedRejected, full: s.full, spendCheck: s.spendCheck?.result ?? null } : null;
  },
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // A script injected into a web page carries our extension id too, and a hacked tab could use it. Only our own pages get through.
  if (message?.target !== 'wallet' || sender.id !== chrome.runtime.id || !(sender.url ?? '').startsWith(chrome.runtime.getURL(''))) return false;
  const run = methods[message.method];
  if (!run) { sendResponse({ ok: false, error: `Unknown method ${message.method}` }); return false; }
  if (message.method !== 'catchup' && message.method !== 'warm') lastActive = Date.now();
  const waitForSwitch = switching && !SWITCHERS.has(message.method) ? switching : Promise.resolve();
  waitForSwitch.then(() => run(message.params ?? {})).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }),
  );
  return true;
});

setInterval(() => { if (session) refresh(session); }, REFRESH_EVERY_MS);
setInterval(() => { if (session?.btc && prefs.btc) syncBitcoin(session).catch(() => {}); }, BTC_REFRESH_MS);
// Screens poll while the popup is open, so no calls for 15 minutes means nobody is looking: lock.
setInterval(() => { if (session && !session.full?.running && Date.now() - lastActive > prefs.autoLock * 60 * 1000) methods.lock({}); }, 30 * 1000);

chrome.runtime.sendMessage({ target: 'host', event: 'wallet-ready' }).catch(() => {});
