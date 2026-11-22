// How big would the scan feed be? Reads one day of real mainnet block headers plus a sample of real transactions
// from a public node, then works out bytes per day for each feed design. Read-only: no wallet, no keys, no money.
const NODE = process.argv[2] ?? 'http://node.monerodevs.org:18089';
const BLOCKS_PER_DAY = 720;
const SAMPLE_BLOCKS = 40;

const rpc = async (method, params = {}) => {
  const res = await fetch(`${NODE}/json_rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }), signal: AbortSignal.timeout(60000) });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
};

const info = await rpc('get_info');
const tip = info.height - 1;
console.log(`node ${NODE}, mainnet: ${!info.stagenet && !info.testnet}, height ${info.height}`);

const { headers } = await rpc('get_block_headers_range', { start_height: tip - BLOCKS_PER_DAY + 1, end_height: tip });
const txsPerDay = headers.reduce((sum, h) => sum + h.num_txes, 0);
const blockBytes = headers.reduce((sum, h) => sum + h.block_size, 0);
console.log(`last ${headers.length} blocks: ${txsPerDay} transactions, ${(blockBytes / 1048576).toFixed(1)} MB of block data`);

// Parse real transactions to learn inputs, outputs and extra public keys per transaction.
const picks = Array.from({ length: SAMPLE_BLOCKS }, (_, i) => headers[Math.floor(((i + 0.5) * headers.length) / SAMPLE_BLOCKS)]);
const hashes = [];
for (const h of picks) {
  const block = await rpc('get_block', { height: h.height });
  hashes.push(...(block.tx_hashes ?? []));
}
const sample = hashes.slice(0, 400);
let inputs = 0, outputs = 0, additional = 0, withAdditional = 0, parsed = 0;
for (let i = 0; i < sample.length; i += 50) {
  const res = await fetch(`${NODE}/get_transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txs_hashes: sample.slice(i, i + 50), decode_as_json: true }), signal: AbortSignal.timeout(60000) });
  const { txs = [] } = await res.json();
  for (const entry of txs) {
    const tx = JSON.parse(entry.as_json);
    inputs += tx.vin.length;
    outputs += tx.vout.length;
    // tx extra: tag 1 is the transaction public key, tag 4 is the list of additional public keys (one per output).
    const extra = tx.extra;
    let at = 0, extraKeys = 0;
    while (at < extra.length) {
      const tag = extra[at];
      if (tag === 1) at += 33;
      else if (tag === 4) { extraKeys = extra[at + 1]; at += 2 + extraKeys * 32; }
      else if (tag === 2) at += 2 + extra[at + 1];
      else if (tag === 0) at = extra.length;
      else at = extra.length;
    }
    additional += extraKeys;
    if (extraKeys) withAdditional++;
    parsed++;
  }
}
const avgIn = inputs / parsed, avgOut = outputs / parsed, avgAdd = additional / parsed;
console.log(`sampled ${parsed} transactions: ${avgIn.toFixed(2)} inputs, ${avgOut.toFixed(2)} outputs, ${avgAdd.toFixed(2)} additional keys each; ${((withAdditional / parsed) * 100).toFixed(0)}% carry additional keys`);

// Bytes per transaction for each design. Every design carries the tx public key and one 1-byte view tag per output.
const coinbasePerDay = BLOCKS_PER_DAY * (32 + 1 + 32 + 8); // public key, tag, tx hash, plus height framing
const designs = {
  'A. Plan as written: tx hash, keys, tags, one-time keys, full key images': 32 + 32 + avgAdd * 32 + avgOut * (1 + 32) + avgIn * 32,
  'B. No one-time keys (fetch them only on a tag hit)': 32 + 32 + avgAdd * 32 + avgOut + avgIn * 32,
  'C. Also shorten key images to 8 bytes (false hits just cost a re-check)': 32 + 32 + avgAdd * 32 + avgOut + avgIn * 8,
};
console.log('');
for (const [name, perTx] of Object.entries(designs)) {
  const perDay = perTx * txsPerDay + coinbasePerDay;
  console.log(`${name}\n  ${perTx.toFixed(0)} bytes per tx, ${(perDay / 1048576).toFixed(2)} MB per day, ${(((perDay * 30) / 1048576)).toFixed(0)} MB per month, ${((perDay / blockBytes) * 100).toFixed(1)}% of the raw block data`);
}
console.log(JSON.stringify({ height: info.height, txsPerDay, blockMB: +(blockBytes / 1048576).toFixed(1), sampled: parsed, avgIn: +avgIn.toFixed(2), avgOut: +avgOut.toFixed(2), avgAdd: +avgAdd.toFixed(2) }));
