import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { AreaSeries, ColorType, createChart, CrosshairMode, LineStyle, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { call, type FirstView } from '@/wallet/client';
import { MAINNET, NETWORK, NETWORK_NAME, NETWORK_WORDS } from '@/wallet/network';
import { looksLikeAlias, type Alias } from '@/wallet/openalias';
import { chart as loadChart, lastMarket, market as loadMarket, type Coin, type Market, type Point, type Range } from '@/wallet/price';

type View = 'loading' | 'welcome' | 'create' | 'seed' | 'restore' | 'locked' | 'faceid' | 'home' | 'activity' | 'names' | 'settings' | 'receive' | 'send' | 'sent' | 'swap' | 'token' | 'tx' | 'manage' | 'btc' | 'btcreceive' | 'btcsend';
interface SavedName { name: string; address: string }
interface SentInfo { hash: string; amount: string; fee: string; to: string; coin?: 'xmr' | 'btc'; time?: string }
interface Tx { hash: string; incoming: boolean; amount: string; confirmations: number; confirmed: boolean; time: number; fee?: string; height?: number; to?: string[]; on?: string; self?: boolean; coin?: 'xmr' | 'btc' }
interface WalletInfo { id: string; label: string; address: string; created: number; viewOnly?: boolean }
interface WalletList { active: string; list: WalletInfo[] }
interface KeyInfo { label: string; address: string; viewKey: string; spendKey: string; restoreHeight: number; viewOnly?: boolean }
// XMRScan only covers real Monero, so the test network uses xmrchain's stagenet explorer. Opening either tells that site
// which transaction you looked up, which the transaction screen says next to the link.
const explorerUrl = (hash: string) => (MAINNET ? `https://xmrscan.org/tx/${hash}` : `https://stagenet.xmrchain.net/tx/${hash}`);
const icon = (name: string) => <i className="ic" style={{ ['--u' as string]: `url(/icons/${name}.svg)` }} />;
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const signedUsd = (n: number) => `${n < 0 ? '-' : '+'}${usd(Math.abs(n))}`;
const pct = (n: number) => `${n < 0 ? '' : '+'}${n.toFixed(2)}%`;
const compactUsd = (n: number) => `$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n)}`;
const when = (seconds: number) => new Date(seconds * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
// The whole amount on the transaction screen: every digit that isn't a trailing zero, at least four.
const exact = (xmr: string) => { const [w, f = ''] = xmr.split('.'); return `${w}.${f.replace(/0+$/, '').padEnd(4, '0')}`; };
// Monero counts a payment settled at 10 blocks, Bitcoin at 3 (each Bitcoin block takes about 10 minutes).
const needed = (t: Tx) => (t.coin === 'btc' ? 3 : 10);
const txStatus = (t: Tx) => (!t.confirmed ? 'Waiting for a block' : t.confirmations >= needed(t) ? 'Confirmed' : `${t.confirmations} of ${needed(t)} checks`);

const trim4 = (xmr: string) => { const [w, f = ''] = xmr.split('.'); return `${w}.${f.padEnd(4, '0').slice(0, 4)}`; };
const isZero = (xmr: string) => /^0(\.0*)?$/.test(xmr);
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// The tokens. Monero is the wallet's own coin. Bitcoin comes from the same 12 words (wallet/btc.ts), so only 12-word wallets
// have it. Amounts: Monero shows four decimals, Bitcoin every digit that matters (a few cents can be 0.00000100 BTC).
interface CoinInfo { key: Coin; name: string; ticker: string; logo: string; network: string; about: string; maxSupply: string; explorer: (hash: string) => string; explorerName: string; testNote: string; amount: (n: string) => string; settle: string }
const XMR_COIN: CoinInfo = {
  key: 'monero', name: 'Monero', ticker: 'XMR', logo: '/coins/xmr.png', network: MAINNET ? 'Monero' : 'Monero test network', maxSupply: 'No hard cap',
  about: 'Monero is private digital cash. Who paid whom, and how much, stays hidden on its blockchain, so every coin is worth the same as any other.',
  explorer: (hash) => explorerUrl(hash), explorerName: MAINNET ? 'XMRScan' : 'the test explorer', testNote: "Real Monero's price. Test coins have no value.", amount: (n) => trim4(n), settle: 'about 2 minutes',
};
const BTC_COIN: CoinInfo = {
  key: 'bitcoin', name: 'Bitcoin', ticker: 'BTC', logo: '/coins/btc.png', network: MAINNET ? 'Bitcoin' : 'Bitcoin testnet4', maxSupply: '21M BTC',
  about: 'Bitcoin is the first cryptocurrency and the biggest. Unlike Monero, its payments and balances are public: anyone who knows an address can follow the money.',
  explorer: (hash) => `https://mempool.space/${MAINNET ? '' : 'testnet4/'}tx/${hash}`, explorerName: 'mempool.space', testNote: "Real Bitcoin's price. Test coins have no value.", amount: (n) => btcAmount(n), settle: 'about 30 minutes',
};
const coinOf = (t: { coin?: 'xmr' | 'btc' }) => (t.coin === 'btc' ? BTC_COIN : XMR_COIN);
// Every digit that isn't a trailing zero, at least two.
const btcAmount = (btc: string) => { const [w, f = ''] = btc.split('.'); const kept = f.replace(/0+$/, ''); return `${w}.${kept.padEnd(2, '0')}`; };
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// The iPhone app build (vite.app.config.ts). There the keypad replaces the system keyboard, and pasting gets its own button.
const PHONE = Boolean(import.meta.env.VITE_PHONE);

// Face ID, in the iPhone app only. The password sits in the iOS Keychain behind Face ID (ios/Walnero/Secure.swift). iOS gives
// Face ID two tries, then its sheet offers "Use Password" and the lock screen falls back to typing.
interface Bio { available: boolean; kind: string; enabled: boolean; asked: boolean }
const secure: { postMessage(body: unknown): Promise<any> } | undefined = PHONE ? (globalThis as any).webkit?.messageHandlers?.secure : undefined;
// Each network's wallet has its own password, so each has its own saved copy (the slot).
const bio = {
  status: async (): Promise<Bio | null> => (secure ? secure.postMessage({ op: 'status', slot: NETWORK_NAME }) : null),
  enable: async (password: string): Promise<{ ok: boolean; error?: string }> => secure!.postMessage({ op: 'enable', password, slot: NETWORK_NAME }),
  unlock: async (): Promise<{ password?: string; error?: string }> => secure!.postMessage({ op: 'unlock', slot: NETWORK_NAME }),
  disable: async () => { await secure?.postMessage({ op: 'disable', slot: NETWORK_NAME }); },
  asked: async () => { await secure?.postMessage({ op: 'asked', slot: NETWORK_NAME }); },
};

// The iPhone app's own side (ios/Walnero/AppBridge.swift): switching networks, and free test coins.
const appBridge: { postMessage(body: unknown): Promise<any> } | undefined = PHONE ? (globalThis as any).webkit?.messageHandlers?.app : undefined;
const switchNet = (net: 'mainnet' | 'stagenet') => appBridge?.postMessage({ op: 'setNet', net });
const APP_VERSION = (import.meta.env.VITE_VERSION as string) || '0.8.0';
interface Prefs { autoLock: number; fastOpen: boolean; hidden: boolean; timings: boolean; prices: boolean; btc: boolean }
const DEFAULT_PREFS: Prefs = { autoLock: 15, fastOpen: true, hidden: false, timings: false, prices: true, btc: true };
const STARS = '*****';
// "balance 1.3 s, up to date 3.5 s". A brand-new wallet has nothing to catch up, so it only has the second number.
const speedText = (sp: any) => [sp.balance != null && `balance ${sp.balance} s`, sp.live != null ? `up to date ${sp.live} s` : 'still opening', sp.fast === false && sp.balance != null && 'normal sync'].filter(Boolean).join(', ');
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TONES = ['#202020', '#1B1B1B', '#171717', '#131313', '#101010', '#0D0D0D'];
// Where the lock screen's W was when you unlocked, so it can travel up into Home's header.
let flyFrom: DOMRect | null = null;

// Digits sit on reels. On the first Home of each open they start at zero and roll into place, one column after another.
function Reels({ value, rollIn = false }: { value: string; rollIn?: boolean }) {
  const [ready, setReady] = useState(!rollIn);
  useEffect(() => {
    if (ready) return;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setReady(true)); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [ready]);
  const [whole, cents] = value.split('.');
  let n = 0;
  const col = (c: string, key: string) => {
    if (!/\d/.test(c)) return <span key={key}>{c}</span>;
    const at = n++;
    return <span className="d" key={key}><i>{c}</i><span className="reel" style={{ transform: `translateY(${-(ready ? Number(c) : 0) * 66}px)`, transitionDelay: rollIn ? `${at * 40}ms` : undefined }}>{'0123456789'.split('').map((d) => <span key={d}>{d}</span>)}</span></span>;
  };
  return <>{whole.split('').map((c, i) => col(c, `w${whole.length - i}`))}<span className="cents"><span>.</span>{cents.split('').map((c, i) => col(c, `c${i}`))}</span></>;
}

function Slide({ onDone, label }: { onDone: () => void; label: string }) {
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(86);
  const drag = useRef<number | null>(null);
  const move = (e: ReactPointerEvent) => {
    if (drag.current === null || !track.current) return;
    const max = track.current.clientWidth;
    const next = Math.min(max, Math.max(86, 86 + e.clientX - drag.current));
    setWidth(next);
    if (next >= max * 0.94) { drag.current = null; setWidth(max); onDone(); }
  };
  return (
    <div className="slide" ref={track} data-testid="slide" onPointerMove={move} onPointerUp={() => { if (drag.current !== null) { drag.current = null; setWidth(86); } }}>
      <div className="tip" style={{ opacity: 1 - (width - 86) / 200 }}>{label}</div>
      <div className="fill" style={{ transform: `translateX(calc(${width}px - 100%))`, transition: drag.current === null ? 'transform .3s' : 'none' }} onPointerDown={(e) => { drag.current = e.clientX; e.currentTarget.setPointerCapture(e.pointerId); }}>{icon('arrow-right')}</div>
    </div>
  );
}

const Fold = ({ items, cols }: { items: { label: string; onClick?: () => void; hit?: boolean; disabled?: boolean; id?: string }[]; cols: string }) => (
  <div className="fold" style={{ gridTemplateColumns: cols }}>
    {items.map((b, k) => <button key={b.label} data-testid={b.id} className={`sk ${b.hit ? 'hit' : ''}`} style={{ ['--k' as string]: k }} disabled={b.disabled} onClick={b.onClick}><span>{b.label}</span></button>)}
  </div>
);

// The header and the tab bar live outside App so they aren't rebuilt on every refresh, which would restart their motion.
const GoContext = createContext<(v: View, tone?: 'mid' | 'black') => void>(() => {});
function Head({ title = MAINNET ? 'Main wallet' : 'Test wallet', back, onBack }: { title?: string; back?: View; onBack?: () => void }) {
  const go = useContext(GoContext);
  return (
    <div className="head">
      {back || onBack
        ? <button data-testid="back" className="back" aria-label="Back" onClick={() => (onBack ? onBack() : go(back!))}>{icon('caret-left')}</button>
        : <img src="/brand/w-sky.png" alt="" />}
      <span>{title}</span>
    </div>
  );
}
const TABS = [['home', 'wallet', 'Wallet'], ['activity', 'clock-counter-clockwise', 'Activity'], ['names', 'at', 'Names'], ['settings', 'gear-six', 'Settings']] as const;
function Nav({ view, onPick, dot }: { view: View; onPick: (v: View) => void; dot: boolean }) {
  return (
    <nav>
      {TABS.map(([v, i, l]) => (
        <button key={v} data-testid={`tab-${v}`} className={view === v ? 'on' : ''} onClick={() => onPick(v)}>
          {icon(i)}{l}{v === 'activity' && dot && <i className="dot" data-testid="activity-dot" />}
        </button>
      ))}
    </nav>
  );
}

// Plain words for where the wallet is. The saved balance is on screen for all of these.
function syncLabel(home: any): string {
  if (!home) return 'Opening';
  if (home.full?.running) return home.percent > 0 ? `Full check ${Math.floor(home.percent * 100)}%` : 'Full check starting';
  if (home.synced) return 'Up to date';
  switch (home.phase) {
    case 'checking': {
      const days = Math.max(1, Math.round((home.checked?.blocks ?? 0) / 720));
      return home.checked?.total ? `Checking ${days === 1 ? 'for new payments' : `${days} days`}` : 'Checking';
    }
    case 'applying': case 'finishing': return home.firstOpen ? 'Setting up' : 'Almost there';
    case 'slow': return `Catching up ${Math.floor(home.percent * 100)}%`;
    case 'offline': return 'Offline';
    case 'failed': return "Couldn't open";
    default: return 'Checking';
  }
}
function syncShare(home: any): number {
  if (home.synced) return 1;
  if (home.phase === 'slow') return home.percent;
  if (home.phase === 'checking' && home.checked?.total) return (home.checked.done / home.checked.total) * 0.9;
  return home.phase === 'applying' || home.phase === 'finishing' ? 0.95 : 0;
}

export default function App({ first }: { first: FirstView }) {
  const pay = first.pay;
  const [view, setView] = useState<View>(first.view === 'home' && pay ? 'send' : first.view);
  const [wiping, setWiping] = useState<{ n: number; tone: 'mid' | 'black' } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [seed, setSeed] = useState('');
  const [sent, setSent] = useState<SentInfo | null>(null);
  const [sendTo, setSendTo] = useState('');
  const [pulse, setPulse] = useState(false);
  const [enterHome, setEnterHome] = useState(true);
  // The name of the wallet that's open, for Home's header.
  const [walletLabel, setWalletLabel] = useState('');
  const loadLabel = useCallback(() => call<WalletList>('wallets').then((r) => setWalletLabel(r.list.find((w) => w.id === r.active)?.label ?? '')).catch(() => {}), []);
  useEffect(() => { if (view === 'home' || view === 'settings') loadLabel(); }, [view, loadLabel]);
  // A wallet was switched or added: the engine has already changed wallets, so drop the old wallet's data and start Home again.
  const onSwitched = () => { setHome(null); setTxs(null); setBtc(null); setEnterHome(true); loadLabel(); go('home'); };
  const [home, setHome] = useState<any>(first.home);
  const [txs, setTxs] = useState<any[] | null>(first.txs);
  const seen = useRef<Set<string> | null>(null);
  const [bioState, setBio] = useState<Bio | null>(null);
  const [bioReady, setBioReady] = useState(!secure);
  const [prefs, setPrefsState] = useState<Prefs>({ ...DEFAULT_PREFS, ...(first.prefs ?? {}) });
  const updatePrefs = (change: Partial<Prefs>) => { setPrefsState((was) => ({ ...was, ...change })); call('setPrefs', change).catch(() => {}); };
  const [speed, setSpeed] = useState<any>(null);
  const [faucet, setFaucet] = useState({ busy: false, message: '' });
  // The transaction open on its own screen, and where Back goes. The copy kept here covers it dropping off the list.
  const [txOpen, setTxOpen] = useState<{ tx: Tx; from: View } | null>(null);
  const openTx = (tx: Tx, from: View) => { setTxOpen({ tx, from }); setView('tx'); };
  // Bitcoin, from the same 12 words (null until the engine answers; available is false on 25-word and view-only wallets).
  const [btc, setBtc] = useState<any>(null);
  // Monero's price. Starts from the last one this device saw, so Home shows a value straight away.
  const [mkt, setMkt] = useState<Market | null>(() => lastMarket());
  const [mktFailed, setMktFailed] = useState(false);
  useEffect(() => {
    if (!prefs.prices || !(view === 'token' || (MAINNET && ['home', 'tx'].includes(view)))) return;
    let live = true;
    let timer = 0;
    // Every 90 seconds, or 15 after a miss (the free price service turns away bursts for a moment).
    const load = () => loadMarket()
      .then((m) => { if (!live) return; setMkt(m); setMktFailed(false); timer = window.setTimeout(load, 90_000); })
      .catch(() => { if (!live) return; setMktFailed(true); timer = window.setTimeout(load, 15_000); });
    load();
    return () => { live = false; clearTimeout(timer); };
  }, [view, prefs.prices]);
  const showValue = MAINNET && prefs.prices && mkt != null;
  // Bitcoin's price, the same way.
  const [bmkt, setBmkt] = useState<Market | null>(() => lastMarket('bitcoin'));
  const [bmktFailed, setBmktFailed] = useState(false);
  useEffect(() => {
    if (!prefs.prices || !prefs.btc || !(view === 'btc' || (MAINNET && ['home', 'tx', 'btcsend'].includes(view)))) return;
    let live = true;
    let timer = 0;
    const load = () => loadMarket('bitcoin')
      .then((m) => { if (!live) return; setBmkt(m); setBmktFailed(false); timer = window.setTimeout(load, 90_000); })
      .catch(() => { if (!live) return; setBmktFailed(true); timer = window.setTimeout(load, 15_000); });
    load();
    return () => { live = false; clearTimeout(timer); };
  }, [view, prefs.prices, prefs.btc]);
  const showBtcValue = MAINNET && prefs.prices && bmkt != null && Boolean(btc?.available);
  useEffect(() => {
    if (!prefs.btc || !['home', 'activity', 'btc', 'tx', 'btcreceive'].includes(view)) return;
    let live = true;
    const tick = () => call('btc').then((b) => { if (live) setBtc(b); }).catch(() => {});
    tick();
    const timer = setInterval(tick, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [view, prefs.btc]);
  useEffect(() => { document.body.classList.toggle('testmode', PHONE && !MAINNET); }, []);
  // Free test coins straight into a fresh address of this wallet (test network only).
  const claimFaucet = async () => {
    setFaucet({ busy: true, message: '' });
    try {
      const { address } = await call('receive');
      const r = await appBridge!.postMessage({ op: 'faucet', address });
      setFaucet({ busy: false, message: r?.ok ? `On its way: ${Number(r.amount ?? 0.01)} test XMR. It shows up in a minute or two.` : r?.message ?? "The faucet didn't answer." });
    } catch (e: any) {
      setFaucet({ busy: false, message: String(e?.message ?? e) });
    }
  };
  // The password just typed, held only until the Face ID offer is answered.
  const typedPassword = useRef('');
  useEffect(() => { bio.status().then(setBio).catch(() => {}).finally(() => setBioReady(true)); }, []);
  const offerBio = () => Boolean(bioState?.available && !bioState.enabled && !bioState.asked);

  const go = useCallback((next: View, tone: 'mid' | 'black' = 'mid') => {
    setError('');
    if (reduced()) { setView(next); return; }
    setWiping((w) => ({ n: (w?.n ?? 0) + 1, tone }));
    setTimeout(() => setView(next), 340);
  }, []);

  // The first Home of each open plays the opening, then stays still for tab switches.
  useEffect(() => {
    if (view !== 'home' || !enterHome) return;
    const t = setTimeout(() => setEnterHome(false), 1700);
    return () => clearTimeout(t);
  }, [view, enterHome]);

  // After unlocking, the lock screen's W travels up into the header.
  useLayoutEffect(() => {
    if (view !== 'home') return;
    const w = document.querySelector<HTMLImageElement>('.screen > .head img');
    if (flyFrom && w && !reduced()) {
      const to = w.getBoundingClientRect();
      w.animate([{ transform: `translate(${flyFrom.left - to.left}px, ${flyFrom.top - to.top}px) scale(${flyFrom.width / to.width})` }, { transform: 'none' }], { duration: 640, easing: 'cubic-bezier(.65, 0, .35, 1)' });
    }
    flyFrom = null;
  }, [view]);

  // Activity gets a dot when a payment shows up that you haven't looked at since this popup opened.
  useEffect(() => {
    if (!txs) return;
    if (!seen.current) seen.current = new Set(txs.map((t) => t.hash));
    if (view === 'activity') txs.forEach((t) => seen.current!.add(t.hash));
  }, [txs, view]);
  const dot = Boolean(txs && seen.current && view !== 'activity' && txs.some((t) => !seen.current!.has(t.hash)));

  useEffect(() => {
    if (!pulse || view !== 'home') return;
    const t = setTimeout(() => setPulse(false), 2200);
    return () => clearTimeout(t);
  }, [pulse, view]);

  const attempt = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (e: any) { setError(String(e?.message ?? e)); } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!['home', 'activity', 'names', 'settings', 'token', 'tx', 'manage', 'btc'].includes(view)) return;
    let live = true;
    const tick = async () => {
      try {
        const [h, a] = await Promise.all([call('home'), call('activity')]);
        if (live) { setHome(h); setTxs(a); }
        if (live && prefs.timings && view === 'home') setSpeed(await call('speed'));
      } catch (e: any) { if (live && /locked/i.test(e.message)) setView('locked'); }
    };
    tick();
    const timer = setInterval(tick, 2500);
    return () => { live = false; clearInterval(timer); };
  }, [view, prefs.timings]);

  const nav = <Nav view={view} dot={dot} onPick={(v) => { setError(''); setView(v); }} />;

  const finishUnlock = async (password: string, typed: boolean) => {
    await call('unlock', { password });
    const [h, a] = await Promise.all([call('home'), call('activity')]);
    setHome(h); setTxs(a); setError('');
    if (typed && !pay && offerBio()) { typedPassword.current = password; go('faceid'); return; }
    flyFrom = pay ? null : document.querySelector('.lock-w')?.getBoundingClientRect() ?? null;
    setView(pay ? 'send' : 'home');
  };
  const unlockWithBio = async (): Promise<boolean> => {
    const kind = bioState?.kind ?? 'Face ID';
    const r = await bio.unlock().catch(() => ({ error: 'failed' }) as { password?: string; error?: string });
    if (r.password) {
      setBusy(true);
      try { await finishUnlock(r.password, false); return true; } catch (e: any) { setError(String(e?.message ?? e)); return false; } finally { setBusy(false); }
    }
    if (r.error === 'changed') { setError(`${kind} changed on this phone. Use your password, then turn it back on in Settings.`); setBio(await bio.status()); }
    else if (r.error === 'lockout') setError(`${kind} is locked for now. Use your password.`);
    else if (r.error === 'failed') setError(`${kind} didn't recognize you. Use your password.`);
    return false;
  };

  return (
    <GoContext.Provider value={go}>
      {!MAINNET && !PHONE && <div className="testnet">Test network</div>}
      {PHONE && !MAINNET && <div className="netbanner" data-testid="test-banner"><span>Test network. These coins have no value.</span><button onClick={() => switchNet('mainnet')}>Switch back</button></div>}
      {view === 'loading' && <div className="screen"><div className="center" style={{ alignItems: 'center' }}><img className="big-w" src="/brand/w-sky.png" alt="Walnero" /></div></div>}

      {view === 'welcome' && (
        <div className="screen">
          <div className="center fade-in"><img src="/brand/w-sky.png" alt="" style={{ width: 92, height: 'auto', marginBottom: 22 }} /><div className="title">Monero<br />in seconds.</div><div className="lede">A wallet that opens fast and looks after your keys on this device only.</div>{error && <div className="error">{error}</div>}</div>
          <div style={{ display: 'grid', gap: 9, paddingBottom: 26 }}>
            <Fold cols="1fr" items={[{ label: 'Create a wallet', hit: true, id: 'create', onClick: () => go('create') }]} />
            <Fold cols="1fr" items={[{ label: 'I already have one', id: 'restore', onClick: () => go('restore') }]} />
          </div>
        </div>
      )}

      {view === 'create' && <PasswordScreen busy={busy} error={error} Head={Head} onSubmit={(password) => attempt(async () => { const r = await call('create', { password }); typedPassword.current = password; setSeed(r.seed); go('seed'); })} />}

      {view === 'seed' && (
        <div className="screen">
          <div className="title" style={{ fontSize: 36, marginTop: 26 }}>Write these down.</div>
          <div className="lede" style={{ fontSize: 13 }}>Anyone with these {wordCount(seed)} words can take your coins. If you lose them, nobody can get your wallet back, including us.</div>
          <WordGrid words={seed} testid="seed" />
          <div className="grow" />
          <div style={{ paddingBottom: 20 }}><Fold cols="1fr" items={[{ label: 'I wrote them down', hit: true, id: 'seed-done', onClick: () => { setSeed(''); if (!offerBio()) typedPassword.current = ''; go(offerBio() ? 'faceid' : 'home'); } }]} /></div>
        </div>
      )}

      {view === 'restore' && <RestoreScreen busy={busy} error={error} Head={Head} onSubmit={(source: object, password: string, height?: number) => attempt(async () => { await call('restore', { ...source, password, restoreHeight: height }); if (offerBio()) typedPassword.current = password; go(offerBio() ? 'faceid' : 'home'); })} />}

      {view === 'locked' && bioReady && (
        <LockedScreen busy={busy} error={error} bio={bioState} onBio={unlockWithBio} onSubmit={(password: string) => attempt(() => finishUnlock(password, true))} />
      )}

      {view === 'faceid' && bioState && (
        <div className="screen">
          <div className="center fade-in">
            <img src="/brand/w-sky.png" alt="" style={{ width: 92, height: 'auto', marginBottom: 22 }} />
            <div className="title">Unlock with {bioState.kind}?</div>
            <div className="lede">Open Walnero with a glance instead of typing your password. If {bioState.kind} doesn't recognize you after two tries, you type your password as usual.</div>
            {error && <div className="error">{error}</div>}
          </div>
          <div style={{ display: 'grid', gap: 9, paddingBottom: 26 }}>
            <Fold cols="1fr" items={[{ label: busy ? 'Turning on' : `Turn on ${bioState.kind}`, hit: true, id: 'faceid-on', disabled: busy, onClick: () => attempt(async () => {
              const r = await bio.enable(typedPassword.current);
              if (!r.ok && r.error === 'cancel') return;
              if (!r.ok) throw new Error(`${bioState.kind} couldn't be turned on. You can try again in Settings.`);
              typedPassword.current = ''; setBio(await bio.status()); go('home');
            }) }]} />
            <Fold cols="1fr" items={[{ label: 'Not now', id: 'faceid-skip', onClick: () => { typedPassword.current = ''; bio.asked(); setBio({ ...bioState, asked: true }); go('home'); } }]} />
          </div>
        </div>
      )}

      {view === 'home' && (
        <div className={`screen ${enterHome ? 'enter' : ''}`}>
          <Head title={walletLabel || (MAINNET ? 'Main wallet' : 'Test wallet')} />
          <button className="bal" data-testid="balance" aria-label={prefs.hidden ? 'Show balance' : 'Hide balance'} onClick={() => updatePrefs({ hidden: !prefs.hidden })}>
            {prefs.hidden ? <span className="stars">{STARS}</span> : <Reels value={trim4(home?.balance ?? '0.0000')} rollIn={enterHome} />}<small>XMR</small>
          </button>
          <div className="sub">
            <span className="sync" data-testid="sync-label">{syncLabel(home)}</span>
            {home?.viewOnly && <span className="sync" style={{ color: 'var(--mid)' }} data-testid="view-only">View only</span>}
            {home && !isZero(home.onTheWay) && <span className="sync" style={{ color: 'var(--mid)' }} data-testid="on-the-way">{prefs.hidden ? 'Some on the way' : `${trim4(home.onTheWay)} on the way`}</span>}
            <div className="bars">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ ['--i' as string]: i }} className={home && i / 14 < syncShare(home) ? 'lit' : ''} />)}</div>
          </div>
          {prefs.timings && <div className="speedline" data-testid="speedline">{speed ? speedText(speed) : 'Measuring this open'}</div>}
          <div style={{ marginTop: 14 }}><Fold cols="1.2fr 1fr 1fr" items={[{ label: 'Send', hit: true, id: 'send', disabled: !home || home.viewOnly || home.phase === 'slow' || home.phase === 'offline' || home.phase === 'failed' || (home.firstOpen && !home.synced), onClick: () => { setSendTo(''); go('send'); } }, { label: 'Receive', id: 'receive', onClick: () => go('receive') }, { label: 'Swap', id: 'swap', onClick: () => go('swap') }]} /></div>
          <div className="label">
            <h3>Tokens</h3>
            <button type="button" className="lines" data-testid="manage-tokens" aria-label="Manage tokens" onClick={() => setView('manage')}>{icon('list')}</button>
          </div>
          <div className="stack">
            <button type="button" className={`slip row-button ${pulse ? 'pulse' : ''}`} data-testid="token-xmr" aria-label="Monero" style={{ ['--i' as string]: 0, ['--tone' as string]: '#202020' }} onClick={() => setView('token')}>
              <img src="/coins/xmr.png" alt="" />
              <div>
                <div className="name">Monero</div>
                {!MAINNET ? <div className="note">Test network</div> : showValue && <div className="note" data-testid="token-price-line">{usd(mkt!.price)} <span className={mkt!.changePct < 0 ? 'down' : 'up'}>{pct(mkt!.changePct)}</span></div>}
              </div>
              <div className="end">
                <b>{prefs.hidden ? STARS : trim4(home?.balance ?? '0.0000')}</b>
                <div className="note" data-testid="token-value">{showValue ? (prefs.hidden ? STARS : usd(Number(home?.balance ?? 0) * mkt!.price)) : 'XMR'}</div>
              </div>
            </button>
            {prefs.btc && (
              <button type="button" className="slip row-button" data-testid="token-btc" aria-label="Bitcoin" style={{ ['--i' as string]: 1, ['--tone' as string]: '#1B1B1B' }} onClick={() => setView('btc')}>
                <img src="/coins/btc.png" alt="" />
                <div>
                  <div className="name">Bitcoin</div>
                  {btc && !btc.available ? <div className="note">Needs a 12-word wallet</div>
                    : !MAINNET ? <div className="note">Testnet4</div>
                    : showBtcValue && <div className="note" data-testid="btc-price-line">{usd(bmkt!.price)} <span className={bmkt!.changePct < 0 ? 'down' : 'up'}>{pct(bmkt!.changePct)}</span></div>}
                </div>
                <div className="end">
                  <b data-testid="btc-balance">{btc && !btc.available ? '' : prefs.hidden ? STARS : btcAmount(btc?.balance ?? '0.00')}</b>
                  <div className="note" data-testid="btc-value">{btc && !btc.available ? '' : showBtcValue ? (prefs.hidden ? STARS : usd(Number(btc?.balance ?? 0) * bmkt!.price)) : 'BTC'}</div>
                </div>
              </button>
            )}
          </div>
          {PHONE && !MAINNET && <Faucet state={faucet} onClaim={claimFaucet} />}
          {home?.phase === 'slow' && !home.feedRejected && !home.full?.running && <div className="note" style={{ marginTop: 12, textAlign: 'center' }}>Catching up the long way, which can take a few minutes. You can receive right away.</div>}
          {home?.phase === 'slow' && home.full?.running && <div className="note" style={{ marginTop: 12, textAlign: 'center' }} data-testid="full-running">Full check running. Send is back when it finishes.</div>}
          {home?.feedRejected && <div className="note" style={{ marginTop: 12, textAlign: 'center' }} data-testid="feed-rejected">The quick check didn't match the chain, so Walnero is reading it block by block. Your coins are safe. Run a full check in Settings when it's done.</div>}
          {home?.firstOpen && !home.synced && home.phase !== 'slow' && <div className="note" style={{ marginTop: 12, textAlign: 'center' }}>A wallet's very first open takes a minute or two. You can receive right away.</div>}
          {home?.phase === 'offline' && <div className="note" style={{ marginTop: 12, textAlign: 'center' }} data-testid="offline-note">No connection right now. This is your last known balance. It updates by itself when you're back online.</div>}
          {home?.phase === 'failed' && <div className="note" style={{ marginTop: 12, textAlign: 'center' }} data-testid="failed-note">The wallet engine didn't start, so this is your last known balance. Your coins are safe. Lock Walnero and open it again.</div>}
          {nav}
        </div>
      )}

      {view === 'activity' && (
        <div className="screen">
          <div className="title" style={{ fontSize: 36, marginTop: 8 }}>Activity</div>
          <div className="stack" data-testid="activity" style={{ overflow: 'auto', paddingBottom: 70 }}>
            {txs?.length || (prefs.btc && btc?.txs?.length) ? allActivity(txs, prefs.btc ? btc?.txs : null).map((t, i) => <TxRow key={`${t.coin}-${t.hash}`} t={t} i={i} hidden={prefs.hidden} onOpen={() => openTx(t, 'activity')} />)
              : <div className="empty">{txs ? `Nothing here yet. Receive some ${MAINNET ? 'XMR' : 'test XMR'} and it shows up here.` : 'Loading'}</div>}
          </div>
          {nav}
        </div>
      )}

      {view === 'swap' && <SwapScreen Head={Head} />}

      {view === 'token' && (
        <TokenScreen home={home} txs={txs} prefs={prefs} market={mkt} marketFailed={mktFailed} onBack={() => setView('home')} onPrices={() => updatePrefs({ prices: true })}
          sendOff={!home || home.viewOnly || home.phase === 'slow' || home.phase === 'offline' || home.phase === 'failed' || (home.firstOpen && !home.synced)}
          onSend={() => { setSendTo(''); go('send'); }} onReceive={() => go('receive')} onSwap={() => go('swap')}
          onTx={(t: Tx) => openTx(t, 'token')} onAll={() => setView('activity')} />
      )}

      {view === 'btc' && (
        <TokenScreen coin={BTC_COIN} home={btc} txs={btc ? btc.txs.map((t: Tx) => ({ ...t, coin: 'btc' })) : null} prefs={prefs} market={MAINNET ? bmkt : null} marketFailed={bmktFailed} onBack={() => setView('home')} onPrices={() => updatePrefs({ prices: true })}
          sendOff={!btc?.available || !btc?.ready} blocked={btc && !btc.available ? btc.why : ''}
          onSend={() => go('btcsend')} onReceive={() => go('btcreceive')}
          onTx={(t: Tx) => openTx(t, 'btc')} onAll={() => setView('activity')} />
      )}
      {view === 'btcreceive' && <BtcReceiveScreen Head={Head} />}
      {view === 'btcsend' && <BtcSendScreen Head={Head} btc={btc} hidden={prefs.hidden} market={showBtcValue ? bmkt : null} onSent={(info: SentInfo) => { setSent({ ...info, coin: 'btc' }); go('sent'); }} />}

      {view === 'tx' && txOpen && (txOpen.tx.coin === 'btc'
        ? <TxScreen coin={BTC_COIN} tx={{ ...(btc?.txs?.find((t: Tx) => t.hash === txOpen.tx.hash) ?? txOpen.tx), coin: 'btc' }} hidden={prefs.hidden} market={showBtcValue ? bmkt : null} onBack={() => setView(txOpen.from)} />
        : <TxScreen tx={txs?.find((t) => t.hash === txOpen.tx.hash) ?? txOpen.tx} hidden={prefs.hidden} market={showValue ? mkt : null} onBack={() => setView(txOpen.from)} />
      )}

      {view === 'manage' && <ManageScreen prefs={prefs} updatePrefs={updatePrefs} onBack={() => setView('home')} />}

      {view === 'settings' && (
        <SettingsScreen home={home} nav={nav} prefs={prefs} updatePrefs={updatePrefs} bioState={bioState} setBio={setBio} faucet={faucet} onClaim={claimFaucet}
          onNames={() => setView('names')} onSwitched={onSwitched} onLock={() => attempt(async () => { await call('lock'); go('locked'); })} />
      )}

      {view === 'names' && <NamesScreen nav={nav} onSend={(name: string) => { setSendTo(name); go('send'); }} />}

      {view === 'receive' && <ReceiveScreen Head={Head} />}
      {view === 'send' && <SendScreen Head={Head} pay={pay} home={home} hidden={prefs.hidden} to={sendTo} onSent={(info: SentInfo) => { setSent(info); go('sent'); }} />}

      {view === 'sent' && sent && (
        <div className="screen sent">
          <div className="ok">{icon('check')}</div>
          <div className="sent-word">Sent.</div>
          {sent.coin === 'btc' ? (
            <>
              <div className="sent-d" data-testid="sent-line">{btcAmount(sent.amount)} BTC to {sent.to}</div>
              <div className="sent-n">Fee {btcAmount(sent.fee)} BTC. It lands in {sent.time ? sent.time.toLowerCase() : 'about 30 minutes'}.</div>
              <div className="hash" data-testid="tx-hash">{sent.hash}</div>
              <a className="sent-n" style={{ marginTop: 6 }} data-testid="sent-explorer" href={BTC_COIN.explorer(sent.hash)} target="_blank" rel="noreferrer">View on mempool.space</a>
            </>
          ) : (
            <>
              <div className="sent-d" data-testid="sent-line">{trim4(sent.amount)} XMR to {sent.to}</div>
              <div className="sent-n">Fee {Number(sent.fee).toFixed(6)} XMR. It lands in the next block, about 2 minutes.</div>
              <div className="hash" data-testid="tx-hash">{sent.hash}</div>
              {!MAINNET && <a className="sent-n" style={{ marginTop: 6 }} href={explorerUrl(sent.hash)} target="_blank" rel="noreferrer">View on the test network explorer</a>}
            </>
          )}
          <div className="grow" />
          <div className="sent-done" style={{ paddingBottom: 26 }}><div className="fold"><button className="sk dark" data-testid="done" onClick={() => { setSent(null); setPulse(true); go('home', 'black'); }}><span>Done</span></button></div></div>
        </div>
      )}

      {wiping && <div className={`wipe ${wiping.tone === 'black' ? 'black' : ''}`} key={wiping.n} onAnimationEnd={() => setWiping(null)} />}
    </GoContext.Provider>
  );
}

