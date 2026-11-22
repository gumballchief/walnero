// Copies the wallet engine, fonts and real brand files into public/ before each build. Nothing here is hand-drawn.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const brand = path.resolve(root, '../brand');
const pub = path.join(root, 'public');
const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(pub, to)), { recursive: true }); fs.copyFileSync(from, path.join(pub, to)); };

copy(path.join(root, 'scan-wasm/walnero_scan.wasm'), 'scan/walnero_scan.wasm');
copy(path.join(root, 'scan-wasm/walnero_scan_plain.wasm'), 'scan/walnero_scan_plain.wasm');
copy(path.join(root, 'node_modules/monero-ts/dist/monero.js'), 'engine/monero.js');
copy(path.join(root, 'node_modules/monero-ts/dist/monero.worker.js'), 'engine/monero.worker.js');
for (const size of [16, 32, 48, 128]) copy(path.join(brand, `final/icons/extension-${size}.png`), `icon/${size}.png`);
for (const font of ['GeistSerif-Regular', 'Geist-Medium', 'Geist-SemiBold', 'GeistMono-Medium']) copy(path.join(brand, `fonts/geist/${font}.woff2`), `fonts/${font}.woff2`);
copy(path.join(brand, 'final/logo/w-sky.png'), 'brand/w-sky.png');
copy(path.join(brand, 'final/logo/w-ink.png'), 'brand/w-ink.png');
for (const coin of ['xmr', 'btc', 'eth', 'sol', 'ltc', 'usdt', 'usdc']) copy(path.join(brand, `colors/tokens/${coin}.png`), `coins/${coin}.png`);
for (const name of ['wallet', 'clock-counter-clockwise', 'gear-six', 'arrow-right', 'arrow-down-left', 'arrow-up-right', 'caret-left', 'caret-right', 'check', 'at', 'backspace', 'shield-check', 'globe-hemisphere-west', 'code', 'info', 'question', 'lock-simple', 'scan-smiley', 'key', 'timer', 'copy', 'drop', 'lightning', 'cube', 'hard-drives', 'list', 'chart-line-up', 'arrow-square-out', 'eye', 'plus', 'arrows-clockwise', 'seal-check']) copy(path.join(brand, `app-look/icons/${name}.svg`), `icons/${name}.svg`);
console.log('assets copied');
