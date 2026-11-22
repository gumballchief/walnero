// GET /api/quote?from=usdt-trx&to=xmr&amount=100
import { COINS, quote } from '../lib/quote.mjs';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('coins') === '1') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(Object.fromEntries(Object.entries(COINS).map(([id, c]) => [id, { name: c.name, ticker: c.ticker, network: c.network, logo: c.logo }]))));
    return;
  }
  const { status, body } = await quote(Object.fromEntries(url.searchParams));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, s-maxage=15');
  res.end(JSON.stringify(body));
}