// --- Monero, its transactions, and the token list ------------------------------------------------------------------------

const whenShort = (seconds: number) => new Date(seconds * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function TxRow({ t, i, hidden, onOpen }: { t: Tx; i: number; hidden: boolean; onOpen: () => void }) {
  const c = coinOf(t);
  return (
    <button type="button" className="slip row-button" data-testid={`tx-row-${i}`} style={{ ['--i' as string]: Math.min(i, 5), ['--tone' as string]: TONES[Math.min(i, 5)] }} onClick={onOpen}>
      <div className="glyph">{icon(t.self ? 'arrows-clockwise' : t.incoming ? 'arrow-down-left' : 'arrow-up-right')}</div>
      <div><div className="name">{t.self ? 'Moved' : t.incoming ? 'Received' : 'Sent'}</div><div className="note">{t.confirmed && t.confirmations >= needed(t) && t.time ? whenShort(t.time) : txStatus(t)}</div></div>
      <div className="end"><b>{hidden ? STARS : `${t.incoming ? '+' : t.self ? '' : '-'}${c.amount(t.amount)}`}</b><div className="note">{c.ticker}</div></div>
    </button>
  );
}

// Activity shows both coins: anything waiting for a block first, then newest first.
const allActivity = (xmr: Tx[] | null, btc: Tx[] | null | undefined): Tx[] => [
  ...(xmr ?? []).map((t) => ({ ...t, coin: 'xmr' as const })),
  ...(btc ?? []).map((t) => ({ ...t, coin: 'btc' as const })),
].sort((a, b) => (a.confirmed === b.confirmed ? b.time - a.time : a.confirmed ? 1 : -1));

// The chart library works in UTC. Its documented fix for local time is to move every point by the local offset, so the
// axis reads in this phone's own time; the time under your finger is then shown back in UTC, which is the local wall time.
const localTime = (t: number) => t - new Date(t * 1000).getTimezoneOffset() * 60;
const RANGE_LIST: Range[] = ['1D', '1W', '1M', 'YTD', 'ALL'];
const RANGE_WORDS: Record<Range, string> = { '1D': 'Past day', '1W': 'Past week', '1M': 'Past month', YTD: 'This year', ALL: 'All time' };
const pointWhen = (t: number, range: Range) => new Date(t * 1000).toLocaleString('en-US', range === 'YTD' || range === 'ALL'
  ? { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }
  : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });

