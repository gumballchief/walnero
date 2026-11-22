// How the screens talk to the wallet engine. Starts the offscreen document the first time it's needed.
import { kvGet } from '@/wallet/vault';
import { readPayRequest, type PayRequest } from '@/wallet/pay-link';

const OFFSCREEN = 'offscreen.html';
const READY_TRIES = 60;
const READY_WAIT_MS = 150;
let starting: Promise<void> | null = null;

const engineRunning = async () => {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType], documentUrls: [chrome.runtime.getURL(OFFSCREEN)] });
  return contexts.length > 0;
};

export function ensureEngine(): Promise<void> {
  starting ??= (async () => {
    if (await engineRunning()) return;
    await chrome.offscreen.createDocument({ url: OFFSCREEN, reasons: ['WORKERS' as chrome.offscreen.Reason], justification: 'Runs the Monero wallet engine in a Web Worker' });
  })().finally(() => { starting = null; });
  return starting;
}

// The document can exist before its script has finished loading, so "nobody is listening yet" means wait, not fail.
async function send(message: unknown) {
  for (let i = 0; ; i++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error: any) {
      if (i >= READY_TRIES || !/Receiving end does not exist/i.test(String(error?.message))) throw error;
      await new Promise((resolve) => setTimeout(resolve, READY_WAIT_MS));
    }
  }
}

export async function call<T = any>(method: string, params?: unknown): Promise<T> {
  await ensureEngine();
  const reply = await send({ target: 'wallet', method, params });
  if (!reply) throw new Error('The wallet engine did not answer');
  if (!reply.ok) throw new Error(reply.error);
  return reply.result as T;
}

// The wallet is locked but someone just clicked it, so do the slow parts now, before the password is even typed.
function getReady() {
  call('catchup', { eager: true }).catch(() => {});
  call('warm').catch(() => {});
}

export interface FirstView { view: 'welcome' | 'locked' | 'home'; home: any; txs: any[] | null; pay: PayRequest | null; prefs: any }

/** What the very first frame shows. If nothing is running the wallet is locked, and that needs no engine to know. */
export async function firstView(): Promise<FirstView> {
  const pay = readPayRequest(location.search);
  // Read with the first frame, so a hidden balance is never shown even for a moment.
  const [vault, prefs] = await Promise.all([kvGet('vault'), kvGet('prefs').catch(() => null)]);
  if (!vault) return { view: 'welcome', home: null, txs: null, pay, prefs };
  if (!(await engineRunning())) {
    getReady();
    return { view: 'locked', home: null, txs: null, pay, prefs };
  }
  try {
    const [home, txs] = await Promise.all([call('home'), call('activity')]);
    return { view: 'home', home, txs, pay, prefs };
  } catch {
    getReady();
    return { view: 'locked', home: null, txs: null, pay, prefs };
  }
}
