# Stage 2.1: how instant open will work

Written 2026-11-04. Every number says whether it was measured or worked out from a measurement. Scripts are in `feed/bench/`; raw results sit beside them.

## The decision

**Use wallet2's own `scan_tx` plus its skip-ahead. No custom engine.**

1. Our scanner reads the feed on the device, using the view key, and finds which transactions are ours.
2. It hands those to wallet2 with `scanTxs`, oldest first. wallet2 adds the money, marks spends, and skips everything before them.
3. If nothing was ours, `setRestoreHeight(top)` jumps ahead and only block hashes get fetched.
4. The balance shows after step 1. Sending works after wallet2 reaches the top.

If the fast path and wallet2 ever disagree, wallet2 wins, as the plan already says.

## Proof that it works

Real stagenet coins, real spend. Nothing here is simulated. (`scan-tx-experiment.mjs`, `scan-spend-experiment.mjs`)

| Test | Result |
|---|---|
| Fresh wallet starting after the payment, told only its hash | Same balance and same transactions as a full block-by-block scan |
| Same, after the wallet had also spent coins | Balance 0.00896954, an exact match. Spent coins gone. |
| Asked for whole blocks of hashes, including 3 transactions that weren't ours | No errors, only our 2 were added |
| Could it send afterwards? | Built a valid payment, both before and after the spend. Not broadcast. |
| Told about older money after newer money | Refused with an error, and the balance stayed as it was, so it fails safe. We must always scan oldest first. |
| Extension sent 0.001 XMR for real | Tx 845d79bc...6745 in block 2243835, on 3 independent servers. The receiving wallet shows it. |

## The numbers

Mainnet, block height about 3,799,400, measured 2026-11-04. Read-only, with a throwaway empty wallet.

**Measured**

| What | Number |
|---|---|
| Transactions per day | 33,865 |
| Raw block data per day | 79.2 MB |
| Average transaction (400 sampled) | 1.63 inputs, 2.19 outputs, 0.25 extra keys; 7% carry extra keys |
| Scan rate inside the extension, one core, this PC | 2,575 to 2,831 transactions per second |
| View tag false hits | 0.36% of outputs, matching the expected 1 in 256 |
| Normal wallet catching up | 78.8 s for 427 blocks, so 5.4 blocks per second (one run, one server) |
| Skipping about a day when nothing is ours | 17.2 s (one run; longer than expected, needs another look) |
| Reopening a saved wallet | 0.6 s; cache 0.8 MB on mainnet |
| Brand-new wallet's first open, one day back | 53.7 s, including 295 blocks of scanning |
| Stagenet first catch-up | 135 to 293 s depending on the server, with a 54 MB cache (stagenet only: its checkpoints are old) |

**Worked out from those, not measured end to end**

Scan times assume 2,700 per second, plus 25% for the extra keys. Four workers is an estimate, and phones will be slower.

| Time offline | Feed download | Scan on 1 core | Scan on 4 workers | Normal wallet |
|---|---|---|---|---|
| 1 hour | 0.2 MB | 0.8 s | 0.2 s | 6 s |
| 1 day | 5.1 MB | 16 s | 4 s | 2.2 min |
| 1 week | 36 MB | 1.8 min | 27 s | 15.5 min |
| 1 month | 154 MB | 7.8 min | 2 min | 66 min |

**What this means for the promise:** the saved balance shows instantly on every open. "Up to date" takes a fraction of a second for someone who opens it hourly, a few seconds daily, and under a minute weekly. The mockup's "0.9s" only holds for short gaps, so the product copy must use measured numbers.

## Feed design: changed from what I'd have guessed

Shortest looks best but isn't. Without one-time keys (2.9 MB a day), 1 in 256 outputs is a false alarm: about 292 a day, touching about a third of blocks. Each means fetching a block, about 26 MB a day. That wastes more than the keys save.

**Chosen: keep one-time keys, shorten key images to 8 bytes.** That's about 157 bytes per transaction, or **5.1 MB a day, 6.5% of the raw data**. False alarms get settled on the device with no download. A false match on a shortened key image only costs a re-check.

## The other options

- **(a) Feather's skip sync:** not usable. PR #280 is still open, and its own notes say the skip button was removed because a running refresh can't be interrupted. It also skips blindly, so it would miss payments.
- **(b) Jumping the refresh height:** this is step 3 above, but alone it can't see payments.
- **(c) Our own scanner plus `monero-oxide` for sends:** the fallback only. More code holding real money for no benefit now.
- **monero-lws / MyMonero style:** rejected, as before: the server holds the view key.
- **spirobel's TypeScript/Rust scanning library:** not used. It's small, and its own funding review suggested building on the audited crate instead. No published speed numbers were found.

## Privacy

Fetching only real hits would show a server exactly which blocks matter to you. So each real hit is requested as its whole block's transactions plus several random blocks. The experiment confirmed unrelated hashes are harmless. The feed itself is the same file for everyone, so downloading it reveals nothing beyond the height range.

## Still open, for steps 2.2 to 2.4