// Handles like TradingView: drag or swipe sideways to move through time, wheel or pinch to zoom, drag either scale to stretch
// it, double-click a scale to reset. Touching the line shows the price at that moment in the header.
function PriceChart({ points, range, onPoint }: { points: Point[]; range: Range; onPoint: (p: Point | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const parts = useRef<{ chart: IChartApi; series: ISeriesApi<'Area'> } | null>(null);
  const report = useRef(onPoint);
  report.current = onPoint;
  useEffect(() => {
    const chart = createChart(box.current!, {
      autoSize: true,
      // The library's credit is a line at the bottom of the Monero screen instead of a logo on top of the line.
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#77777A', fontFamily: '"Geist Mono", monospace', fontSize: 10, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: '#141414' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.14, bottom: 0.06 } },
      timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: '#7CC4FF66', width: 1, style: LineStyle.Solid, labelBackgroundColor: '#1F1F1F' },
        horzLine: { color: '#7CC4FF40', labelBackgroundColor: '#1F1F1F' },
      },
      // Up and down swipes over the chart scroll the screen instead.
      handleScroll: { vertTouchDrag: false },
      localization: { priceFormatter: (p: number) => `$${p.toFixed(2)}` },
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: '#7CC4FF', topColor: 'rgba(124, 196, 255, 0.26)', bottomColor: 'rgba(124, 196, 255, 0)', lineWidth: 2,
      priceLineVisible: false, crosshairMarkerRadius: 4, crosshairMarkerBorderColor: '#000', crosshairMarkerBackgroundColor: '#7CC4FF',
    });
    chart.subscribeCrosshairMove((param) => {
      const hit = param.time != null ? (param.seriesData.get(series) as { value?: number } | undefined) : undefined;
      report.current(hit?.value != null ? { time: Number(param.time), value: hit.value } : null);
    });
    parts.current = { chart, series };
    return () => { parts.current = null; chart.remove(); };
  }, []);
  useEffect(() => {
    const p = parts.current;
    if (!p) return;
    let last = -Infinity;
    // Clocks going back an hour would repeat times, which the chart refuses, so only strictly later points are kept.
    const data = points.map((pt) => ({ time: localTime(pt.time) as UTCTimestamp, value: pt.value })).filter((pt) => (pt.time > last ? ((last = pt.time), true) : false));
    p.series.setData(data);
    p.chart.applyOptions({ timeScale: { timeVisible: range === '1D' || range === '1W', secondsVisible: false } });
    p.chart.timeScale().fitContent();
  }, [points, range]);
  return <div className="tk-chart" ref={box} data-testid="token-chart" />;
}

const skel = (width: number, height = 14) => <span className="skel" style={{ width, height }} />;

function TokenScreen({ coin = XMR_COIN, blocked = '', home, txs, prefs, market: m, marketFailed, sendOff, onBack, onPrices, onSend, onReceive, onSwap, onTx, onAll }: any) {
  const c = coin as CoinInfo;
  const [range, setRange] = useState<Range>('1D');
  const [data, setData] = useState<{ range: Range; points: Point[] } | null>(null);
  const [failed, setFailed] = useState('');
  const [tries, setTries] = useState(0);
  const [scrub, setScrub] = useState<Point | null>(null);
  useEffect(() => {
    if (!prefs.prices) return;
    let live = true;
    setFailed('');
    loadChart(range, c.key).then((points) => { if (live) setData({ range, points }); }).catch((e) => { if (live) setFailed(String(e?.message ?? e)); });
    return () => { live = false; };
  }, [range, prefs.prices, tries, c.key]);

  const balance = Number(home?.balance ?? 0);
  const ready = data != null && data.range === range && data.points.length > 1;
  const first = ready ? data.points[0]!.value : 0;
  const now: number | null = m?.price ?? (ready ? data.points[data.points.length - 1]!.value : null);
  let price = now; let change: number | null = null; let label = RANGE_WORDS[range];
  if (scrub && ready) { price = scrub.value; change = scrub.value - first; label = pointWhen(scrub.time, range); }
  else if (range === '1D' && m) change = m.change;
  else if (ready && now != null) change = now - first;
  const changePct = change == null ? null : range === '1D' && !scrub && m ? m.changePct : (change / first) * 100;
  const fact = (value: ReactNode) => (m ? value : marketFailed ? <span className="quiet">Not available</span> : skel(64));
  const recent: Tx[] = (txs ?? []).slice(0, 5);

  return (
    <div className="screen push"><div className="scroll">
      <Head title={c.name} onBack={onBack} />
      {prefs.prices ? (
        <>
          <div className="tk-price" data-testid="token-price">{price != null ? usd(price) : skel(170, 46)}</div>
          <div className={`tk-change ${change != null && change < 0 ? 'down' : 'up'}`} data-testid="token-change">
            {change != null ? <><span>{signedUsd(change)}</span><b>{pct(changePct!)}</b></> : skel(120, 18)}
            <em>{label}</em>
          </div>
          {!MAINNET && <div className="tk-test">{c.testNote}</div>}
          <div className={`tk-chart-wrap ${data && data.range !== range ? 'loading' : ''}`}>
            {data?.points.length ? <PriceChart points={data.points} range={data.range} onPoint={setScrub} /> : !failed && <div className="skel tk-chart-skel" />}
            {failed && <div className="tk-failed" data-testid="chart-failed">{failed}. <button type="button" onClick={() => setTries((n) => n + 1)}>Try again</button></div>}
          </div>
          <div className="ranges">
            {RANGE_LIST.map((r) => <button type="button" key={r} data-testid={`range-${r}`} className={r === range ? 'on' : ''} onClick={() => { setScrub(null); setRange(r); }}><span>{r}</span></button>)}
          </div>
        </>
      ) : (
        <div className="empty" style={{ marginTop: 14 }} data-testid="prices-off">Prices are off, so there's no chart. <button type="button" className="link" onClick={onPrices}>Turn them on</button></div>
      )}

      {blocked ? <NeedsPhrase why={blocked} /> : (
        <>
          <div style={{ marginTop: 16 }}><Fold cols={onSwap ? '1.2fr 1fr 1fr' : '1fr 1fr'} items={[{ label: 'Send', hit: true, id: 'token-send', disabled: sendOff, onClick: onSend }, { label: 'Receive', id: 'token-receive', onClick: onReceive }, ...(onSwap ? [{ label: 'Swap', id: 'token-swap', onClick: onSwap }] : [])]} /></div>

          <div className="sec"><h3>Your balance</h3></div>
          <div className="stack">
            <div className="slip" data-testid="token-balance" style={{ ['--i' as string]: 0, ['--tone' as string]: '#202020' }}>
              <img src={c.logo} alt="" />
              <div><div className="name">{c.name}</div><div className="note">{prefs.hidden ? STARS : `${c.amount(home?.balance ?? '0')} ${MAINNET ? c.ticker : `test ${c.ticker}`}`}</div></div>
              <div className="end">
                {MAINNET && prefs.prices && m
                  ? <><b>{prefs.hidden ? STARS : usd(balance * m.price)}</b><div className={`note ${m.change < 0 ? 'down' : 'up'}`}>{prefs.hidden ? 'today' : `${signedUsd(balance * m.change)} today`}</div></>
                  : <><b>{prefs.hidden ? STARS : c.amount(home?.balance ?? '0')}</b><div className="note">{MAINNET ? c.ticker : 'No value'}</div></>}
              </div>
            </div>
          </div>
          {c.key === 'bitcoin' && home?.error && <div className="snote" data-testid="btc-error">{home.error} Showing what Walnero last saw.</div>}
        </>
      )}

      <div className="sec"><h3>About</h3></div>
      <p className="about">{c.about}</p>

      {prefs.prices && (
        <>
          <div className="sec"><h3>Info</h3></div>
          <div className="card" data-testid="token-info">
            <div><span>Symbol</span><b>{c.ticker}</b></div>
            <div><span>Network</span><b>{c.network}</b></div>
            <div><span>Market cap</span><b>{fact(m && compactUsd(m.cap))}</b></div>
            <div><span>Circulating supply</span><b>{fact(m && `${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(m.supply)} ${c.ticker}`)}</b></div>
            <div><span>Max supply</span><b>{c.maxSupply}</b></div>
            <div><span>All-time high</span><b>{fact(m && usd(m.ath))}</b></div>
            <div><span>Rank</span><b>{fact(m && `#${m.rank}`)}</b></div>
          </div>
          <div className="sec"><h3>24h performance</h3></div>
          <div className="card" data-testid="token-24h">
            <div><span>Volume</span><b>{fact(m && compactUsd(m.volume))}</b></div>
            <div><span>High</span><b>{fact(m && usd(m.high))}</b></div>
            <div><span>Low</span><b>{fact(m && usd(m.low))}</b></div>
            <div><span>Market cap</span><b className={m && m.capChangePct < 0 ? 'down' : 'up'}>{fact(m && pct(m.capChangePct))}</b></div>
          </div>
        </>
      )}

      {!blocked && (
        <>
          <div className="sec"><h3>Activity</h3>{(txs?.length ?? 0) > recent.length && <button type="button" className="link" data-testid="token-all" onClick={onAll}>See all</button>}</div>
          <div className="stack" data-testid="token-activity">
            {recent.length ? recent.map((t, i) => <TxRow key={t.hash} t={t} i={i} hidden={prefs.hidden} onOpen={() => onTx(t)} />)
              : <div className="empty">{txs ? `No ${MAINNET ? c.name : `test ${c.name}`} activity yet.` : 'Loading'}</div>}
          </div>
        </>
      )}
      {prefs.prices && <div className="snote credit">Prices from CoinGecko. Chart from Kraken, drawn with <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView</a> Lightweight Charts.</div>}
    </div></div>
  );
}

