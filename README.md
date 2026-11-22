# Walnero

A Monero wallet that opens in seconds. A Chrome extension and an iPhone app, built on Monero's own wallet code.

**Website:** [walnero.org](https://walnero.org)

Most Monero wallets make you wait through a sync every time you come back. Walnero shows your balance and lets you
pay within seconds, without ever sending your keys anywhere.

## Status

Early and in active development. It works on real Monero, but there is no store release yet: the hosted feed server
isn't live, so builds point at a feed you run yourself, and `check-release.mjs` refuses to pass a release until that
changes. Use small amounts.

## What it does

- Opens in seconds, even after weeks closed (see "How fast open works")
- Your keys and recovery words never leave your device
- Face ID on iPhone, auto-lock, tap the balance to hide it
- Send to saved names like `@kestrel` instead of pasting long addresses
- A fresh receive address every time
- A live price chart and every payment's full details, with an optional block explorer link
- A test network mode (stagenet) to try everything with free coins
- Run a full block-by-block check any time

## How fast open works

1. **The feed** (`feed/`) reads new blocks from public Monero nodes and writes them into small static files: the
   same files for everyone, no accounts, no per-user requests. It never sees a key.
2. **The wallet** downloads the files it missed and scans them on your device with your view key
   (`extension/scan-wasm`, Rust compiled to WebAssembly). Only the wallet learns which transactions are yours.
3. It hands those transactions to **wallet2**, Monero's own wallet library (through
   [monero-ts](https://github.com/woodser/monero-ts)), which adds the money, marks spends and catches up from there.
4. **Nothing is trusted blindly.** The feed's results are checked against independent Monero nodes. If they
   don't match, Walnero ignores the feed and reads the chain block by block. A full check from scratch is one tap away.

The design notes and measurements are in `feed/RESEARCH.md`.

## Repository

| Folder | What it is |
|---|---|
| `extension/` | The wallet: React UI, the wallet engine (offscreen document), the scanner, tests. Also builds the iPhone app's web bundle |
| `extension/scan-wasm/` | The block scanner in Rust (vendored `curve25519-dalek`, see its LICENSE) |
| `ios/` | The iPhone app: a SwiftUI shell around the wallet, Face ID and Keychain, native storage |
| `feed/` | The fast-open feed server and its benchmarks |
| `server/` | The swap price API |
| `site/` | The website |
| `brand/` | Logos, icons, fonts (Geist, SIL Open Font License) |
| `docs/` | Design notes, including how an on-device AI assistant can work without breaking privacy |

## Build

Needs Node 20+.

```sh
cd extension
npm install
npm run build:mainnet        # Chrome extension for real Monero -> .output/chrome-mv3-mainnet
npm run build                # test network build -> .output/chrome-mv3
node scripts/check-release.mjs mainnet   # proves no test-only code is in the release
```

Load the output folder in `chrome://extensions` with Developer mode on.

**iPhone app:** `npm run build:phone` in `extension/` writes the web bundle to `ios/web`, then generate the Xcode
project with [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`cd ios && xcodegen generate`) and build. The GitHub
Actions workflow in `.github/workflows/ios.yml` does all of this on a cloud Mac and runs the simulator test.

**Feed:** `node feed/src/feed.mjs --node <monero node url> --days 31 --port 8787 --out feed/data/stagenet`.
Set `WALNERO_FEED` / `WALNERO_FEED_TEST` when building to point the app at it.

**Tests** use throwaway test-network wallets that are not in this repo. Copy
`extension/tests/stagenet-test-wallet.example.json` to `stagenet-test-wallet.json` (and `stagenet-second-wallet.json`)
with your own stagenet wallet. Never put a real seed in a file in this repo.

## Security

Please report security problems privately, not in a public issue. See [SECURITY.md](SECURITY.md).

## Licence

MIT, see [LICENSE](LICENSE). Third-party parts keep their own licences: monero-ts (MIT), curve25519-dalek (BSD-3),
Geist fonts (OFL), Phosphor icons (MIT), TradingView Lightweight Charts (Apache 2.0).
