import path from 'node:path';
import { defineConfig } from 'wxt';
import { networkOfMode, SERVERS, sitePattern } from './src/wallet/servers';

// --mode picks the build: production and test are Monero's test network, mainnet and mainnet-test are real Monero.
const modeAt = process.argv.indexOf('--mode');
const mode = modeAt >= 0 ? process.argv[modeAt + 1] : 'production';
const network = SERVERS[networkOfMode(mode)];
const hosts = [...new Set([...network.nodes, network.feed].map(sitePattern))];

const empty = path.resolve(import.meta.dirname, 'src/shim/empty.ts');

const testBuild = mode === 'test' || mode === 'mainnet-test';

export default defineConfig({
  srcDir: 'src',
  // The speed test page never goes in a release.
  filterEntrypoints: testBuild ? undefined : ['background', 'popup', 'offscreen', 'pay'],
  modules: ['@wxt-dev/module-react'],
  // monero-ts carries Node-only code paths it never takes in a browser, so those imports resolve to nothing here.
  vite: () => ({
    resolve: {
      alias: {
        fs: empty,
        http: empty,
        https: empty,
        child_process: empty,
        'socks-proxy-agent': empty,
        path: 'path-browserify',
      },
    },
  }),
  manifest: {
    name: 'Walnero',
    description: 'Monero in seconds.',
    permissions: ['offscreen', 'unlimitedStorage', 'clipboardWrite', 'alarms'],
    host_permissions: hosts,
    // Asked for one site at a time, only when someone adds their own node in Settings, Network, Node.
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    // WebAssembly is how Monero's own wallet code runs here. Everything else stays strict.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    action: { default_title: 'Walnero', default_icon: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png' } },
  },
});
