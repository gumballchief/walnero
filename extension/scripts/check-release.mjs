// Builds the real release version and checks nothing meant for tests made it in.
//   node scripts/check-release.mjs            test network release
//   node scripts/check-release.mjs mainnet    real Monero release: also refuses a local feed address, the faucet and the explorer
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const mainnet = process.argv[2] === 'mainnet';
execSync(mainnet ? 'npm run build:mainnet' : 'npm run build', { cwd: root, stdio: 'ignore' });
const output = path.join(root, mainnet ? '.output/chrome-mv3-mainnet' : '.output/chrome-mv3');
const files = fs.readdirSync(output, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(output, f)).isFile());

const banned = ['testImport', 'testFeed', 'testNodes', 'testDropHits', 'runScan', 'window.walnero', 'walnero={call', '.walnero='];
// On real Monero: no local feed server, no faucet (it sends your address to a stranger), no explorer link (it tells a site which transaction is yours).
if (mainnet) banned.push('127.0.0.1', 'cypherfaucet', 'xmrchain');
const problems = [];
if (files.some((f) => /bench/.test(f))) problems.push('the speed test page is in the build');
for (const file of files.filter((f) => /\.(js|html|json)$/.test(f))) {
  const text = fs.readFileSync(path.join(output, file), 'utf8');
  for (const word of banned) if (text.includes(word)) problems.push(`${file} contains "${word}"`);
}
const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
console.log('permissions:', manifest.permissions.join(', '));
console.log('sites:', manifest.host_permissions.join(', '));
console.log(`${files.length} files checked`);
if (problems.length) {
  console.log(`NOT CLEAN:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('CLEAN: no test hooks in the release build');