- **Reopen with a real hit:** the experiments used fresh wallets. A saved wallet plus a gap plus a hit has to be tested in 2.4.
- **The 17.2 s skip:** one run. Needs repeats and a look at what it's waiting on.
- **First-ever open is still slow** (54 s on mainnet). The balance can show from the feed first, but sending waits. monero-ts 0.11.21 has older checkpoints than Monero's current code (3,784,000, about 15,000 blocks from the top), so a newer engine build could cut this sharply. Worth checking before launch.
- **Scan workers:** the four-worker numbers need measuring. The benchmark is one core.
- **Phones:** not measured.
- **Server speed varies a lot** on public servers (135 to 293 s for the same job), and picking the fastest to answer `get_info` doesn't predict it. Our own node on mainnet solves this.
- **FCMP++/Carrot** changes view tags, around April 2027. The feed's version byte is there for this.


# Stage 2.2 to 2.4: what got built, with the bar set at "instant, not close to it"

Written 2026-11-04. The benchmark: Phantom takes about a minute after a month closed, and that wait is what Walnero has to beat. So "a month closed" is the test.

## What opening means now

No loading screen exists any more. The popup works out its first frame without the engine:

- **Wallet locked:** the unlock screen paints straight away. In the background, the same click starts scanning on all cores and warms the engine.
- **Password:** opens only the saved balance, and the wallet shows. The engine opens behind it.
- **Everything else** happens on a screen that already works, labelled "Checking", then "Up to date".
- **While closed:** a Chrome alarm scans every 30 minutes on two threads, and again when Chrome starts, so a long gap rarely builds up.

## The scanner got about 40 times faster

Written in Rust (`extension/scan-wasm/`, 117 KB of WebAssembly). The old estimate was 2,700 transactions a second per core and 2 minutes for a month on 4 workers.

- The X25519 ladder needs only the y of R, so no square root and no per-key safety checks. Each D then has two sign candidates, both get a view tag check, and the one-time key settles it.
- All ladders share one scalar, so two run side by side in a SIMD register.
- Field multiplies use fused multiply-add on doubles (WebAssembly relaxed SIMD). Two FMAs give the exact high and low halves of a 102 bit product, which WebAssembly can't do with integers.
- Reduced on the fly into signed limbs, so subtraction needs no offset.
- `self_test()` runs every start. A CPU without real FMA, or any mismatch against the plain curve library, falls back to the plain path. Slower, same answers.

**Proof:** `feed/bench/wasm-proof.mjs`. 2,456 keys exact against an unrelated library, including view keys in both ranges, torsion, and all low order encodings. Hidden payments in every shape (main address, subaddress, per-output keys, untagged, output index above 127) all found, no false ones.

**Measured:** this PC is an i7-13620H (6 performance + 4 efficiency cores) on battery. It swings up to 3x depending on which core runs it, so compare like with like. About 17,000 transactions a second on one performance core.

**A month of mainnet-sized traffic in a real browser** (`tests/07-scale.spec.ts`, 1,015,950 transactions, 115 MB, random data shaped like the real measurements, 20 hidden payments, served from this PC): **9.3 s on the first run**, 18.5 s on the last with the laptop warm, on 15 threads. All 20 found, none false, every run. Downloading the files over a real connection comes on top: 115 MB is about 18 s at 50 Mbps.

## The feed as built

Files: `d-<height>.bin` (720 blocks), `h-` (30), `b-` (1), `manifest.json`. Format in `feed/src/format.mjs`. About 119 bytes a transaction, 3.8 MB a day on mainnet.

