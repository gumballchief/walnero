// Writes public/THIRD-PARTY-NOTICES.txt: the license of everything Walnero is built on, so it ships inside every
// extension and iPhone build (and is readable in the repo). Run after npm install:  node scripts/notices.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8').trim();
const rule = '='.repeat(100);
const parts = [
  'Walnero is open source under the MIT license (see LICENSE). It is built on the open-source work below.',
  'The heart of the wallet is wallet2, the Monero Project\'s own wallet code, run through monero-ts.',
  '',
];
const add = (title, text) => parts.push(rule, title, rule, '', text, '');

add('Monero (wallet2), https://github.com/monero-project/monero', read(path.join(here, 'licenses/monero.txt')));
add('curve25519-dalek (inside the block scanner), https://github.com/dalek-cryptography/curve25519-dalek', read(path.join(here, 'scan-wasm/vendor/curve25519-dalek/LICENSE')));
add('Phosphor Icons, https://phosphoricons.com', read(path.join(here, 'licenses/phosphor-icons.txt')));
add('Geist and Geist Mono fonts, https://vercel.com/font', read(path.join(here, '../brand/fonts/geist/LICENSE.txt')));

// Every npm package that ships in a build (production dependencies, including their own dependencies).
const tree = JSON.parse(execSync('npm ls --omit=dev --all --json', { cwd: here, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const seen = new Map();
(function walk(deps) {
  for (const [name, info] of Object.entries(deps || {})) {
    const key = `${name}@${info.version}`;
    if (!seen.has(key)) seen.set(key, name);
    walk(info.dependencies);
  }
})(tree.dependencies);

for (const [key, name] of [...seen].sort(([a], [b]) => a.localeCompare(b))) {
  const dir = path.join(here, 'node_modules', name);
  if (!fs.existsSync(dir)) continue;
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? 'see package';
  const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  add(`${key} (${license})${pkg.homepage ? `, ${pkg.homepage}` : ''}`, file ? read(path.join(dir, file)) : `License: ${license} (no license file in the package)`);
}

fs.writeFileSync(path.join(here, 'public/THIRD-PARTY-NOTICES.txt'), parts.join('\n') + '\n');
console.log(`wrote public/THIRD-PARTY-NOTICES.txt: 4 + ${seen.size} components`);
