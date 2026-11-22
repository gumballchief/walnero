# Extension notes

What worked when getting Monero's wallet engine (monero-ts 0.11.21) running in a Manifest V3 extension. Proven by `tests/01-engine.spec.ts` on 2026-11-04.

- The wallet lives in an offscreen document (`src/entrypoints/offscreen`), reason `WORKERS`. Service workers get killed after about 30 seconds idle; the offscreen document stays up.
- CSP needs `script-src 'self' 'wasm-unsafe-eval'`.
- `dist/monero.js` is only the WebAssembly module, not the API. The API is `monero-ts` itself, bundled by Vite with `fs`, `http`, `https`, `child_process` and `socks-proxy-agent` aliased to an empty stub and `path` to `path-browserify`. It never takes those code paths in a browser. It also needs the `assert` package.
- `dist/monero.worker.js` is ready to use as is. It's copied to `public/engine/` and pointed at with `LibraryUtils.setWorkerDistPath(chrome.runtime.getURL('engine/monero.worker.js'))`. Heavy work runs there with `proxyToWorker: true`.
- Chrome's branded builds no longer honour `--load-extension`, so tests use Playwright's Chromium (`channel: 'chromium'`), installed inside node_modules with `PLAYWRIGHT_BROWSERS_PATH=0`.
- `tests/stagenet-test-wallet.json` is a throwaway stagenet wallet. Stagenet coins have no value. Never put a real seed in this repo.

## Instant open (Stage 2.2 to 2.4)

- Run the feed first: `node feed/src/feed.mjs --node http://node.monerodevs.org:38089 --days 31 --port 8787 --out feed/data/stagenet` from the repo root. Without it the wallet falls back to a normal sync, on purpose.
- Rebuild the scanner with `npm run scan:build`. `tools/gen-field.mjs` writes `src/field_gen.rs`. A built copy of the `.wasm` is kept in `scan-wasm/` because Smart App Control can block toolchains. No crate here may have a build script.
- `tests/06-instant` and `tests/08-closed-payment` need `extension/scripts/make-month-old-wallet.mjs` output served on 8788 (`feed/bench/make-synth.mjs` serves that folder). Its true balance goes stale after any real send, so regenerate it. `08` and `04` spend real test coins.
- Before public release remove: `window.walnero`, offscreen `testImport` and `timing`, the bench page, `http://127.0.0.1:8787/*` from host permissions.

Test builds: `npm run build:test` writes to `.output/chrome-mv3-test` and is the only build with test hooks and the bench page. `npm run build` writes the release to `.output/chrome-mv3`. `node scripts/check-release.mjs` proves the release has none of it.

## Real Monero (2026-11-07)

- `npm run build:mainnet` is the real-Monero release, `npm run build:mainnet-test` the same with test hooks (`.output/chrome-mv3-mainnet(-test)`). Plain `build` and `build:test` stay on the test network.
- Servers for each network live in `src/wallet/servers.ts`; the build config reads them for site permissions.
- Feed for real Monero, run locally until the hosted feed is up:
  `node feed/src/feed.mjs --node https://node.chaoswg.dev,https://xmr.thinhhv.com,https://xmr-au-1.cryptovps.io,https://xmr.mony.st,https://node.xmr.indst.eu,https://xmr.0xrpc.io --days 3 --port 8797 --out feed/data/mainnet --concurrency 6`
- Test wallet: `node scripts/mainnet-wallet.mjs setup|check|gap [blocks]`. `gap` uses a throwaway empty wallet; `check` opens the real test wallet. None of them ever send money.

## Names tab and motion (2026-11-07)

- Names are saved per wallet in IndexedDB key `names`, sealed with the password key. Offscreen methods: `names`, `saveName`, `removeName`, `usedName`.
- Send is two steps now: `send-amount` + `amount-next`, then `send-address` + `review-go` (or a `pick-<name>` chip, which reviews by itself). The amount and recipient inputs are see-through and sit over the chips, so typing, pasting and tests all still work.
- Motion lives in `theme.css` under "Motion from the approved send flow". `Head` and `Nav` are outside `App` on purpose: inside, they were rebuilt on every 2.5 s refresh, which restarts animations.
- `tests/12-states` and `06` need the synth folder served on 8788. Serving the existing files is enough; `make-synth.mjs` regenerates them, which breaks `month-old.json`.

## Balance fixes and Send speed (2026-11-07)

- Pool check: `poolImages` / `leavingInPool` in offscreen, used by `refresh`. Reads /get_transaction_pool_hashes and pruned /get_transactions for new pool txs only (cached by hash).
- Spend check after live: `spendsOfNewCoins` + `findSpends` (scan-pool.ts). Result shows in `timing().spendCheck` as { coins, leads, found }. Frozen coins stay frozen until a full check rebuilds the wallet.
- Test switch `testDropHits({ heights, check })` (test builds only, banned in check-release) makes the scan miss blocks.
- Send pauses background refreshes: `sendOpen` (called when the Send screen mounts) and estimate pause; `home` and `send` resume. Never stops the catch-up itself or a full check.
- Repro scripts: `scripts/repro-pool-spend.mjs [amount] [late]` (needs .output/chrome-mv3-test-before for the old side), `scripts/repro-swept-coin.mjs`, `scripts/time-estimate.mjs [wait] [open]`, `scripts/mainnet-wallet.mjs review` (builds only, never sends).