// Phantom-style: the amount up top, then every fact the wallet knows. Monero hides senders, so "From" says so plainly.
function TxScreen({ coin: c = XMR_COIN, tx, hidden, market: m, onBack }: { coin?: CoinInfo; tx: Tx; hidden: boolean; market: Market | null; onBack: () => void }) {
  const [names, setNames] = useState<SavedName[]>([]);
  const [copied, setCopied] = useState(false);
  useEffect(() => { call<SavedName[]>('names').then(setNames).catch(() => {}); }, []);
  const named = (address: string) => { const hit = names.find((n) => n.address === address); return hit ? `@${hit.name}` : shortAddr(address); };
  const copy = async () => { await navigator.clipboard.writeText(tx.hash); setCopied(true); setTimeout(() => setCopied(false), 1400); };
  const done = tx.confirmed && tx.confirmations >= needed(tx);
  const amt = (n: string) => (c.key === 'bitcoin' ? btcAmount(n) : exact(n));
  const rows: [string, ReactNode][] = [
    ['Date', tx.time ? when(tx.time) : 'Not in a block yet'],
    ['Status', <span className={done ? 'up' : 'wait'}>{txStatus(tx)}</span>],
    ['From', tx.incoming ? (c.key === 'monero' ? 'Hidden by Monero' : 'Another wallet') : 'This wallet'],
    ['To', tx.incoming ? (tx.on ? `This wallet, ${shortAddr(tx.on)}` : 'This wallet') : tx.to?.length ? tx.to.map(named).join(', ') : 'Not known on this device'],
    ['Network', c.network],
    ...(tx.incoming ? [] : [['Network fee', tx.fee ? `${amt(tx.fee)} ${c.ticker}` : 'Not known on this device'] as [string, ReactNode]]),
    ['Block', tx.height ? tx.height.toLocaleString('en-US') : 'Waiting'],
  ];
  return (
    <div className="screen push"><div className="scroll">
      <Head title={tx.self ? 'Moved' : tx.incoming ? 'Received' : 'Sent'} onBack={onBack} />
      <div className="tx-top">
        <div className={`tx-glyph ${tx.incoming ? 'in' : ''}`}>{icon(tx.incoming ? 'arrow-down-left' : 'arrow-up-right')}</div>
        <div className="tx-amt" data-testid="tx-amount">{hidden ? STARS : `${tx.incoming ? '+' : tx.self ? '' : '-'}${amt(tx.amount)}`}<small>{c.ticker}</small></div>
        {!hidden && <div className="tx-value">{!MAINNET ? 'Test coins have no value' : m ? `About ${usd(Number(tx.amount) * m.price)} at today's price` : ''}</div>}
      </div>
      <div className="card" data-testid="tx-facts">
        {rows.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}
        <div>
          <span>Transaction ID</span>
          <button type="button" className="copy-id" data-testid="tx-copy" onClick={copy}>{copied ? 'Copied' : `${tx.hash.slice(0, 6)}…${tx.hash.slice(-6)}`}{icon(copied ? 'check' : 'copy')}</button>
        </div>
      </div>
      <div className="fold" style={{ marginTop: 16 }}>
        <a className="sk" data-testid="tx-explorer" href={c.explorer(tx.hash)} target="_blank" rel="noreferrer"><span>View on {c.explorerName} {icon('arrow-square-out')}</span></a>
      </div>
      <div className="snote">{c.key === 'bitcoin'
        ? 'mempool.space will see this transaction ID and your connection. Bitcoin payments are public, so anyone can look this one up and see its amounts and addresses.'
        : `${MAINNET ? 'XMRScan' : 'The test explorer'} will see this transaction ID and your connection, so it could guess the payment is yours. It can't see amounts or addresses: Monero hides those from everyone.`}</div>
    </div></div>
  );
}

// Behind the three lines next to Tokens on Home.
function ManageScreen({ prefs, updatePrefs, onBack }: { prefs: Prefs; updatePrefs: (change: Partial<Prefs>) => void; onBack: () => void }) {
  return (
    <div className="screen push"><div className="scroll">
      <Head title="Wallet" onBack={onBack} />
      <div className="title" style={{ fontSize: 34, marginTop: 10 }}>Manage tokens</div>
      <div className="sgroup">
        <Row icon="/coins/xmr.png" title="Monero" sub={MAINNET ? 'XMR, always shown' : 'Test XMR, always shown'} testid="manage-xmr" end={<Toggle on label="Monero" disabled onChange={() => {}} />} />
        <Row icon="/coins/btc.png" title="Bitcoin" sub={MAINNET ? 'BTC, from your 12 words' : 'Testnet4 BTC, from your 12 words'} testid="manage-btc" end={<Toggle on={prefs.btc} label="Bitcoin" onChange={(on) => updatePrefs({ btc: on })} />} />
      </div>
      <div className="snote">Monero is the wallet's own coin. Bitcoin comes from the same 12 recovery words, so wallets made with 12 words have it too.</div>
      <div className="sgroup">
        <Row icon="chart-line-up" title="Show prices" sub="Price, chart and dollar value" testid="manage-prices" end={<Toggle on={prefs.prices} label="Show prices" onChange={(on) => updatePrefs({ prices: on })} />} />
      </div>
      <div className="snote">Prices come from CoinGecko and the chart from Kraken. Walnero only asks them what Monero and Bitcoin cost, never anything about your wallet.</div>
    </div></div>
  );
}

// --- Settings ----------------------------------------------------------------------------------------------------------
// Rows are the same stacked slips as Tokens and Activity; switches are cut at the W's 20 degrees like every button.

