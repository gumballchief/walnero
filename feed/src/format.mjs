// The feed file format. Static files, identical for every user, so a server learns nothing about who reads them.
//   "WNF" version(1) startHeight:u32 blocks:u32 txs:u32, then a u16 tx count per block, then per transaction, miner tx first:
//   flags:u8 (1 = has view tags, 2 = has per-output keys)  keys:u8  key*32...  outs:varint  [per-output key*32...]
//   per output: [tag:u8] one-time-key*32   inputs:varint  key-image-prefix*4...
export const VERSION = 1;

const hexBytes = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));

// tx_extra holds the transaction public key (tag 1) and any per-output keys (tag 4), among other fields.
function parseExtra(extra) {
  const keys = [];
  let extras = [];
  let at = 0;
  const varint = () => { let v = 0, shift = 0; for (;;) { const b = extra[at++]; v += (b & 0x7f) * 2 ** shift; if (!(b & 0x80)) return v; shift += 7; } };
  while (at < extra.length) {
    const tag = extra[at++];
    if (tag === 1) {
      if (at + 32 > extra.length) break;
      keys.push(Uint8Array.from(extra.slice(at, at + 32)));
      at += 32;
    } else if (tag === 4) {
      const count = varint();
      if (at + count * 32 > extra.length) break;
      extras = Array.from({ length: count }, (_, i) => Uint8Array.from(extra.slice(at + i * 32, at + (i + 1) * 32)));
      at += count * 32;
    } else if (tag === 2 || tag === 3 || tag === 0xde) {
      const size = varint();
      at += size;
    } else break; // Padding or something unknown: wallet2 stops reading here as well.
  }
  return { keys, extras };
}

/** What the feed holds for one transaction, from a node's decoded JSON. */
export function txEntry(tx) {
  const { keys, extras } = parseExtra(tx.extra);
  const outs = tx.vout.map((o) => {
    const tagged = o.target.tagged_key;
    if (tagged) return { tag: parseInt(tagged.view_tag, 16), key: hexBytes(tagged.key) };
    return { key: hexBytes(o.target.key) };
  });
  const images = tx.vin.filter((i) => i.key).map((i) => hexBytes(i.key.k_image));
  return { keys, extras: extras.length === outs.length ? extras : [], outs, images };
}

const varintSize = (n) => { let size = 1; while (n >= 0x80) { n = Math.floor(n / 128); size++; } return size; };
const writeVarint = (buf, at, n) => { while (n >= 0x80) { buf[at++] = (n & 0x7f) | 0x80; n = Math.floor(n / 128); } buf[at++] = n; return at; };

export function encodeChunk(startHeight, blocks) {
  let size = 16 + blocks.length * 2;
  let txCount = 0;
  for (const block of blocks) {
    txCount += block.length;
    for (const tx of block) {
      const tagged = tx.outs.every((o) => o.tag !== undefined);
      size += 2 + tx.keys.length * 32 + varintSize(tx.outs.length) + (tx.extras?.length ? tx.outs.length * 32 : 0) + tx.outs.length * (tagged ? 33 : 32) + varintSize(tx.images.length) + tx.images.length * 4;
    }
  }
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  buf.set([0x57, 0x4e, 0x46, VERSION]);
  view.setUint32(4, startHeight, true);
  view.setUint32(8, blocks.length, true);
  view.setUint32(12, txCount, true);
  let at = 16;
  for (const block of blocks) { view.setUint16(at, block.length, true); at += 2; }
  for (const block of blocks) {
    for (const tx of block) {
      const tagged = tx.outs.every((o) => o.tag !== undefined);
      const hasExtras = Boolean(tx.extras?.length);
      buf[at++] = (tagged ? 1 : 0) | (hasExtras ? 2 : 0);
      buf[at++] = tx.keys.length;
      for (const key of tx.keys) { buf.set(key, at); at += 32; }
      at = writeVarint(buf, at, tx.outs.length);
      if (hasExtras) for (const key of tx.extras) { buf.set(key, at); at += 32; }
      for (const out of tx.outs) {
        if (tagged) buf[at++] = out.tag;
        buf.set(out.key, at);
        at += 32;
      }
      at = writeVarint(buf, at, tx.images.length);
      for (const image of tx.images) { buf.set(image.subarray(0, 4), at); at += 4; }
    }
  }
  if (at !== size) throw new Error(`chunk size mismatch ${at} vs ${size}`);
  return buf;
}
