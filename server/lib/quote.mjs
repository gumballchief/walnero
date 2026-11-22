// Swap prices. Partner keys, when they exist, stay on this server and never reach the extension.
// No accounts and no logs: a quote request holds nothing about who asked.

export const COINS = {
  xmr: { name: 'Monero', ticker: 'XMR', network: 'Monero', logo: 'xmr', exolix: ['XMR', 'XMR'] },
  btc: { name: 'Bitcoin', ticker: 'BTC', network: 'Bitcoin', logo: 'btc', exolix: ['BTC', 'BTC'] },
  eth: { name: 'Ethereum', ticker: 'ETH', network: 'Ethereum', logo: 'eth', exolix: ['ETH', 'ETH'] },
  sol: { name: 'Solana', ticker: 'SOL', network: 'Solana', logo: 'sol', exolix: ['SOL', 'SOL'] },
  ltc: { name: 'Litecoin', ticker: 'LTC', network: 'Litecoin', logo: 'ltc', exolix: ['LTC', 'LTC'] },
  'usdt-trx': { name: 'Tether', ticker: 'USDT', network: 'Tron', logo: 'usdt', exolix: ['USDT', 'TRX'] },
  'usdt-eth': { name: 'Tether', ticker: 'USDT', network: 'Ethereum', logo: 'usdt', exolix: ['USDT', 'ETH'] },
  'usdc-eth': { name: 'USD Coin', ticker: 'USDC', network: 'Ethereum', logo: 'usdc', exolix: ['USDC', 'ETH'] },
};

async function exolix(from, to, amount, fetcher) {
  const [coinFrom, networkFrom] = COINS[from].exolix;
  const [coinTo, networkTo] = COINS[to].exolix;
  const query = new URLSearchParams({ coinFrom, networkFrom, coinTo, networkTo, amount, rateType: 'float' });
  const res = await fetcher(`https://exolix.com/api/v2/rate?${query}`, { signal: AbortSignal.timeout(8000) });
  const body = await res.json();
  if (body.error) return { partner: 'Exolix', unavailable: String(body.error) };
  // Below the minimum it still answers with the limits, and leaves the amount at zero or adds a message.
  const belowMin = Number(amount) < Number(body.minAmount);
  return {
    partner: 'Exolix',
    amount: belowMin ? null : String(body.toAmount),
    rate: body.rate === undefined ? null : String(body.rate),
    min: String(body.minAmount),
    max: String(body.maxAmount),
    belowMin,
  };
}

const PARTNERS = [exolix];

export async function quote({ from, to, amount }, fetcher = fetch) {
  if (!Object.hasOwn(COINS, String(from)) || !Object.hasOwn(COINS, String(to))) return { status: 400, body: { error: 'Unknown coin' } };
  if (from === to) return { status: 400, body: { error: 'Pick two different coins' } };
  if (from !== 'xmr' && to !== 'xmr') return { status: 400, body: { error: 'One side has to be Monero' } };
  const number = Number(amount);
  if (!Number.isFinite(number) || number <= 0) return { status: 400, body: { error: 'Enter an amount above zero' } };

  const settled = await Promise.allSettled(PARTNERS.map((p) => p(from, to, String(number), fetcher)));
  const quotes = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  const priced = quotes.filter((q) => q.amount);
  const best = priced.sort((a, b) => Number(b.amount) - Number(a.amount))[0] ?? null;
  const limits = quotes.find((q) => q.belowMin);
  const anyAnswer = quotes.some((q) => !q.unavailable);
  if (!quotes.length) return { status: 502, body: { error: 'Swap partners are not answering right now' } };
  if (!anyAnswer) return { status: 200, body: { from, to, amount: String(number), best: null, noRoute: true, quotes } };
  return { status: 200, body: { from, to, amount: String(number), best, belowMin: !best && limits ? limits.min : null, quotes } };
}