function Toggle({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (on: boolean) => void; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`tog ${on ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}><i /></button>;
}

function Row({ icon: glyph, title, sub, end, onClick, testid }: { icon: string; title: string; sub?: ReactNode; end?: ReactNode; onClick?: () => void; testid?: string }) {
  const body = <><span className="g">{glyph.startsWith('/') ? <img src={glyph} alt="" /> : icon(glyph)}</span><div className="txt"><div className="t">{title}</div>{sub && <div className="s">{sub}</div>}</div><div className="end">{end}</div></>;
  return onClick ? <button type="button" className="srow" data-testid={testid} onClick={onClick}>{body}</button> : <div className="srow" data-testid={testid}>{body}</div>;
}
const more = (value?: string) => <>{value && <span>{value}</span>}{icon('caret-right')}</>;

function Faucet({ state, onClaim }: { state: { busy: boolean; message: string }; onClaim: () => void }) {
  return (
    <button type="button" className="faucet" data-testid="faucet" disabled={state.busy} onClick={onClaim}>
      <span className="g">{icon('drop')}</span>
      <div className="txt"><div className="t">{state.busy ? 'Asking the faucet' : 'Need test coins?'}</div><div className="s">{state.message || '0.01 test XMR from the faucet, once an hour'}</div></div>
      <span className="go">Get</span>
    </button>
  );
}

const HELP = [
  ['Why does it open so fast?', "Instead of downloading every block, Walnero reads a small feed of what's new and checks it against independent Monero servers. If anything doesn't match, it reads the chain the normal way."],
  ['What is the test network?', 'A copy of Monero where the coins have no value, for trying things out. Turn it on in Developer settings. Your real wallet stays exactly as it is.'],
  ['What if I lose this device?', 'Your recovery words bring the wallet back on any device, in Walnero or in Cake Wallet. Nobody else can recover it for you, including us, so keep them somewhere safe.'],
  ['Can Walnero see my money?', "No. Your keys never leave this device. Walnero's servers only send public blockchain data, the same for everyone."],
];

type SettingsPage = 'main' | 'security' | 'network' | 'developer' | 'help' | 'words' | 'password' | 'node' | 'addnode'
  | 'wallets' | 'wallet' | 'addwallet' | 'newwords' | 'restorewallet' | 'importkeys' | 'keys' | 'removewallet';
const KEY_MASK = '•'.repeat(48);
const wordCount = (words: string) => words.trim().split(/\s+/).filter(Boolean).length;
// Recovery words, numbered. Twelve get two roomy columns, like Phantom; a 25-word Monero seed packs into three.
function WordGrid({ words, testid }: { words: string; testid: string }) {
  const list = words.trim().split(/\s+/).filter(Boolean);
  return <div className={`seed ${list.length <= 12 ? 'twelve' : ''}`} data-testid={testid}>{list.map((w, i) => <div key={i}><em>{i + 1}</em>{w}</div>)}</div>;
}

// Names for the built-in nodes, the way Cake Wallet labels its list. A node someone adds shows the name they gave it.
const NODE_NAMES: Record<string, string> = {
  'xmr-node.cakewallet.com': 'Cake Wallet', 'monero.definitelynotafed.com': 'Definitely Not A Fed', 'xmr.support': 'xmr.support',
  'xmr-01.tari.com': 'Tari', 'xmr.unshakled.net': 'Unshakled', 'chad.fiatfaucet.com': 'Fiat Faucet', 'xmr.marritt.ca': 'Marritt',
  'xmr1.doggett.tech': 'Doggett', 'monero.openinternet.io': 'Open Internet', 'node.sethforprivacy.com': 'Seth For Privacy',
  'node.monerodevs.org': 'MoneroDevs', 'node2.monerodevs.org': 'MoneroDevs #2', 'node3.monerodevs.org': 'MoneroDevs #3',
  'stagenet.xmr.kernal.eu': 'Kernal',
};
interface NodeCheck { url: string; ok: boolean; ms?: number; height?: number; error?: string }
interface CustomNode { url: string; label: string; trusted: boolean }
const nodeHost = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const nodeName = (url: string, custom?: CustomNode) => { if (custom?.label) return custom.label; try { return NODE_NAMES[new URL(url).hostname] ?? nodeHost(url); } catch { return url; } };
// Signal bars like Cake's: three for a quick answer, two for a slow one, one for a very slow one.
const nodeBars = (c?: NodeCheck) => (!c?.ok || c.ms == null ? 0 : c.ms < 400 ? 3 : c.ms < 1200 ? 2 : 1);

function SettingsScreen({ home, nav, prefs, updatePrefs, bioState, setBio, faucet, onClaim, onNames, onLock, onSwitched }: any) {
  const [page, setPage] = useState<SettingsPage>('main');
  const [wallets, setWallets] = useState<WalletList | null>(null);
  const [wid, setWid] = useState('');
  const [wlabel, setWlabel] = useState('');
  const [wseed, setWseed] = useState('');
  const [wheight, setWheight] = useState('');
  const [ik, setIk] = useState({ address: '', view: '', spend: '' });
  const [newSeed, setNewSeed] = useState('');
  const [keys, setKeys] = useState<KeyInfo | null>(null);
  const [showView, setShowView] = useState(false);
  const [showSpend, setShowSpend] = useState(false);
  const [copiedKey, setCopiedKey] = useState('');
  const loadWallets = useCallback(() => call<WalletList>('wallets').then(setWallets).catch(() => {}), []);
  useEffect(() => { loadWallets(); }, [page, loadWallets]);
  const activeWallet = wallets?.list.find((w) => w.id === wallets?.active);
  const selected = wallets?.list.find((w) => w.id === wid);
  const [address, setAddress] = useState('');
  const [copied, setCopied] = useState(false);
  const [names, setNames] = useState<number | null>(null);
  const [speed, setSpeed] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [pass, setPass] = useState(''); const [pass2, setPass2] = useState(''); const [pass3, setPass3] = useState('');
  const [words, setWords] = useState('');
  const [moneroWords, setMoneroWords] = useState(''); const [showMonero, setShowMonero] = useState(false);
  const [bioPass, setBioPass] = useState<string | null>(null);
  const [nodes, setNodes] = useState<{ mode: string; current: string | null; builtin: string[]; custom: CustomNode[] } | null>(null);
  const [checks, setChecks] = useState<Record<string, NodeCheck> | null>(null);
  const [form, setForm] = useState({ label: '', address: '', port: '', ssl: true, trusted: false });
  const loadNodes = useCallback(() => call('nodeList').then(setNodes).catch(() => {}), []);
  const testNodes = useCallback(() => { setChecks(null); return call<NodeCheck[]>('checkNodes').then((list) => setChecks(Object.fromEntries(list.map((c) => [c.url, c])))).catch(() => setChecks({})); }, []);
  useEffect(() => {
    if (page === 'network' || page === 'node') loadNodes();
    if (page === 'node') testNodes();
  }, [page, loadNodes, testNodes]);
  useEffect(() => {
    call('primaryAddress').then((r) => setAddress(r.address)).catch(() => {});
    call<SavedName[]>('names').then((list) => setNames(list.length)).catch(() => {});
    call('speed').then(setSpeed).catch(() => {});
  }, []);
  const open = (next: SettingsPage) => {
    setError(''); setDone(''); setPass(''); setPass2(''); setPass3(''); setWords(''); setMoneroWords(''); setShowMonero(false); setBioPass(null);
    if (next === 'addwallet' && page === 'wallets') setWlabel('');
    if (next !== 'restorewallet') setWseed('');
    if (next !== 'importkeys') setIk({ address: '', view: '', spend: '' });
    if (next !== 'restorewallet' && next !== 'importkeys') setWheight('');
    if (next !== 'newwords') setNewSeed('');
    if (next !== 'keys') { setKeys(null); setShowView(false); setShowSpend(false); setCopiedKey(''); }
    setPage(next);
  };
  const openWallet = (id: string) => { setWid(id); setWlabel(wallets?.list.find((w) => w.id === id)?.label ?? ''); open('wallet'); };
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); } catch (e: any) { setError(String(e?.message ?? e)); } finally { setBusy(false); } };
  // Secrets go through the iPhone app's clipboard (it clears itself after a minute); the address is an ordinary copy.
  const copyKey = (name: string, text: string, secret: boolean) => {
    const write = secret && PHONE && appBridge ? appBridge.postMessage({ op: 'copySecret', text }) : navigator.clipboard.writeText(text);
    write.then(() => { setCopiedKey(name); setTimeout(() => setCopiedKey((c) => (c === name ? '' : c)), 1400); }).catch(() => {});
  };
  const newName = () => wlabel.trim() || `Wallet ${(wallets?.list.length ?? 0) + 1}`;
  const switchTo = (id: string) => { if (id !== wallets?.active) run(async () => { await call('switchWallet', { id }); onSwitched(); }); };
  const kind = bioState?.kind ?? 'Face ID';
  const back = <Head title="Settings" onBack={() => open('main')} />;
  const heading = (text: string) => <div className="title" style={{ fontSize: 34, marginTop: 10 }}>{text}</div>;
  const status = !home ? 'Opening' : home.phase === 'offline' ? 'Offline' : home.synced ? 'Connected' : 'Catching up';

  if (page === 'wallets') {
    const list = wallets?.list ?? [];
    return (
      <div className="screen"><div className="scroll">
        {back}
        {heading('Wallets')}
        <div className="lede">Each wallet has its own recovery words. One password opens them all.</div>
        <div className="sgroup" data-testid="wallet-list">
          {list.map((w) => {
            const cur = w.id === wallets?.active;
            return (
              <div key={w.id} className={`srow ${cur ? 'cur' : ''}`}>
                <button type="button" className="wmain" data-testid={`wallet-row-${w.id}`} disabled={busy} onClick={() => switchTo(w.id)}>
                  <span className="g">{cur ? icon('check') : icon('wallet')}</span>
                  <span className="txt"><span className="t">{w.label}</span><span className="s">{w.viewOnly && <span className="vo" data-testid={`wallet-vo-${w.id}`}>View only</span>}{w.address ? shortAddr(w.address) : 'Not opened yet'}</span></span>
                </button>
                <button type="button" className="wmore" aria-label={`Details for ${w.label}`} data-testid={`wallet-more-${w.id}`} onClick={() => openWallet(w.id)}>{icon('caret-right')}</button>
              </div>
            );
          })}
        </div>
        {error && <div className="error">{error}</div>}
        <div style={{ marginTop: 16 }}><Fold cols="1fr" items={[{ label: 'Add a wallet', id: 'wallet-add', onClick: () => open('addwallet') }]} /></div>
      </div>{nav}</div>
    );
  }

  if (page === 'addwallet') {
    return (
      <div className="screen"><div className="scroll">
        <Head title="Wallets" onBack={() => open('wallets')} />
        {heading('Add a wallet')}
        <div className="inline">
          <input data-testid="aw-label" placeholder="Name, like Savings" value={wlabel} onChange={(e) => setWlabel(e.target.value.slice(0, 30))} />
        </div>
        <div style={{ display: 'grid', gap: 9, marginTop: 16 }}>
          <Fold cols="1fr" items={[{ label: busy ? 'Creating' : 'Create a new wallet', hit: true, id: 'aw-create', disabled: busy, onClick: () => run(async () => {
            const r = await call('addWallet', { label: newName(), mode: 'create' });
            open('newwords');
            setNewSeed(r.seed ?? '');
          }) }]} />
          <Fold cols="1fr" items={[{ label: 'Restore from recovery words', id: 'aw-restore', onClick: () => open('restorewallet') }]} />
          <Fold cols="1fr" items={[{ label: 'Import from keys', id: 'aw-keys', onClick: () => open('importkeys') }]} />
        </div>
        {error && <div className="error" data-testid="aw-error">{error}</div>}
      </div>{nav}</div>
    );
  }

  if (page === 'newwords') {
    return (
      <div className="screen"><div className="scroll">
        {heading('Write these down.')}
        <div className="lede">These {wordCount(newSeed)} words are this wallet's backup. Anyone with them can take its coins.</div>
        <WordGrid words={newSeed} testid="aw-words" />
        <div className="snote">Write them on paper. Never type them into a website.</div>
        <div style={{ marginTop: 16 }}><Fold cols="1fr" items={[{ label: 'I wrote them down', hit: true, id: 'aw-words-done', onClick: () => onSwitched() }]} /></div>
      </div></div>
    );
  }

  if (page === 'restorewallet') {
    return (
      <div className="screen"><div className="scroll">
        <Head title="Add a wallet" onBack={() => open('addwallet')} />
        {heading('Restore a wallet')}
        <div className="inline">
          <textarea className="addr" data-testid="aw-seed" placeholder="Your 12 or 25 words, separated by spaces" spellCheck={false} autoCapitalize="off" autoCorrect="off" value={wseed} onChange={(e) => setWseed(e.target.value)} />
          <input data-testid="aw-height" inputMode="numeric" placeholder="Start from block (optional, faster)" value={wheight} onChange={(e) => setWheight(e.target.value.replace(/\D/g, '').slice(0, 9))} />
        </div>
        <div style={{ marginTop: 16 }}><Fold cols="1fr" items={[{ label: busy ? 'Restoring' : 'Restore wallet', hit: true, id: 'aw-go', disabled: busy || !wseed.trim(), onClick: () => run(async () => {
          const count = wseed.trim().split(/\s+/).length;
          if (![12, 24, 25].includes(count)) throw new Error(`That's ${count} words. Recovery words are 12 or 25 words.`);
          await call('addWallet', { label: newName(), mode: 'restore', seed: wseed.trim(), restoreHeight: wheight ? Number(wheight) : undefined });
          onSwitched();
        }) }]} /></div>
        {error && <div className="error" data-testid="aw-error">{error}</div>}
      </div>{nav}</div>
    );
  }

  if (page === 'importkeys') {
    const setKey = (name: 'address' | 'view' | 'spend', value: string) => setIk({ ...ik, [name]: value });
    return (
      <div className="screen"><div className="scroll">
        <Head title="Add a wallet" onBack={() => open('addwallet')} />
        {heading('Import from keys')}
        <div className="lede">With the address and view key you get a view-only wallet: it sees payments come in but can't send. Add the spend key to send too.</div>
        <div className="inline">
          <textarea className="addr" data-testid="ik-address" placeholder={`Main address (starts with ${MAINNET ? '4' : '5'})`} spellCheck={false} autoCapitalize="off" autoCorrect="off" value={ik.address} onChange={(e) => setKey('address', e.target.value)} />
          <input data-testid="ik-view" placeholder="Private view key" spellCheck={false} autoCapitalize="off" autoCorrect="off" value={ik.view} onChange={(e) => setKey('view', e.target.value.trim())} />
          <input data-testid="ik-spend" placeholder="Private spend key (leave empty for view-only)" spellCheck={false} autoCapitalize="off" autoCorrect="off" value={ik.spend} onChange={(e) => setKey('spend', e.target.value.trim())} />
          <input data-testid="ik-height" inputMode="numeric" placeholder="Start from block (optional, faster)" value={wheight} onChange={(e) => setWheight(e.target.value.replace(/\D/g, '').slice(0, 9))} />
        </div>
        <div style={{ marginTop: 16 }}><Fold cols="1fr" items={[{ label: busy ? 'Importing' : ik.spend ? 'Import wallet' : 'Import view-only wallet', hit: true, id: 'ik-go', disabled: busy || !ik.address.trim() || !ik.view, onClick: () => run(async () => {
          await call('addWallet', { label: newName(), mode: 'keys', address: ik.address, viewKey: ik.view, spendKey: ik.spend, restoreHeight: wheight ? Number(wheight) : undefined });
          onSwitched();
        }) }]} /></div>
        {error && <div className="error" data-testid="ik-error">{error}</div>}
      </div>{nav}</div>
    );
  }

  if (page === 'wallet') {
    const isActive = wid === wallets?.active;
    return (
      <div className="screen"><div className="scroll">
        <Head title="Wallets" onBack={() => open('wallets')} />
        {heading(selected?.label ?? 'Wallet')}
        <div className="inline">
          <input data-testid="wd-label" placeholder="Name" value={wlabel} onChange={(e) => setWlabel(e.target.value.slice(0, 30))} />
          <Fold cols="1fr" items={[{ label: busy ? 'Saving' : 'Rename', id: 'wd-rename', disabled: busy || !wlabel.trim(), onClick: () => run(async () => {
            await call('renameWallet', { id: wid, label: wlabel.trim() });
            await loadWallets();
            setDone('Renamed.');
          }) }]} />
        </div>
        {done && <div className="snote" style={{ color: 'var(--up)' }} data-testid="wd-done">{done}</div>}
        {selected?.viewOnly && <div className="snote" data-testid="wd-viewonly">View only. It sees payments coming in and can't send. Payments this wallet sends from another device don't show here, so its balance can read higher than it is.</div>}
        {!isActive && <div style={{ marginTop: 16 }}><Fold cols="1fr" items={[{ label: busy ? 'Switching' : 'Switch to this wallet', hit: true, id: 'wd-switch', disabled: busy, onClick: () => switchTo(wid) }]} /></div>}
        {error && <div className="error">{error}</div>}
        <div className="sgroup" style={{ marginTop: 16 }}>
          <Row icon="key" title="Show private keys" sub="Behind your password" end={more()} onClick={() => open('keys')} testid="wd-keys" />
          <Row icon="lock-simple" title="Remove this wallet" end={more()} onClick={() => open('removewallet')} testid="wd-remove" />
        </div>
      </div>{nav}</div>
    );
  }

  if (page === 'keys') {
    if (!keys) {
      return (
        <div className="screen"><div className="scroll">
          <Head title="Wallet" onBack={() => open('wallet')} />
          {heading('Private keys')}
          <div className="lede">Make sure nobody can see your screen, then type your password.</div>
          <div className="inline">
            <input type="password" data-testid="keys-password" placeholder="Your Walnero password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} />
            <Fold cols="1fr" items={[{ label: busy ? 'Checking' : 'Show keys', hit: true, id: 'keys-show', disabled: busy || !pass, onClick: () => run(async () => {
              const r = await call<KeyInfo>('walletKeys', { id: wid, password: pass });
              setPass('');
              setKeys(r);
            }) }]} />
          </div>
          {error && <div className="error" data-testid="keys-error">{error}</div>}
        </div>{nav}</div>
      );
    }
    return (
      <div className="screen"><div className="scroll">
        <Head title={keys.label} onBack={() => open('wallet')} />
        {heading('Private keys')}
        <div style={{ display: 'flex', marginTop: 10 }}><span className="netchip" style={{ marginLeft: 0 }}>{MAINNET ? 'Monero' : 'Test network'}</span></div>
        <div className="keycard">
          <div className="k">Address</div>
          <div className="v" data-testid="keys-address">{keys.address}</div>
          <div className="acts"><button type="button" className="keyact" data-testid="keys-copy-address" onClick={() => copyKey('address', keys.address, false)}>{copiedKey === 'address' ? 'Copied' : 'Copy'}</button></div>
        </div>
        <div className="keycard">
          <div className="k">Private view key</div>
          <div className="v" data-testid="keys-view">{showView ? keys.viewKey : KEY_MASK}</div>
          <div className="acts">
            <button type="button" className="keyact" data-testid="keys-reveal-view" onClick={() => setShowView(!showView)}>{showView ? 'Hide' : 'Show'}</button>
            <button type="button" className="keyact" data-testid="keys-copy-view" onClick={() => copyKey('view', keys.viewKey, true)}>{copiedKey === 'view' ? 'Copied' : 'Copy'}</button>
          </div>
          <div className="kn">Sees money coming in, never spends. Safe for an accountant or a view-only wallet.</div>
        </div>
        {keys.viewOnly ? (
          <div className="keycard">
            <div className="k">Private spend key</div>
            <div className="kn" data-testid="keys-spend-none">Not on this device. This wallet is view-only.</div>
          </div>
        ) : (
          <div className="keycard">
            <div className="k">Private spend key</div>
            <div className="v" data-testid="keys-spend">{showSpend ? keys.spendKey : KEY_MASK}</div>
            <div className="acts">
              <button type="button" className="keyact" data-testid="keys-reveal-spend" onClick={() => setShowSpend(!showSpend)}>{showSpend ? 'Hide' : 'Show'}</button>
              <button type="button" className="keyact" data-testid="keys-copy-spend" onClick={() => copyKey('spend', keys.spendKey, true)}>{copiedKey === 'spend' ? 'Copied' : 'Copy'}</button>
            </div>
            <div className="kn warn">Anyone with this key can take everything in this wallet. Never paste it into a website.</div>
          </div>
        )}
        <div className="keycard">
          <div className="k">Start block</div>
          <div className="v" data-testid="keys-height">{keys.restoreHeight}</div>
        </div>
        <div className="snote">{PHONE ? "Copied keys leave your clipboard after a minute and don't sync to your other devices." : 'Clear your clipboard after you paste a key.'}</div>
      </div>{nav}</div>
    );
  }

  if (page === 'removewallet') {
    return (
      <div className="screen"><div className="scroll">
        <Head title="Wallet" onBack={() => open('wallet')} />
        {heading('Remove wallet')}
        <div className="lede">This deletes the wallet from this device. Its coins stay on the blockchain, and only its recovery words or keys can bring it back. Make sure you have them.</div>
        <div className="inline">
          <input type="password" data-testid="rm-password" placeholder="Your Walnero password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} />
          <Fold cols="1fr" items={[{ label: busy ? 'Removing' : 'Remove wallet', id: 'rm-go', disabled: busy || !pass, onClick: () => run(async () => {
            const wasActive = wid === wallets?.active;
            await call('removeWallet', { id: wid, password: pass });
            if (wasActive) { onSwitched(); return; }
            await loadWallets();
            open('wallets');
          }) }]} />
        </div>
        {error && <div className="error" data-testid="rm-error">{error}</div>}
      </div>{nav}</div>
    );
  }

  if (page === 'security') {
    return (
      <div className="screen"><div className="scroll">
        {back}
        {heading('Security & Privacy')}
        {PHONE && bioState?.available && (
          <div className="sgroup">
            <Row icon="scan-smiley" title={kind} sub="Two tries, then your password" testid="set-faceid"
              end={<Toggle on={bioState.enabled || bioPass !== null} label={kind} disabled={busy} onChange={(on) => (on ? setBioPass('') : run(async () => { setBioPass(null); await bio.disable(); setBio(await bio.status()); }))} />} />
          </div>
        )}
        {bioPass !== null && !bioState?.enabled && (
          <div className="inline">
            <input type="password" data-testid="faceid-password" placeholder="Your Walnero password" autoFocus value={bioPass} onChange={(e) => setBioPass(e.target.value)} />
            <Fold cols="1fr" items={[{ label: busy ? 'Turning on' : `Turn on ${kind}`, hit: true, id: 'faceid-confirm', disabled: busy || !bioPass, onClick: () => run(async () => {
              await call('checkPassword', { password: bioPass });
              const r = await bio.enable(bioPass);
              if (!r.ok && r.error !== 'cancel') throw new Error(`${kind} couldn't be turned on.`);
              setBioPass(null); setBio(await bio.status());
            }) }]} />
          </div>
        )}
        <div className="sgroup">
          <Row icon="timer" title="Auto-lock" sub="Locks after no taps for this long" end={<span className="v">{prefs.autoLock < 60 ? `${prefs.autoLock} min` : '1 hour'}</span>} />
        </div>
        <div className="seg four">
          {[1, 5, 15, 60].map((m) => <button type="button" key={m} data-testid={`lock-${m}`} className={prefs.autoLock === m ? 'on' : ''} onClick={() => updatePrefs({ autoLock: m })}><span>{m < 60 ? `${m} min` : '1 hour'}</span></button>)}
        </div>
        <div className="sgroup">
          <Row icon="key" title="Recovery words" sub="Shown after your password" end={more()} onClick={() => open('words')} testid="set-words" />
          <Row icon="lock-simple" title="Change password" end={more()} onClick={() => open('password')} testid="set-password" />
        </div>
        {error && <div className="error">{error}</div>}
        <div className="snote">Your words and keys never leave this {PHONE ? 'phone' : 'computer'}. Walnero's servers only send public blockchain data.</div>
      </div>{nav}</div>
    );
  }

  if (page === 'words') {
    return (
      <div className="screen"><div className="scroll">
        <Head title="Security & Privacy" onBack={() => open('security')} />
        {heading('Recovery words')}
        {words ? (
          <>
            {showMonero ? (
              <>
                <div className="lede" style={{ fontSize: 13 }}>The same Monero wallet written as 25 words, for Monero-only apps like Feather. Your 12 words stay the backup for everything.</div>
                <WordGrid words={moneroWords} testid="reveal-monero" />
              </>
            ) : (
              <>
                <div className="lede" style={{ fontSize: 13 }}>Anyone with these {wordCount(words)} words can take your coins. Write them down somewhere safe and never type them into a website.</div>
                <WordGrid words={words} testid="reveal-seed" />
              </>
            )}
            {moneroWords && <button type="button" className="linkish" data-testid="toggle-monero-words" onClick={() => setShowMonero(!showMonero)}>{showMonero ? 'Show my 12 words' : 'Show the 25 Monero words'}</button>}
            <div style={{ marginTop: 16 }}><Fold cols="1fr" items={[{ label: 'Hide them', hit: true, id: 'hide-words', onClick: () => open('security') }]} /></div>
          </>
        ) : (
          <>
            <div className="lede">Make sure nobody can see your screen, then type your password.</div>
            <div className="inline">
              <input type="password" data-testid="words-password" placeholder="Your Walnero password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && pass) (e.currentTarget.nextElementSibling?.querySelector('button') as HTMLButtonElement)?.click(); }} />
              <Fold cols="1fr" items={[{ label: busy ? 'Checking' : 'Show my words', hit: true, id: 'show-words', disabled: busy || !pass, onClick: () => run(async () => { const r = await call('revealSeed', { password: pass }); setPass(''); setWords(r.seed); setMoneroWords(r.monero ?? ''); }) }]} />
            </div>
            {error && <div className="error" data-testid="words-error">{error}</div>}
          </>
        )}
      </div>{nav}</div>
    );
  }

  if (page === 'password') {
    return (
      <div className="screen"><div className="scroll">
        <Head title="Security & Privacy" onBack={() => open('security')} />
        {heading('Change password')}
        <div className="lede">It locks Walnero on this {PHONE ? 'phone' : 'computer'}. Your recovery words stay the same.</div>
        <div className="inline">
          <input type="password" data-testid="pw-current" placeholder="Current password" value={pass} onChange={(e) => setPass(e.target.value)} />
          <input type="password" data-testid="pw-new" placeholder="New password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
          <input type="password" data-testid="pw-again" placeholder="New password again" value={pass3} onChange={(e) => setPass3(e.target.value)} />
          <Fold cols="1fr" items={[{ label: busy ? 'Changing' : 'Change password', hit: true, id: 'pw-go', disabled: busy || !pass || !pass2 || !pass3, onClick: () => run(async () => {
            if (pass2.length < 8) throw new Error('Use at least 8 characters');
            if (pass2 !== pass3) throw new Error("The new passwords don't match");
            await call('changePassword', { current: pass, next: pass2 });
            if (bioState?.enabled) {
              const r = await bio.enable(pass2);
              if (!r.ok) await bio.disable();
              setBio(await bio.status());
            }
            setPass(''); setPass2(''); setPass3('');
            setDone('Password changed. Use the new one from now on.');
          }) }]} />
        </div>
        {error && <div className="error" data-testid="pw-error">{error}</div>}
        {done && <div className="snote" style={{ color: 'var(--up)' }} data-testid="pw-done">{done}</div>}
      </div>{nav}</div>
    );
  }

  if (page === 'network') {
    return (
      <div className="screen"><div className="scroll">
        {back}
        {heading('Network')}
        <div className="sgroup">
          <Row icon="globe-hemisphere-west" title={MAINNET ? 'Monero' : 'Test network'} sub={MAINNET ? 'Real network' : 'Stagenet, coins with no value'} end={<span className="v" data-testid="net-status">{status}</span>} />
          <Row icon="hard-drives" title="Node" sub={home?.node ? `${nodeName(home.node, nodes?.custom.find((c) => c.url === home.node))}, ${nodeHost(home.node)}` : 'Picking the fastest'} end={more(nodes && nodes.mode !== 'auto' ? 'Chosen' : 'Auto')} onClick={() => open('node')} testid="set-node" />
          <Row icon="lightning" title="Fast open" sub={`Walnero feed, checked against ${NETWORK.nodes.length} server${NETWORK.nodes.length === 1 ? '' : 's'}`} end={<Toggle on={prefs.fastOpen} label="Fast open" onChange={(on) => updatePrefs({ fastOpen: on })} />} />
          <Row icon="cube" title="Block" sub={<span data-testid="height">{home?.target ? `${home.height.toLocaleString('en-US')} of ${home.target.toLocaleString('en-US')}` : 'Checking'}</span>} />
        </div>
        {!prefs.fastOpen && <div className="snote">Fast open is off. Next time Walnero opens, it reads the chain the normal way.</div>}
        <div style={{ marginTop: 16 }}><Fold cols="1fr" items={[{ label: home?.full?.running ? 'Checking' : 'Run a full check', id: 'full-check', disabled: busy || !home?.ready || home?.phase === 'slow' || Boolean(home?.full?.running), onClick: () => run(async () => { await call('fullCheck'); }) }]} /></div>
        {home?.full && !home.full.running && <div className="snote" data-testid="full-result">{home.full.error ? `That didn't finish: ${home.full.error}` : home.full.before === home.full.after ? 'Full check finished. Everything matched.' : `Full check finished. Your balance went from ${trim4(home.full.before)} to ${trim4(home.full.after)} XMR.`}</div>}
        {error && <div className="error">{error}</div>}
        <div className="snote">A full check reads every block since your wallet began, without the fast feed. Slow, and nothing can hide from it. Send pauses until it's done.</div>
      </div>{nav}</div>
    );
  }

  if (page === 'node') {
    const auto = !nodes || nodes.mode === 'auto';
    const current: string | null = home?.node || nodes?.current || null;
    const custom = nodes?.custom ?? [];
    const list = nodes ? [...nodes.builtin, ...custom.map((c) => c.url)] : [];
    list.sort((a, b) => (a === current ? -1 : b === current ? 1 : 0));
    const choose = (url: string) => run(async () => { await call('useNode', { url }); await loadNodes(); });
    return (
      <div className="screen"><div className="scroll">
        <Head title="Network" onBack={() => open('network')} />
        <div className="node-top">
          {heading('Node')}
          <div className="node-acts">
            <button type="button" className="mini" aria-label="Test the nodes again" data-testid="node-retest" onClick={() => { testNodes(); }}>{icon('arrows-clockwise')}</button>
            <button type="button" className="mini" aria-label="Add a node" data-testid="node-add" onClick={() => open('addnode')}>{icon('plus')}</button>
          </div>
        </div>
        <div className="lede" style={{ fontSize: 13.5 }}>Walnero reads the blockchain and sends payments through a Monero node. A node never gets your keys or sees your balance. It can see your IP address and when you send, so use one you trust, or run your own.</div>
        <div className="sgroup">
          <Row icon="lightning" title="Automatic" testid="node-auto" sub={auto ? (current ? `Using ${nodeName(current)}, the fastest that answered` : 'Finding the fastest') : 'Use the fastest healthy node'}
            end={<Toggle on={auto} label="Automatic" disabled={busy || !nodes} onChange={(on) => choose(on ? 'auto' : (current ?? list[0] ?? 'auto'))} />} />
        </div>
        <div className="nodes" data-testid="node-list">
          {list.map((url) => {
            const c = checks?.[url]; const mine = custom.find((x) => x.url === url); const bars = nodeBars(c); const isCurrent = url === current;
            return (
              <div key={url} className={`nrow ${isCurrent ? 'cur' : ''}`}>
                <button type="button" className="nmain" data-testid={`node-${nodeHost(url)}`} disabled={busy} onClick={() => { if (!isCurrent || auto) choose(url); }}>
                  <span className="ncheck">{isCurrent ? icon('check') : null}</span>
                  <span className="ntxt">
                    <span className="nn">{nodeName(url, mine)}{!mine && <i className="vb" aria-label="Built in">{icon('seal-check')}</i>}{mine?.trusted && <em className="ntag">Trusted</em>}</span>
                    <span className="na">{nodeHost(url)}</span>
                  </span>
                  <span className="nstat">
                    {!checks ? <span className="ms">Testing</span> : c?.ok
                      ? <><span className={`sig s${bars}`}><i /><i /><i /></span><span className="ms">{c.ms} ms</span></>
                      : <span className="ndown">{c?.error ?? 'Not answering'}</span>}
                  </span>
                </button>
                {mine && <button type="button" className="nrm" data-testid={`node-remove-${nodeHost(url)}`} disabled={busy} onClick={() => run(async () => { await call('removeNode', { url }); await loadNodes(); testNodes(); })}>Remove</button>}
              </div>
            );
          })}
        </div>
        {error && <div className="error" data-testid="node-error">{error}</div>}
        <div className="snote">{prefs.fastOpen ? 'Fast open also checks its quick feed against a few other public nodes. Turn Fast open off in Network to sync only through the node you pick.' : 'Fast open is off, so your wallet syncs only through the node you pick.'}</div>
      </div>{nav}</div>
    );
  }

  if (page === 'addnode') {
    const add = () => run(async () => {
      const raw = form.address.trim();
      if (!raw) throw new Error('Type the node address');
      let u: URL;
      try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `${form.ssl ? 'https' : 'http'}://${raw}`); } catch { throw new Error("That address doesn't look right. Try node.example.com"); }
      if (form.port.trim()) u.port = form.port.replace(/\D/g, '');
      if (PHONE && u.protocol !== 'https:') throw new Error('On iPhone a node has to use SSL. Turn on Use SSL, or use an https address.');
      // Chrome asks the person once before Walnero may talk to a site it doesn't know.
      const permissions = (globalThis as any).chrome?.permissions;
      if (!PHONE && permissions?.request && !(await permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] }))) throw new Error('Walnero needs your OK in Chrome to talk to that node.');
      await call('addNode', { url: `${u.protocol}//${u.host}`, label: form.label, trusted: form.trusted }).catch((e: any) => {
        const text = String(e?.message ?? e);
        throw new Error(PHONE && /Couldn't reach|didn't answer/.test(text) ? `${text} On iPhone the node also has to allow apps to connect to it.` : text);
      });
      setForm({ label: '', address: '', port: '', ssl: true, trusted: false });
      open('node');
    });
    return (
      <div className="screen"><div className="scroll">
        <Head title="Node" onBack={() => open('node')} />
        {heading('Add a node')}
        <div className="inline">
          <input data-testid="an-label" placeholder="Name, like My node (optional)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          <input data-testid="an-address" placeholder="Address, like node.example.com" spellCheck={false} autoCapitalize="off" autoCorrect="off" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          <input data-testid="an-port" inputMode="numeric" placeholder="Port, like 18089 (optional)" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value.replace(/\D/g, '').slice(0, 5) })} />
        </div>
        <div className="sgroup">
          <Row icon="lock-simple" title="Use SSL" sub="On for https nodes, which is most public ones" end={<Toggle on={form.ssl} label="Use SSL" onChange={(on) => setForm({ ...form, ssl: on })} />} testid="an-ssl" />
          <Row icon="shield-check" title="Trusted" sub="Only for a node you run yourself. It skips some safety checks to sync faster." end={<Toggle on={form.trusted} label="Trusted" onChange={(on) => setForm({ ...form, trusted: on })} />} testid="an-trusted" />
        </div>
        <div style={{ marginTop: 16 }}><Fold cols="1fr" items={[{ label: busy ? 'Testing it' : 'Test and use', hit: true, id: 'an-go', disabled: busy || !form.address.trim(), onClick: add }]} /></div>
        {error && <div className="error" data-testid="an-error">{error}</div>}
        <div className="snote">{PHONE ? 'On iPhone, a node has to use SSL and allow apps to connect to it. Many home nodes need that switched on first. Tor nodes aren\'t supported yet.' : 'Chrome asks once for permission to talk to the node. Tor nodes aren\'t supported yet.'}</div>
      </div>{nav}</div>
    );
  }

  if (page === 'developer') {
    return (
      <div className="screen"><div className="scroll">
        {back}
        {heading('Developer settings')}
        <div className="lede">For trying things out. Nothing here touches your real Monero.</div>
        {PHONE && (
          <>
            <div className="sgroup">
              <Row icon="code" title="Test network" sub="Balances and sends use free test coins" testid="set-testnet"
                end={<Toggle on={!MAINNET} label="Test network" onChange={(on) => switchNet(on ? 'stagenet' : 'mainnet')} />} />
            </div>
            <div className="seg">
              <button type="button" className={MAINNET ? '' : 'on'} disabled={MAINNET}><span>Stagenet</span></button>
              <button type="button" disabled><span>Testnet, later</span></button>
            </div>
            {!MAINNET && <Faucet state={faucet} onClaim={onClaim} />}
          </>
        )}
        <div className="sgroup">
          <Row icon="lightning" title="Open speed" sub={<span className="speed" data-testid="open-speed">{speed ? speedText(speed) : 'Measuring this open'}</span>} end={<span>{speed && !speed.fast ? 'Normal sync' : ''}</span>} />
          <Row icon="timer" title="Show timings on Home" sub="For checking instant open" end={<Toggle on={prefs.timings} label="Show timings on Home" onChange={(on) => updatePrefs({ timings: on })} />} />
        </div>
        <div className="snote">Test coins have no value and can't be sent to real Monero. Your real wallet stays as it is while this is on.</div>
      </div>{nav}</div>
    );
  }

  if (page === 'help') {
    return (
      <div className="screen"><div className="scroll">
        {back}
        {heading('Help')}
        <div className="qa">{HELP.map(([q, a]) => <div key={q}><h4>{q}</h4><p>{a}</p></div>)}</div>
      </div>{nav}</div>
    );
  }

  return (
    <div className="screen"><div className="scroll">
      <div className="title" style={{ fontSize: 36, marginTop: 8 }}>Settings</div>
      <div className="who">
        <span className="avatar"><img src="/brand/w-ink.png" alt="" /></span>
        <div style={{ minWidth: 0 }}>
          <div className="n">{activeWallet?.label || (MAINNET ? 'Main wallet' : 'Test wallet')}</div>
          <button type="button" className="a" data-testid="copy-main" onClick={async () => { if (!address) return; await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1400); }}>
            {copied ? 'Copied' : address ? shortAddr(address) : 'Getting your address'} {icon(copied ? 'check' : 'copy')}
          </button>
        </div>
        <span className="netchip" data-testid="network">{MAINNET ? 'Monero' : 'Test network'}</span>
      </div>
      <div className="sgroup">
        <Row icon="wallet" title="Wallets" sub="Switch, add or remove wallets" end={more(wallets ? String(wallets.list.length) : '')} onClick={() => open('wallets')} testid="set-wallets" />
        <Row icon="shield-check" title="Security & Privacy" sub={`${PHONE && bioState?.available ? `${kind}, ` : ''}recovery words, auto-lock`} end={more()} onClick={() => open('security')} testid="set-security" />
        <Row icon="at" title="Names" sub="Addresses you saved, like @kestrel" end={more(names == null ? '' : String(names))} onClick={onNames} testid="set-names" />
      </div>
      <div className="sgroup">
        <Row icon="globe-hemisphere-west" title="Network" sub="Servers, fast open, full check" end={more(MAINNET ? 'Monero' : 'Test')} onClick={() => open('network')} testid="set-network" />
        <Row icon="code" title="Developer settings" sub={PHONE ? 'Test network, open speed' : 'Open speed, timings'} end={more(PHONE ? (MAINNET ? 'Off' : 'On') : '')} onClick={() => open('developer')} testid="set-developer" />
      </div>
      <div className="sgroup">
        <Row icon="question" title="Help" end={more()} onClick={() => open('help')} testid="set-help" />
        <Row icon="info" title="About Walnero" end={<span>{APP_VERSION}</span>} />
      </div>
      <div style={{ marginTop: 18 }}><Fold cols="1fr" items={[{ label: 'Lock Walnero', id: 'lock', onClick: onLock }]} /></div>
    </div>{nav}</div>
  );
}