Changed from 2.1: the tx hash is gone (a hit gives block and position, and the whole block's hashes get fetched anyway, for privacy), and key images are down to 4 bytes (a false match only costs a re-check). One-time keys stay in full: shortening them would save half the size but miss subaddresses beyond a small table, and wallet2 wouldn't. Correctness won.

Not measured yet: miner transactions on mainnet with many outputs (P2Pool) will add some size.

## Real test network result

`tests/06-instant.spec.ts`. The real test wallet, really saved 19,820 blocks (27.5 days) behind, 3 real transactions in the gap, browser started cold. Normal sync through the same gap: **142 to 155 s** (stagenet blocks are nearly empty, so mainnet is far slower).

| Step | Measured |
|---|---|
| Click to unlock screen painted | 0.17 to 0.28 s |
| Password to wallet on screen | 0.27 to 0.39 s usually, 0.6 to 0.84 s on two busier runs, including 1,000,000 rounds of password stretching |
| Checking the whole gap | 0.4 to 0.5 s, and finished before the password was typed once scan keys exist |
| New money on screen | 5.5 to 8.2 s after the password, 16 s on the busiest run |
| Fully live | 8.8 to 11.6 s, 27.9 s on the busiest run |
| Open again while unlocked | 0.07 to 0.22 s |
| Balance and transactions against a normal sync | Exact match, every run that had a current reference. One run looked wrong only because two real transactions had happened since the reference was taken; a fresh normal sync then matched exactly (0.00710858, 5 transactions). |

`tests/08-closed-payment.spec.ts`, real coins: 0.0002 sent while the wallet was locked. The background scan found it with no password in 0.026 s. After unlock the balance rose by exactly 0.0002, and a payment could be built while the wallet was still checking (7.2 s, most of it building the payment).

Most of the seconds after the password are the engine opening a 54 MB cache. That size is a stagenet quirk (old checkpoints). Mainnet's was 0.8 MB, reopening in 0.6 s (one earlier run). **Mainnet hasn't been run end to end.**

One run in about ten took 2 s to the unlock screen, before the marks were added, cause not found.

## Honest limits

- **A lying feed:** handled, see the next section.
- **The view key sits on disk without the password,** sealed with a key the browser generated and won't export. That's what lets a locked wallet scan. A copy of the disk could read incoming history, never spend. Cake makes the same trade by keeping its password in the OS keystore.
- **A month with Chrome fully closed on mainnet** still shows the old balance for the seconds the scan takes, labelled "Checking". It doesn't pretend.
- **The first-ever open of a wallet** shows "Setting up", with Send off until it finishes (155 s on the test network). It walks the chain's block list once (about a minute on mainnet). Only the first time. A newer engine build with newer checkpoints should cut it.
- **Building a payment** took 5 to 8.5 s on public test servers. Not part of opening, but it's the next wait someone will feel.
- **Not tried in branded Chrome yet.** All of this ran in Playwright's Chromium, because branded Chrome refuses to load a test extension from the command line.
- **The feed runs locally for now.** It needs a hosted home.

## A feed that lies

It can't steal or fake a payment, because wallet2 checks anything handed to it. It could only hide one. Scans now count for nothing until they pass (`extension/src/wallet/feed-check.ts`), and the checks run alongside the scan, so they add no wait:

1. **Every block's output count** against a server unrelated to the feed. `get_output_distribution` works on public restricted nodes and costs about 45 KB for a month. Nothing can be dropped or added.
2. **Random blocks rebuilt from real transactions** and compared byte for byte, using the same code the feed builder uses. Up to 12 per scan. Contents can't quietly change. Every wallet picks different blocks, so a feed lying to everyone gets caught fast.
3. **Files are distrusted while parsing.** The scanner checks every length a file claims before using it, so a hostile file can only stop the scan.
4. **On any mismatch** nothing is recorded, the wallet says so on screen and reads block by block. It tries the feed again next open.

`tests/09-lying-feed.spec.ts`, a real proxy rewriting the feed:

| The feed... | Result |
|---|---|
| Drops one transaction and fixes up its own counts | Refused: "Block 2223360 has 7 outputs on the chain, the feed says 5". Nothing recorded. |
| Changes every key, keeping all counts right | Refused by the rebuilt blocks. Nothing recorded. |
| Serves garbage | Refused: file damaged. Nothing recorded. |
| After refusing, the long way | Reached the true balance in 55 s |
| Changes only this wallet's own 5 transactions | **Fooled, as predicted: showed 0 instead of 0.0071.** Random blocks are unlikely to land on those. |
| Claims blocks from the future, with valid empty files | Refused. The wallet never counts past what the chain has confirmed. The first version of the check had this hole; the security sweep found it. |

**The row before that is the limit, stated plainly.** To pull it off, someone has to know which transactions are yours and which download is yours, and control the feed. It hides money, never takes it. Serving every user the same immutable file through a CDN makes it harder still. The answer is **Full check** in Settings: it reads every block since the wallet began, with no feed. A second independent copy of the file hashes is worth adding when the feed gets a real home.

## Real Monero, read-only

`feed/bench/mainnet-sample.mjs`, 120 real mainnet blocks, no keys and no money: all 4,537 transactions and 120 miner transactions parsed. Output counts matched the chain on 120 of 120 blocks. 3.74 MB a day, 112 MB a month, 141 bytes a transaction once miner transactions are counted (one had 722 outputs, from P2Pool). None lacked view tags. The scanner found 0 matches for a throwaway key, as it should, at 13,000 to 14,700 transactions a second on one core while other tests were running.

## Final numbers, on the finished build

2026-11-05, with every safety check in, nothing else running, laptop on battery. The earlier tables were taken before the checks went in or with other tests running.

Real test wallet 19,973 blocks behind, cold browser start, three runs. A normal sync through the same gap took 74.9 s this time (75 to 155 s across the day; stagenet blocks are nearly empty).

| Step | Measured |
|---|---|
| Click to unlock screen | 0.17 to 0.21 s |
| Password to wallet on screen | 0.25 to 0.28 s |
| Open again while unlocked | 0.11 to 0.14 s |
| Checking the whole gap | Done before the password was typed, including the chain checks |
| New money on screen | 5.3, 7.6 and 15.7 s after the password. The 15.7 was a public server being slow to hand over blocks. |
| Fully live | 8.1, 10.9 and 18.6 s |
| Balance and transactions | Exact match every run: 0.00717812, 7 transactions |
| Building a payment | 8.2 to 9.5 s |

A month of mainnet-sized traffic, 1,015,950 transactions, in a real browser: **7.6 to 8.1 s on 15 threads**, 10.1 s on 8, 16 s on 4. All 20 hidden payments found, none false.
