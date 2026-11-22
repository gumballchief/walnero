// OpenAlias (openalias.org): pay a name like donate.getmonero.org or you@example.com instead of a long address. The name's
// DNS TXT record holds the address: "oa1:xmr recipient_address=...; recipient_name=...;". Like Cake Wallet and the official
// Monero wallet, the answer only counts as verified when DNSSEC signed it, which the screen says either way.
//
// The lookup goes over encrypted DNS (Cloudflare, then Google), so the network in between can't see or change it. That
// service does see which name was looked up, never anything about the wallet.

export interface Alias { name: string; address: string; title: string; note: string; secure: boolean }
export type AliasCoin = 'xmr' | 'btc';

const RESOLVERS = [
  (name: string) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
  (name: string) => `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=TXT`,
];

// A domain (donate.getmonero.org) or an email-style name (you@example.com). Saved names start with @, addresses have no dot.
export function looksLikeAlias(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t || t.startsWith('@') || t.split('@').length > 2) return false;
  const host = t.includes('@') ? t.split('@')[1]! : t;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && /\.[a-z]{2,}$/.test(host) && /^[a-z0-9._+-]*$/.test(t.split('@')[0]!);
}

// A TXT answer can come quoted, and split into 255-character pieces ("one" "two"). Put it back together.
const txtText = (data: string) => (data.startsWith('"') ? data.split(/"\s*"/).join('').replace(/^"|"$/g, '') : data);

function parse(record: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of record.replace(/^oa1:\w+\s*/i, '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim();
  }
  return out;
}

export async function resolveAlias(text: string, coin: AliasCoin): Promise<Alias> {
  const name = text.trim().toLowerCase();
  const dnsName = name.replace('@', '.');
  const coinName = coin === 'xmr' ? 'Monero' : 'Bitcoin';
  let answer: any = null;
  let failure: unknown;
  for (const url of RESOLVERS) {
    try {
      const response = await fetch(url(dnsName), { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`DNS answered ${response.status}`);
      answer = await response.json();
      break;
    } catch (error) {
      failure = error;
    }
  }
  if (!answer) throw new Error(`Couldn't look up ${name} right now. Check your connection. (${String((failure as any)?.message ?? failure)})`);
  if (answer.Status === 3) throw new Error(`There's no name ${name}`);
  const records = (answer.Answer ?? []).filter((a: any) => a.type === 16).map((a: any) => txtText(String(a.data ?? '')));
  const oa = records.filter((r: string) => /^oa1:/i.test(r));
  if (!oa.length) throw new Error(`${name} has no OpenAlias address`);
  const mine = oa.find((r: string) => r.toLowerCase().startsWith(`oa1:${coin} `));
  if (!mine) throw new Error(`${name} has no ${coinName} address, only ${oa.map((r: string) => r.slice(4, r.indexOf(' ')).toUpperCase()).join(', ')}`);
  const fields = parse(mine);
  if (!fields.recipient_address) throw new Error(`${name}'s ${coinName} record has no address in it`);
  return { name, address: fields.recipient_address, title: fields.recipient_name ?? '', note: fields.tx_description ?? '', secure: answer.AD === true };
}
