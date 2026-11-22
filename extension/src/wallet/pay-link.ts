// Reads a monero: payment link. Everything in it comes from a web page, so it's checked here, and the wallet still validates the
// address before anything can be paid.
export interface PayRequest { address: string; amount: string; label: string; note: string; site: string }

export function parsePayLink(uri: string): Omit<PayRequest, 'site'> | null {
  const match = /^monero:([0-9A-Za-z]{90,110})(?:\?(.*))?$/i.exec(uri.trim());
  if (!match) return null;
  const query = new URLSearchParams(match[2] ?? '');
  const amount = query.get('tx_amount') ?? '';
  if (amount && !/^\d*\.?\d{0,12}$/.test(amount)) return null;
  const text = (name: string, max: number) => (query.get(name) ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').slice(0, max);
  return { address: match[1], amount, label: text('recipient_name', 60), note: text('tx_description', 100) };
}

export function readPayRequest(search: string): PayRequest | null {
  const query = new URLSearchParams(search);
  const address = query.get('pay');
  if (!address) return null;
  return { address, amount: query.get('amount') ?? '', label: query.get('label') ?? '', note: query.get('note') ?? '', site: query.get('site') ?? '' };
}