// Addresses saved under a name. Sentence style like Send: "Save <address> as @name".
function NamesScreen({ nav, onSend }: { nav: ReactNode; onSend: (name: string) => void }) {
  const [list, setList] = useState<SavedName[] | null>(null);
  const [mode, setMode] = useState<'list' | 'add' | SavedName>('list');
  const [name, setName] = useState(''); const [addr, setAddr] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(() => call<SavedName[]>('names').then(setList).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true); setError('');
    try { await call('saveName', { name, address: addr }); await load(); setMode('list'); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  if (mode === 'add') {
    return (
      <div className="screen">
        <Head title="New name" onBack={() => { setError(''); setMode('list'); }} />
        <div className="word in" style={{ marginTop: 8 }}>Save</div>
        <textarea className="addr in" style={{ ['--d' as string]: 1 }} data-testid="name-address" placeholder={`Paste a ${NETWORK_WORDS} address`} autoFocus spellCheck={false} value={addr} onChange={(e) => { setAddr(e.target.value.trim()); setError(''); }} />
        <div className="word in" style={{ ['--d' as string]: 2 }}>as</div>
        <label className={`chip pop-in ${name ? 'hit' : ''}`}><span>@</span><input data-testid="name-input" placeholder="name" spellCheck={false} autoComplete="off" value={name} onChange={(e) => { setName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase().slice(0, 20)); setError(''); }} onKeyDown={(e) => { if (e.key === 'Enter' && name && addr) save(); }} /></label>
        {error && <div className="error" data-testid="name-error">{error}</div>}
        <div className="grow" />
        <div style={{ paddingBottom: 22 }}><Fold cols="1fr" items={[{ label: busy ? 'Saving' : 'Save name', hit: true, id: 'name-save', disabled: busy || !name || !addr, onClick: save }]} /></div>
      </div>
    );
  }

  if (typeof mode === 'object') {
    return (
      <div className="screen">
        <Head title="Names" onBack={() => setMode('list')} />
        <div className="name-big in" data-testid="name-title">@{mode.name}</div>
        <div className="full in" style={{ ['--d' as string]: 1 }}>{mode.address}</div>
        <div className="note in" style={{ ['--d' as string]: 2, marginTop: 10 }}>Saved on this device only. Nobody else can look this name up.</div>
        <div className="grow" />
        <div style={{ display: 'grid', gap: 9, paddingBottom: 22 }}>
          <Fold cols="1fr" items={[{ label: `Send to @${mode.name}`, hit: true, id: 'name-send', onClick: () => onSend(mode.name) }]} />
          <Fold cols="1fr" items={[{ label: 'Remove', id: 'name-remove', onClick: async () => { await call('removeName', { name: mode.name }); setMode('list'); load(); } }]} />
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="title" style={{ fontSize: 36, marginTop: 8 }}>Names</div>
      <div className="note" style={{ marginTop: 6 }}>Addresses you've saved under a name, so you can send without pasting.</div>
      <div className="stack" data-testid="names" style={{ overflow: 'auto', maxHeight: 318, paddingBottom: 4 }}>
        {list?.length ? list.map((n, i) => (
          <button className="slip row-button" key={n.name} data-testid={`name-row-${n.name}`} style={{ ['--i' as string]: Math.min(i, 5), ['--tone' as string]: TONES[Math.min(i, 5)], zIndex: 10 - Math.min(i, 9) }} onClick={() => setMode(n)}>
            <div className="glyph at">@</div><div><div className="name">@{n.name}</div><div className="note">{shortAddr(n.address)}</div></div><div className="end note">{icon('arrow-right')}</div>
          </button>
        )) : <div className="empty" data-testid="names-empty">{list ? 'No names yet. Save an address as @kestrel and it shows up when you send.' : 'Loading'}</div>}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="grow" />
      <div style={{ paddingBottom: 76 }}><Fold cols="1fr" items={[{ label: 'Add a name', hit: true, id: 'name-add', onClick: () => { setName(''); setAddr(''); setError(''); setMode('add'); } }]} /></div>
      {nav}
    </div>
  );
}

function PasswordScreen({ onSubmit, busy, error, Head }: any) {
  const [a, setA] = useState(''); const [b, setB] = useState(''); const [note, setNote] = useState('');
  return (
    <form className="screen" onSubmit={(e) => { e.preventDefault(); if (a.length < 8) return setNote('Use at least 8 characters'); if (a !== b) return setNote("Those passwords don't match"); setNote(''); onSubmit(a); }}>
      <Head title="New wallet" back="welcome" />
      <div className="title" style={{ marginTop: 22 }}>Pick a password.</div>
      <div className="lede">It locks Walnero on this device. It can't be reset, so keep it safe.</div>
      <input style={{ marginTop: 18 }} data-testid="password" type="password" placeholder="Password" autoFocus value={a} onChange={(e) => setA(e.target.value)} />
      <input style={{ marginTop: 8 }} data-testid="password2" type="password" placeholder="Same password again" value={b} onChange={(e) => setB(e.target.value)} />
      {(note || error) && <div className="error">{note || error}</div>}
      <div className="grow" />
      <div style={{ paddingBottom: 26 }}><div className="fold"><button className="sk hit" data-testid="password-go" disabled={busy}><span>{busy ? 'Making your wallet' : 'Continue'}</span></button></div></div>
    </form>
  );
}

function RestoreScreen({ onSubmit, busy, error, Head }: any) {
  const [seed, setSeed] = useState(''); const [password, setPassword] = useState(''); const [height, setHeight] = useState(''); const [note, setNote] = useState('');
  // Like Cake Wallet's restore: from the recovery words, or from keys (address and view key, spend key optional).
  const [useKeys, setUseKeys] = useState(false);
  const [ik, setIk] = useState({ address: '', viewKey: '', spendKey: '' });
  const keyInput = (name: 'viewKey' | 'spendKey', placeholder: string) => <input style={{ marginTop: 8 }} data-testid={`restore-${name === 'viewKey' ? 'view' : 'spend'}`} placeholder={placeholder} spellCheck={false} autoCapitalize="off" autoCorrect="off" value={ik[name]} onChange={(e) => setIk({ ...ik, [name]: e.target.value.trim() })} />;
  return (
    <form className="screen" onSubmit={(e) => { e.preventDefault(); if (password.length < 8) return setNote('Use a password of at least 8 characters'); if (useKeys && (!ik.address.trim() || !ik.viewKey)) return setNote('Paste the address and the private view key'); setNote(''); onSubmit(useKeys ? ik : { seed }, password, height ? Number(height) : undefined); }}>
      <Head title="Restore" back="welcome" />
      <div className="title" style={{ fontSize: 36, marginTop: 16 }}>{useKeys ? 'Enter your keys.' : 'Enter your recovery words.'}</div>
      {useKeys ? (
        <>
          <textarea style={{ marginTop: 14, height: 84 }} data-testid="restore-address" placeholder={`Main address (starts with ${MAINNET ? '4' : '5'})`} spellCheck={false} autoCapitalize="off" autoCorrect="off" autoFocus value={ik.address} onChange={(e) => setIk({ ...ik, address: e.target.value })} />
          {keyInput('viewKey', 'Private view key')}
          {keyInput('spendKey', 'Private spend key (empty for view-only)')}
        </>
      ) : (
        <textarea style={{ marginTop: 14, height: 112 }} data-testid="restore-seed" placeholder="Your 12 or 25 words, separated by spaces" spellCheck={false} autoCapitalize="off" autoCorrect="off" autoFocus value={seed} onChange={(e) => setSeed(e.target.value)} />
      )}
      <button type="button" className="linkish" data-testid="restore-switch" onClick={() => { setUseKeys(!useKeys); setNote(''); }}>{useKeys ? 'Use recovery words instead' : 'Use keys instead'}</button>
      <input style={{ marginTop: 8 }} data-testid="restore-password" type="password" placeholder="New password for this device" value={password} onChange={(e) => setPassword(e.target.value)} />
      <input style={{ marginTop: 8 }} data-testid="restore-height" inputMode="numeric" placeholder="Start from block (optional, faster)" value={height} onChange={(e) => setHeight(e.target.value.replace(/\D/g, ''))} />
      {(note || error) && <div className="error" data-testid="restore-error">{note || error}</div>}
      <div className="grow" />
      <div style={{ paddingBottom: 22 }}><div className="fold"><button className="sk hit" data-testid="restore-go" disabled={busy}><span>{busy ? 'Restoring' : 'Restore wallet'}</span></button></div></div>
    </form>
  );
}

// With Face ID on, the lock screen asks for a face as soon as it shows. Two misses (iOS's own rule) or "Use Password" bring
// the password field back.
function LockedScreen({ onSubmit, busy, error, bio: b, onBio }: any) {
  const [password, setPassword] = useState('');
  const [typing, setTyping] = useState(!b?.enabled);
  const started = useRef(false);
  const tryBio = () => onBio().then((ok: boolean) => { if (!ok) setTyping(true); });
  useEffect(() => { if (b?.enabled && !started.current) { started.current = true; tryBio(); } }, [b?.enabled]);
  return (
    <form className="screen" onSubmit={(e) => { e.preventDefault(); if (typing) onSubmit(password); else tryBio(); }}>
      <div className="center fade-in"><img className="lock-w sweep" src="/brand/w-sky.png" alt="" style={{ width: 92, height: 'auto', marginBottom: 22 }} /><div className="title">Welcome back.</div>
        {typing && <input style={{ marginTop: 18 }} data-testid="unlock-password" type="password" placeholder="Password" autoFocus={!b?.enabled} value={password} onChange={(e) => setPassword(e.target.value)} />}
        {error && <div className="error" data-testid="unlock-error">{error}</div>}
      </div>
      <div style={{ display: 'grid', gap: 9, paddingBottom: 26 }}>
        <div className="fold"><button className="sk hit" data-testid="unlock-go" disabled={busy}><span>{busy ? 'Unlocking' : typing ? 'Unlock' : `Unlock with ${b.kind}`}</span></button></div>
        {b?.enabled && <div className="fold"><button type="button" className="sk" data-testid={typing ? 'use-faceid' : 'use-password'} onClick={() => (typing ? tryBio() : setTyping(true))}><span>{typing ? `Use ${b.kind}` : 'Use password'}</span></button></div>}
      </div>
    </form>
  );
}

// OpenAlias: the name typed, who it says it is, whether DNSSEC vouched for the answer, and the address it gave.
function AliasCard({ alias }: { alias: Alias }) {
  return (
    <div className="alias fade-in" data-testid="alias-found">
      <div className="who"><b data-testid="alias-title">{alias.title || alias.name}</b><span className={alias.secure ? 'ok' : 'warn'} data-testid="alias-check">{alias.secure ? <>{icon('seal-check')} Verified by DNSSEC</> : 'Not DNSSEC verified'}</span></div>
      {!alias.secure && <div className="warnline">Anyone between you and {alias.name.split('@').pop()} could have changed this answer. Check the address with them before sending.</div>}
    </div>
  );
}

// A 25-word or view-only wallet has no Bitcoin. Says why, and how to get it.
function NeedsPhrase({ why }: { why: string }) {
  return (
    <div className="empty needs" data-testid="btc-blocked">
      {why === 'viewonly'
        ? 'View-only wallets show Monero only.'
        : <>This wallet's 25 Monero words hold only Monero. Bitcoin comes with wallets made with 12 words.<br /><br />To get it, add a new wallet in Settings, Wallets. It gets 12 words that hold both, and you can send your Monero over.</>}
    </div>
  );
}

function BtcReceiveScreen({ Head }: any) {
  const [address, setAddress] = useState(''); const [qr, setQr] = useState(''); const [copied, setCopied] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    call('btcReceive').then(async (r) => { setAddress(r.address); setQr(await QRCode.toDataURL(r.address, { margin: 0, width: 320, errorCorrectionLevel: 'M' })); }).catch((e) => setError(e.message));
  }, []);
  return (
    <div className="screen">
      <Head title="Bitcoin" back="btc" />
      <div className="title" style={{ fontSize: 36, marginTop: 12 }}>Get paid in Bitcoin.</div>
      <div className="qr fade-in">{qr && <img data-testid="btc-qr" src={qr} alt="QR code of your Bitcoin address" />}</div>
      <div className="full" data-testid="btc-address">{address}</div>
      {error && <div className="error" data-testid="btc-receive-error">{error}</div>}
      <div className="note" style={{ marginTop: 8 }}>Only send {MAINNET ? 'Bitcoin (BTC)' : 'testnet4 Bitcoin'} to this address. Bitcoin is public, so anyone with it can see what it receives. You get a fresh one after it's paid.</div>
      {address && !MAINNET && <a data-testid="btc-faucet" style={{ marginTop: 8, fontSize: 13, color: 'var(--mid)' }} href="https://mempool.space/testnet4/faucet" target="_blank" rel="noreferrer">Get free test Bitcoin</a>}
      <div className="grow" />
      <div style={{ paddingBottom: 22 }}><div className="fold"><button className="sk hit" data-testid="btc-copy" disabled={!address} onClick={async () => { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500); }}><span>{copied ? 'Copied' : 'Copy address'}</span></button></div></div>
    </div>
  );
}

