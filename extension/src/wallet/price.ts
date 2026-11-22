// Monero's and Bitcoin's prices, for their token screens and the values on Home. Two free public sources, no keys, and nothing about this wallet
// is ever sent, only "what does Monero cost":
//   CoinGecko for the price, the day's change and the market facts (market cap, supply, all-time high, rank).
//   Kraken for the chart, because CoinGecko's free tier stops at one year and Kraken's weekly prices go back to 2016.
// Answers are kept for a minute or two, and the last market is kept on this device so Home can show a value the moment it opens.

export interface Market {
  price: number; change: number; changePct: number; cap: number; capChangePct: number; volume: number;
  high: number; low: number; supply: number; ath: number; athDate: string; rank: number; at: number;
}
export type Range = '1D' | '1W' | '1M' | 'YTD' | 'ALL';
export interface Point { time: number; value: number }

export type Coin = 'monero' | 'bitcoin';
const COINGECKO = (coin: Coin) => `https://api.coingecko.com/api/v3/coins/${coin}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`;
const KRAKEN = (coin: Coin) => `https://api.kraken.com/0/public/OHLC?pair=${coin === 'bitcoin' ? 'XBTUSD' : 'XMRUSD'}&interval=`;
const KEPT = (coin: Coin) => (coin === 'monero' ? 'walnero-market' : `walnero-market-${coin}`);
const DAY = 86400;

const memo = new Map<string, { at: number; value: Promise<any> }>();
function cached<T>(key: string, keepMs: number, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < keepMs) return hit.value;
  const value = load();
  memo.set(key, { at: Date.now(), value });
  value.catch(() => memo.delete(key));
  return value;
}

async function getJson(url: string) {
  const response = await fetch(url);
  if (response.status === 429) throw new Error('Prices are busy for a moment');
  if (!response.ok) throw new Error("Prices didn't load");
  return response.json();
}

export function lastMarket(coin: Coin = 'monero'): Market | null {
  try { return JSON.parse(localStorage.getItem(KEPT(coin)) ?? 'null'); } catch { return null; }
}

export function market(coin: Coin = 'monero'): Promise<Market> {
  return cached(`market-${coin}`, 90_000, async () => {
    const m = (await getJson(COINGECKO(coin))).market_data;
    const out: Market = {
      price: m.current_price.usd, change: m.price_change_24h_in_currency?.usd ?? m.price_change_24h ?? 0,
      changePct: m.price_change_percentage_24h_in_currency?.usd ?? m.price_change_percentage_24h ?? 0,
      cap: m.market_cap.usd, capChangePct: m.market_cap_change_percentage_24h ?? 0, volume: m.total_volume.usd,
      high: m.high_24h.usd, low: m.low_24h.usd, supply: m.circulating_supply, ath: m.ath.usd, athDate: m.ath_date.usd,
      rank: m.market_cap_rank ?? 0, at: Date.now(),
    };
    try { localStorage.setItem(KEPT(coin), JSON.stringify(out)); } catch { /* private window: just don't keep it */ }
    return out;
  });
}

// How each range is drawn from Kraken's candles. Kraken returns the latest 720 of a size, so each size covers its range.
const RANGES: Record<Range, { minutes: number; from: () => number }> = {
  '1D': { minutes: 5, from: () => Date.now() / 1000 - DAY },
  '1W': { minutes: 30, from: () => Date.now() / 1000 - 7 * DAY },
  '1M': { minutes: 240, from: () => Date.now() / 1000 - 30 * DAY },
  YTD: { minutes: 1440, from: () => Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000 },
  ALL: { minutes: 10080, from: () => 0 },
};

export function chart(range: Range, coin: Coin = 'monero'): Promise<Point[]> {
  const { minutes, from } = RANGES[range];
  return cached(`chart-${coin}-${range}`, range === '1D' ? 60_000 : 300_000, async () => {
    const data = await getJson(KRAKEN(coin) + minutes);
    if (data.error?.length) throw new Error("The chart didn't load");
    const rows: any[][] = Object.entries(data.result).find(([key]) => key !== 'last')?.[1] as any[][] ?? [];
    const start = from();
    return rows.filter((row) => row[0] >= start).map((row) => ({ time: Number(row[0]), value: Number(row[4]) }));
  });
}
