// The feed is a convenience, not a source of truth. Before a scan counts for anything, its results get compared with the real
// chain, read from servers that have nothing to do with the feed.
//
//   1. Every block: its number of outputs must match the chain, so nothing can be dropped or added. About 45 KB for a month.
//   2. Random blocks: rebuilt from the real transactions and compared byte for byte, so contents can't quietly change. The feed
//      can't know which blocks get picked, and every wallet picks different ones, so a feed that lies to everyone gets caught.
//
// What this can't catch by itself: one altered transaction, aimed at one user, in a block nobody happened to pick. That takes
// knowing whose payment it is and which download is theirs. It could only hide money, never take it, and Full check in Settings
// reads the chain without the feed at all.
import { encodeChunk, txEntry } from '../../../feed/src/format.mjs';

export class FeedRejected extends Error {}

type Nodes = readonly string[];

async function withNodes<T>(nodes: Nodes, work: (node: string) => Promise<T>): Promise<T> {
  let failure: unknown;
  for (const node of nodes) {
    try {
      return await work(node);
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

async function rpc(node: string, method: string, params: unknown) {
  const res = await fetch(`${node}/json_rpc`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }), signal: AbortSignal.timeout(20000) });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

/** Outputs in each block in a range, from the chain itself. */
export async function chainOutputs(nodes: Nodes, from: number, to: number): Promise<Map<number, number>> {
  const result = await withNodes(nodes, (node) => rpc(node, 'get_output_distribution', { amounts: [0], from_height: from, to_height: to, cumulative: false, binary: false, compress: false }));
  const { start_height: start, distribution } = result.distributions[0];
  const out = new Map<number, number>();
  distribution.forEach((n: number, i: number) => out.set(start + i, n));
  return out;
}

/** What the feed should hold for one block, built from the real transactions. */
export async function rebuildBlock(nodes: Nodes, height: number): Promise<{ txs: number; body: Uint8Array }> {
  return withNodes(nodes, async (node) => {
    const block = await rpc(node, 'get_block', { height });
    const entries = [txEntry(JSON.parse(block.json).miner_tx)];
    const hashes: string[] = block.tx_hashes ?? [];
    for (let i = 0; i < hashes.length; i += 100) {
      const res = await fetch(`${node}/get_transactions`, { method: 'POST', body: JSON.stringify({ txs_hashes: hashes.slice(i, i + 100), decode_as_json: true, prune: true }), signal: AbortSignal.timeout(20000) });
      const reply = await res.json();
      const byHash = new Map<string, any>((reply.txs ?? []).map((t: any) => [t.tx_hash, t]));
      for (const hash of hashes.slice(i, i + 100)) {
        const entry = byHash.get(hash);
        if (!entry) throw new Error(`${node} did not return ${hash}`);
        entries.push(txEntry(JSON.parse(entry.as_json)));
      }
    }
    return { txs: entries.length, body: encodeChunk(height, [entries]).subarray(18) };
  });
}

export function pickSpots(from: number, to: number, blocks: number): number[] {
  const wanted = Math.min(12, 1 + Math.ceil(blocks / 1440));
  const picked = new Set<number>();
  if (to < from) return [];
  const random = new Uint32Array(wanted);
  crypto.getRandomValues(random);
  for (const r of random) picked.add(from + (r % (to - from + 1)));
  return [...picked];
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// Servers run a block or two apart, so a little difference is normal. A feed further ahead than this is inventing blocks.
const TIP_SLACK = 30;

/** Throws FeedRejected if the feed disagrees with the chain anywhere it was checked. Returns the last block the chain confirmed, and
 *  nothing past that may count, or a feed could claim the future and make the wallet skip real payments when they arrive. */
export function compareWithChain(feedOuts: Map<number, number>, chainOuts: Map<number, number>, from: number, to: number, feedSpots: Map<number, { txs: number; body: Uint8Array }>, rebuilt: Map<number, { txs: number; body: Uint8Array }>): number {
  let confirmedTo = from - 1;
  for (let h = from; h <= to; h++) {
    const real = chainOuts.get(h);
    if (real === undefined) break;
    confirmedTo = h;
    const told = feedOuts.get(h);
    if (told !== real) throw new FeedRejected(`Block ${h} has ${real} outputs on the chain, the feed says ${told ?? 'none'}`);
  }
  if (to - confirmedTo > TIP_SLACK) throw new FeedRejected(`The feed claims block ${to}, but the chain only reaches ${confirmedTo}`);
  for (const [height, real] of rebuilt) {
    const told = feedSpots.get(height);
    if (!told) throw new FeedRejected(`The feed did not cover block ${height}`);
    if (told.txs !== real.txs || !sameBytes(told.body, real.body)) throw new FeedRejected(`Block ${height} in the feed doesn't match the chain`);
  }
  return confirmedTo;
}