// Speeds, like most Bitcoin wallets: the network fee decides how soon a block picks the payment up.
type Speed = 'slow' | 'normal' | 'fast';
const SPEED_WORDS: Record<Speed, string> = { slow: 'Slow', normal: 'Normal', fast: 'Fast' };
interface SpeedChoice { key: string; label: string; time: string; note: string }
function Speeds({ list, value, onPick, disabled, testid }: { list: SpeedChoice[]; value: string; onPick: (key: string) => void; disabled?: boolean; testid: string }) {
  return (
    <div className="speeds" data-testid={testid}>
      {list.map((f) => (
        <button type="button" key={f.key} className={`spd ${value === f.key ? 'on' : ''}`} data-testid={`speed-${f.key}`} aria-pressed={value === f.key} disabled={disabled} onClick={() => onPick(f.key)}>
          <b>{f.label}</b><span>{f.time}</span><em>{f.note}</em>
        </button>
      ))}
    </div>
  );
}
// Monero's fee levels, as Cake Wallet offers them. Blocks are rarely full, so Auto almost always makes the next block.
const XMR_SPEEDS: SpeedChoice[] = [
  { key: 'auto', label: 'Auto', time: 'Next block', note: 'Lowest fee' },
  { key: 'medium', label: 'Medium', time: 'When busy', note: 'About 4x fee' },
  { key: 'fast', label: 'Fast', time: 'First in line', note: 'About 10x fee' },
];

function BtcSendScreen({ Head, btc, hidden, market: m, onSent }: any) {
  const [amount, setAmount] = useState('');
  const [all, setAll] = useState(false);
  const [to, setTo] = useState('');
  const [speed, setSpeed] = useState<Speed>('normal');
  const [fees, setFees] = useState<{ speed: Speed; rate: number; time: string }[] | null>(null);
  const [alias, setAlias] = useState<Alias | null>(null);
  const [review, setReview] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  useEffect(() => { call('btcFees').then(setFees).catch((e) => setError(e.message)); }, []);
  const edit = () => { setReview(null); setError(''); };
  const plain = amount.replace(/\.$/, '');
  const isAlias = looksLikeAlias(to);
  const ready = (to.trim().length >= 26 || isAlias) && (all || Number(plain) > 0);
  const check = async () => {
    setBusy(true); setError('');
    try {
      let address = alias?.address ?? to.trim();
      if (isAlias && !alias) { const found = await call<Alias>('resolveAlias', { name: to.trim(), coin: 'btc' }); setAlias(found); address = found.address; }
      setReview(await call('btcEstimate', { address, amount: all ? 'all' : plain, speed }));
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const send = async () => {
    setSending(true); setError('');
    try {
      const [r] = await Promise.all([call('btcSend', { review: review?.review }), wait(900)]);
      onSent({ hash: r.hash, amount: r.amount, fee: r.fee, to: alias ? alias.name : shortAddr(r.to), time: review.time });
    } catch (e: any) {
      setError(e.message); setReview(null); setSending(false);
    }
  };
  const list: SpeedChoice[] = (fees ?? (['slow', 'normal', 'fast'] as Speed[]).map((s) => ({ speed: s, rate: 0, time: '' }))).map((f) => ({ key: f.speed, label: SPEED_WORDS[f.speed], time: f.time.replace('About ', '~').replace(' minutes', ' min'), note: f.rate ? `${f.rate} sat/vB` : '...' }));
  return (
    <div className="screen"><div className="scroll">
      <Head title="Bitcoin" back="btc" />
      <div className="title" style={{ fontSize: 34, marginTop: 10 }}>Send Bitcoin</div>
      <div className="inline">
        <div className="amtfield">
          <img src="/coins/btc.png" alt="" />
          <input data-testid="btc-amount" inputMode="decimal" autoComplete="off" placeholder="0.00" value={all ? 'Everything' : amount} readOnly={all || sending}
            onFocus={() => { if (all) { setAll(false); edit(); } }} onChange={(e) => { setAmount(e.target.value.replace(',', '.').replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').replace(/^(\d*\.\d{0,8}).*$/, '$1')); edit(); }} />
          <span className="unit">BTC</span>
          <button type="button" className={`maxb ${all ? 'on' : ''}`} data-testid="btc-max" disabled={sending} onClick={() => { setAll(!all); edit(); }}>Max</button>
        </div>
        <div className="amt-facts"><span data-testid="btc-available">{hidden ? STARS : btcAmount(btc?.balance ?? '0.00')} BTC available</span>{m && !all && Number(plain) > 0 && <span>{usd(Number(plain) * m.price)}</span>}</div>
        <textarea className="addr" data-testid="btc-to" placeholder={`Bitcoin address (${MAINNET ? 'bc1' : 'tb1'}...) or a name like donate.getmonero.org`} spellCheck={false} autoCapitalize="off" autoCorrect="off" value={to} readOnly={sending} onChange={(e) => { setTo(e.target.value.replace(/\s+/g, '')); setAlias(null); edit(); }} />
        {alias && <><AliasCard alias={alias} /><div className="addr-line" data-testid="btc-to-full">{alias.address}</div></>}
        {PHONE && !to && <div className="chips"><button className="paste" data-testid="btc-paste" onClick={async () => { try { setTo((await navigator.clipboard.readText()).trim()); edit(); } catch { setError('Copy the address first, then tap Paste.'); } }}>Paste address</button></div>}
      </div>
      <div className="sec"><h3>Speed</h3></div>
      <Speeds list={list} value={speed} disabled={sending} onPick={(k) => { setSpeed(k as Speed); edit(); }} testid="btc-speeds" />
      {review && !sending && (
        <div className="facts" data-testid="btc-review">
          <div className="in"><span>To</span><b>{shortAddr(review.to)}</b></div>
          <div className="in" style={{ ['--d' as string]: 1 }}><span>Amount</span><b data-testid="btc-review-amount">{btcAmount(review.amount)} BTC</b></div>
          <div className="in" style={{ ['--d' as string]: 2 }}><span>Network fee</span><b data-testid="btc-fee">{btcAmount(review.fee)} BTC{m ? `, ${usd(Number(review.fee) * m.price)}` : ''}</b></div>
          <div className="in" style={{ ['--d' as string]: 3 }}><span>Arrives in</span><b>{review.time}</b></div>
        </div>
      )}
      {sending && <div className="sending fade-in" data-testid="btc-sending"><div className="lbl">Sending</div><div className="sbars">{Array.from({ length: 30 }, (_, i) => <i key={i} style={{ ['--i' as string]: i }} />)}</div></div>}
      {error && <div className="error" data-testid="btc-send-error">{error}</div>}
      {!sending && (
        <div style={{ marginTop: 18, paddingBottom: 22 }}>
          {review
            ? <div className="in"><Slide label="Slide to send" onDone={send} /></div>
            : <div className="fold"><button className={`sk ${ready ? 'hit' : ''}`} data-testid="btc-review-go" disabled={busy || !ready} onClick={check}><span>{busy ? (isAlias && !alias ? 'Looking it up' : 'Checking') : 'Review'}</span></button></div>}
        </div>
      )}
    </div></div>
  );
}

function ReceiveScreen({ Head }: any) {
  const [address, setAddress] = useState(''); const [qr, setQr] = useState(''); const [copied, setCopied] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    call('receive').then(async (r) => { setAddress(r.address); setQr(await QRCode.toDataURL(r.address, { margin: 0, width: 320, errorCorrectionLevel: 'M' })); }).catch((e) => setError(e.message));
  }, []);
  return (
    <div className="screen">
      <Head title="Receive" back="home" />
      <div className="title" style={{ fontSize: 36, marginTop: 12 }}>Get paid.</div>
      <div className="qr fade-in">{qr && <img data-testid="qr" src={qr} alt="QR code of your address" />}</div>
      <div className="full" data-testid="address">{address}</div>
      {error && <div className="error">{error}</div>}
      <div className="note" style={{ marginTop: 8 }}>A new address each time, all going to the same wallet.</div>
      {address && !MAINNET && <a data-testid="faucet" style={{ marginTop: 8, fontSize: 13, color: 'var(--mid)' }} href={`https://cypherfaucet.com/xmr-stagenet?address=${address}`} target="_blank" rel="noreferrer">Get free test coins</a>}
      <div className="grow" />
      <div style={{ paddingBottom: 22 }}><div className="fold"><button className="sk hit" data-testid="copy" disabled={!address} onClick={async () => { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500); }}><span>{copied ? 'Copied' : 'Copy address'}</span></button></div></div>
    </div>
  );
}

const API = 'http://127.0.0.1:8790';
const COINS: Record<string, { name: string; ticker: string; network: string; logo: string }> = {
  'usdt-trx': { name: 'Tether', ticker: 'USDT', network: 'Tron', logo: 'usdt' },
  'usdt-eth': { name: 'Tether', ticker: 'USDT', network: 'Ethereum', logo: 'usdt' },
  'usdc-eth': { name: 'USD Coin', ticker: 'USDC', network: 'Ethereum', logo: 'usdc' },
  btc: { name: 'Bitcoin', ticker: 'BTC', network: 'Bitcoin', logo: 'btc' },
  eth: { name: 'Ethereum', ticker: 'ETH', network: 'Ethereum', logo: 'eth' },
  sol: { name: 'Solana', ticker: 'SOL', network: 'Solana', logo: 'sol' },
  ltc: { name: 'Litecoin', ticker: 'LTC', network: 'Litecoin', logo: 'ltc' },
};
const XMR = { name: 'Monero', ticker: 'XMR', network: 'Monero', logo: 'xmr' };
const short = (n: string | number, places = 6) => { const v = Number(n); return v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(Number(v.toPrecision(places))); };

// Live prices from the swap server. It can't start a swap yet: that needs real Monero, and this wallet is on the test network.
function SwapScreen({ Head }: any) {
  const [other, setOther] = useState('usdt-trx');
  const [buying, setBuying] = useState(true);
  const [amount, setAmount] = useState('');
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState<{ state: 'idle' | 'loading' | 'ok' | 'low' | 'none' | 'down'; best?: any; min?: string }>({ state: 'idle' });
  const turn = useRef(0);

  useEffect(() => {
    const mine = ++turn.current;
    if (!Number(amount)) { setQ({ state: 'idle' }); return; }
    setQ((was) => ({ ...was, state: 'loading' }));
    const wait = setTimeout(async () => {
      try {
        const [from, to] = buying ? [other, 'xmr'] : ['xmr', other];
        const res = await fetch(`${API}/api/quote?from=${from}&to=${to}&amount=${encodeURIComponent(amount)}`, { signal: AbortSignal.timeout(10000) });
        const body = await res.json();
        if (mine !== turn.current) return;
        if (res.ok && body.best) setQ({ state: 'ok', best: body.best });
        else if (res.ok && body.belowMin) setQ({ state: 'low', min: body.belowMin });
        else if (res.ok) setQ({ state: 'none' });
        else setQ({ state: 'down' });
      } catch {
        if (mine === turn.current) setQ({ state: 'down' });
      }
    }, 300);
    return () => clearTimeout(wait);
  }, [amount, other, buying]);

  const pay = buying ? COINS[other] : XMR;
  const get = buying ? XMR : COINS[other];
  const Coin = ({ coin }: { coin: typeof XMR }) => (coin === XMR
    ? <span className="coin-tag"><img src="/coins/xmr.png" alt="" /><b>XMR</b></span>
    : <button className="coin-tag pick" data-testid="pick-coin" onClick={() => setPicking(true)}><img src={`/coins/${coin.logo}.png`} alt="" /><b>{coin.ticker}</b>{icon('caret-left')}</button>);

  if (picking) {
    return (
      <div className="screen">
        <div className="title" style={{ fontSize: 36, marginTop: 8 }}>Choose a coin</div>
        <div className="flip-row" style={{ justifyContent: 'flex-start', marginTop: 2 }}><button className="flip" data-testid="pick-back" onClick={() => setPicking(false)}>Back</button></div>
        <div className="stack" data-testid="coin-list" style={{ overflow: 'auto', paddingBottom: 12 }}>
          {Object.entries(COINS).map(([id, c], i) => (
            <button className="slip row-button" key={id} data-testid={`coin-${id}`} style={{ ['--i' as string]: i, ['--tone' as string]: ['#202020', '#1C1C1C', '#191919', '#161616', '#131313', '#101010', '#0D0D0D'][i], zIndex: 10 - i }} onClick={() => { setOther(id); setPicking(false); }}>
              <img src={`/coins/${c.logo}.png`} alt="" /><div><div className="name">{c.name}</div><div className="note">On {c.network}</div></div><div className="end"><b>{c.ticker}</b></div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <Head title="Swap" back="home" />
      <div className="word" style={{ marginTop: 8 }}>You pay</div>
      <div className="chip swap-chip">
        <input data-testid="swap-amount" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} autoFocus />
        <Coin coin={pay} />
      </div>
      <div className="flip-row"><button className="flip" data-testid="swap-flip" onClick={() => { setBuying(!buying); setAmount(''); }}>Flip</button></div>
      <div className="word">You get</div>
      <div className="chip swap-chip" data-testid="swap-result">
        <div className={`swap-out ${q.state === 'loading' ? 'thinking' : ''}`}>{q.best && q.state !== 'idle' ? short(q.best.amount) : '0'}</div>
        <Coin coin={get} />
      </div>
      {q.best && (q.state === 'ok' || q.state === 'loading') && (
        <div className="facts fade-in" data-testid="swap-facts">
          <div><span>Price</span><b>1 {pay.ticker} = {short(q.best.rate)} {get.ticker}</b></div>
          <div><span>Best price from</span><b data-testid="swap-partner">{q.best.partner}</b></div>
          <div><span>{buying ? 'Pay on' : 'Receive on'}</span><b>{(buying ? pay : get).network}</b></div>
        </div>
      )}
      {q.state === 'low' && <div className="error" data-testid="swap-low">The smallest swap here is {short(q.min!)} {pay.ticker}.</div>}
      {q.state === 'none' && <div className="error" data-testid="swap-none">Nobody is offering this swap right now. Try another coin.</div>}
      {q.state === 'down' && <div className="error" data-testid="swap-down">Prices aren't available right now. Check your connection and try again.</div>}
      <div className="grow" />
      <div className="note" style={{ textAlign: 'center', marginBottom: 10 }} data-testid="swap-note">{MAINNET ? "These prices are live. Starting a swap isn't switched on yet." : 'These prices are live. Swapping opens when Walnero moves from the test network to real Monero.'}</div>
      <div style={{ paddingBottom: 22 }}><Fold cols="1fr" items={[{ label: MAINNET ? 'Not switched on yet' : 'Opens on real Monero', id: 'swap-go', disabled: true }]} /></div>
    </div>
  );
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'];
const cleanAmount = (v: string) => {
  let s = v.replace(/[^\d.]/g, '');
  const dot = s.indexOf('.');
  if (dot >= 0) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '').slice(0, 12);
  return s.replace(/^0+(?=\d)/, '').slice(0, 16);
};

// Send writes itself as a sentence, one step at a time: "Send <amount> to <name>", then a slide.
function SendScreen({ Head, onSent, pay, home, hidden, to: preset }: any) {
  const [step, setStep] = useState<'amount' | 'to'>(pay?.amount ? 'to' : 'amount');
  const [amount, setAmount] = useState<string>(pay?.amount ?? '');
  const [to, setTo] = useState<string>(pay?.address ?? (preset ? `@${preset}` : ''));
  const [names, setNames] = useState<SavedName[]>([]);
  const [review, setReview] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [speed, setSpeed] = useState('auto');
  // A name like donate.getmonero.org, once looked up.
  const [alias, setAlias] = useState<Alias | null>(null);
  const amountChip = useRef<HTMLLabelElement>(null);
  const toChip = useRef<HTMLLabelElement>(null);
  useEffect(() => { call('sendOpen').catch(() => {}); call<SavedName[]>('names').then(setNames).catch(() => {}); }, []);

  const typed = to.trim();
  const named = pay ? undefined : names.find((n) => n.name === typed.toLowerCase().replace(/^@/, ''));
  const isAlias = !pay && !named && looksLikeAlias(typed);
  const address = named ? named.address : alias?.address ?? typed;
  const filled = Boolean(named) || Boolean(alias) || typed.length >= 90;
  const validAmount = Number(amount) > 0;
  const plain = amount.replace(/\.$/, '');

  const check = async (addr = address, level = speed) => {
    setBusy(true); setError('');
    try {
      if (isAlias && !alias) { const found = await call<Alias>('resolveAlias', { name: typed, coin: 'xmr' }); setAlias(found); addr = found.address; }
      setReview(await call('estimate', { address: addr, amount: plain, speed: level }));
    } catch (e: any) { setError(e.message); setReview(null); } finally { setBusy(false); }
  };
  const next = () => {
    if (!validAmount) return;
    setStep('to');
    if (named) check(named.address);
  };
  const key = (k: string) => setAmount((a) => (k === 'back' ? a.slice(0, -1) : k === '.' ? (a.includes('.') ? a : `${a || '0'}.`) : cleanAmount(a + k)));

  // The coin leaves the amount and lands in the name while the block bars fill.
  const fly = () => {
    const coin = amountChip.current?.querySelector('img');
    const target = toChip.current;
    if (reduced() || !coin || !target) return;
    const from = coin.getBoundingClientRect(); const box = target.getBoundingClientRect();
    const outer = document.createElement('div'); outer.className = 'fly'; outer.style.left = `${from.left}px`; outer.style.top = `${from.top}px`;
    const img = document.createElement('img'); img.src = '/coins/xmr.png'; img.style.width = `${from.width}px`; img.style.height = `${from.height}px`;
    outer.append(img); document.body.append(outer);
    coin.animate([{ opacity: 1 }, { opacity: 0.2 }], { duration: 200, fill: 'forwards' });
    outer.animate([{ transform: 'none' }, { transform: `translateX(${box.left + 34 - from.left}px)` }], { duration: 780, easing: 'cubic-bezier(.65, 0, .35, 1)', fill: 'forwards' });
    img.animate([{ transform: 'none' }, { transform: `translateY(${box.top + box.height / 2 - from.height / 2 - from.top}px) scale(.5)` }], { duration: 780, easing: 'cubic-bezier(.36, 0, .66, -.56)', fill: 'forwards' })
      .finished.then(() => { outer.remove(); target.animate([{ scale: 1 }, { scale: 1.06, offset: 0.25 }, { scale: 1 }], { duration: 540, easing: 'cubic-bezier(.34, 1.56, .64, 1)' }); });
  };
  const send = async () => {
    setSending(true); setError('');
    requestAnimationFrame(fly);
    try {
      const [r] = await Promise.all([call('send', { review: review?.review }), wait(1250)]);
      if (named) call('usedName', { name: named.name }).catch(() => {});
      onSent({ hash: r.hash, amount: review.amount, fee: review.fee, to: named ? `@${named.name}` : alias ? alias.name : pay?.site || shortAddr(address) });
    } catch (e: any) {
      amountChip.current?.querySelector('img')?.getAnimations().forEach((a) => a.cancel());
      setError(e.message); setReview(null); setSending(false);
    }
  };

  const toLabel = named ? <><span>@</span><span className="grow-in">{named.name}</span></>
    : alias ? <span className="grow-in">{alias.name.length > 18 ? `${alias.name.slice(0, 17)}…` : alias.name}</span>
    : typed.length >= 90 ? <span>{shortAddr(typed)}</span>
    : typed ? <span>{typed.length > 13 ? `…${typed.slice(-12)}` : typed}</span>
    : <span className="ph">@</span>;

  return (
    <div className="screen">
      <Head title="From Main wallet" back="home" />
      <div className="word in" style={{ marginTop: 8 }}>{pay ? 'Pay' : 'Send'}</div>

      <label ref={amountChip} className="chip pop-in amt" onClick={() => { if (step === 'to' && !pay?.amount && !review && !sending) setStep('amount'); }}>
        <img src="/coins/xmr.png" alt="" />
        <span className="amt-text">{amount ? amount.split('').map((c, i) => <i className="dg" key={i}>{c}</i>) : <span className="ph">0</span>}{step === 'amount' && <i className="caret" />}</span>
        <span className="unit">XMR</span>
        {step === 'amount'
          ? <input className="ghost" data-testid="send-amount" inputMode={PHONE ? 'none' : 'decimal'} autoComplete="off" value={amount} autoFocus onChange={(e) => { setAmount(cleanAmount(e.target.value)); setError(''); }} onKeyDown={(e) => { if (e.key === 'Enter') next(); }} />
          : <input className="ghost" data-testid="send-amount" value={amount} readOnly disabled={Boolean(pay?.amount)} />}
      </label>

      {step === 'amount' && (
        <>
          <div className="amt-facts in" style={{ ['--d' as string]: 2 }}>
            <span>{home ? `${hidden ? STARS : trim4(home.unlocked)} XMR ready to send` : ''}</span>
            {home && !isZero(home.onTheWay) && <span className="way">{hidden ? 'Some' : trim4(home.onTheWay)} on the way</span>}
          </div>
          <div className="fold in" style={{ ['--d' as string]: 3, marginTop: 12 }}><button className={`sk ${validAmount ? 'hit' : ''}`} data-testid="amount-next" disabled={!validAmount} onClick={next}><span>Next</span></button></div>
          <div className="pad">
            {KEYS.map((k, i) => <button key={k} style={{ ['--i' as string]: i }} data-testid={`key-${k}`} aria-label={k === 'back' ? 'Delete' : k} onMouseDown={(e) => e.preventDefault()} onClick={() => { key(k); setError(''); }}>{k === 'back' ? icon('backspace') : k}</button>)}
          </div>
        </>
      )}

      {step === 'to' && (
        <>
          <div className="word in" style={{ ['--d' as string]: 1 }}>to</div>
          <label ref={toChip} className={`chip pop-in to ${filled ? 'hit' : ''}`} style={{ animationDelay: '.1s' }}>
            {toLabel}{!filled && !pay && <i className="caret" />}
            <input className="ghost" data-testid="send-address" spellCheck={false} autoComplete="off" value={to} autoFocus={!pay} disabled={Boolean(pay)} readOnly={Boolean(review) || sending}
              onChange={(e) => { setTo(e.target.value.trim()); setReview(null); setAlias(null); setError(''); }} onKeyDown={(e) => { if (e.key === 'Enter' && typed) check(); }} />
          </label>
          {alias && <AliasCard alias={alias} />}
          {filled && <div className="addr-line fade-in" data-testid="send-to-full">{address}</div>}
          {pay && (
            <div className="facts" data-testid="pay-site" style={{ marginTop: 8 }}>
              <div><span>Asked by</span><b data-testid="pay-domain">{pay.site || 'Unknown site'}</b></div>
              {pay.note && <div><span>For</span><b data-testid="pay-note" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 230 }}>{pay.note}</b></div>}
            </div>
          )}
          {!filled && !pay && PHONE && (
            <div className="chips"><button className="paste" data-testid="paste" onClick={async () => {
              try { const text = (await navigator.clipboard.readText()).trim(); setTo(text); setError(''); if (text.length >= 90) check(text); } catch { setError('Copy the address first, then tap Paste.'); }
            }}>Paste address</button></div>
          )}
          {!filled && !pay && (names.length
            ? <><div className="hint-l in" style={{ ['--d' as string]: 3 }}>Saved names</div><div className="chips">{names.slice(0, 4).map((n, i) => <button key={n.name} style={{ ['--i' as string]: i }} data-testid={`pick-${n.name}`} onMouseDown={(e) => e.preventDefault()} onClick={() => { setTo(`@${n.name}`); check(n.address); }}>@{n.name}</button>)}</div></>
            : <div className="hint-l in" style={{ ['--d' as string]: 3 }}>{PHONE ? 'An address, or a name like donate.getmonero.org. Names you save show up here too.' : 'Paste an address, or type a name like donate.getmonero.org. Names you save show up here too.'}</div>)}
          {review && !sending && (
            <>
              <Speeds list={XMR_SPEEDS} value={speed} disabled={busy} onPick={(k) => { if (k === speed) return; setSpeed(k); check(address, k); }} testid="xmr-speeds" />
              <div className="facts" data-testid="review">
                <div className="in"><span>Network</span><b>{MAINNET ? 'Monero' : 'Test network'}</b></div>
                <div className="in" style={{ ['--d' as string]: 1 }}><span>Network fee</span><b data-testid="fee">{busy ? 'Working it out' : `${Number(review.fee).toFixed(6)} XMR`}</b></div>
                <div className="in" style={{ ['--d' as string]: 2 }}><span>Arrives in</span><b>About 2 minutes</b></div>
              </div>
            </>
          )}
          {sending && <div className="sending fade-in" data-testid="sending"><div className="lbl">Sending</div><div className="sbars">{Array.from({ length: 30 }, (_, i) => <i key={i} style={{ ['--i' as string]: i }} />)}</div></div>}
        </>
      )}

      {error && <div className="error" data-testid="send-error">{error}</div>}
      <div className="grow" />
      {step === 'to' && !sending && (
        <div style={{ paddingBottom: 22 }}>
          {review
            ? <div className="in" style={{ ['--d' as string]: 3, ...(busy && { opacity: 0.4, pointerEvents: 'none' as const }) }}><Slide label="Slide to send" onDone={send} /></div>
            : typed ? <div className="fold"><button className={`sk ${filled || isAlias ? 'hit' : ''}`} data-testid="review-go" disabled={busy} onClick={() => check()}><span>{busy ? (isAlias && !alias ? 'Looking it up' : 'Checking') : 'Review'}</span></button></div> : null}
        </div>
      )}
    </div>
  );
}
