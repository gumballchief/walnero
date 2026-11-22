// Builds the wallet for the iPhone app: npm run build:phone -> .output/phone-web, which the iOS project bundles.
// WALNERO_FEED / WALNERO_FEED_TEST set the real-Monero and test-network feed addresses (for a development build, point them at a local feed through a tunnel).
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = import.meta.dirname;
const src = path.resolve(here, 'src');
const empty = path.resolve(src, 'shim/empty.ts');

export default defineConfig({
  root: path.resolve(here, 'app'),
  publicDir: path.resolve(here, 'public'),
  base: './',
  plugins: [react()],
  define: {
    'import.meta.env.VITE_PHONE': JSON.stringify('1'),
    'import.meta.env.VITE_FEED_MAINNET': JSON.stringify(process.env.WALNERO_FEED ?? ''),
    'import.meta.env.VITE_FEED_STAGENET': JSON.stringify(process.env.WALNERO_FEED_TEST ?? ''),
    'import.meta.env.VITE_VERSION': JSON.stringify(process.env.WALNERO_VERSION ?? '0.8.0'),
  },
  resolve: {
    alias: [
      { find: '@/wallet/vault', replacement: path.resolve(here, 'app/vault.ts') },
      { find: '@/wallet/network', replacement: path.resolve(here, 'app/network.ts') },
      { find: /^@\//, replacement: `${src}/` },
      // monero-ts carries Node-only code paths it never takes in a browser, the same as the extension build.
      { find: /^(fs|http|https|child_process|socks-proxy-agent)$/, replacement: empty },
      { find: /^path$/, replacement: 'path-browserify' },
    ],
  },
  build: { outDir: path.resolve(here, '.output/phone-web'), emptyOutDir: true, target: 'safari16', chunkSizeWarningLimit: 8000 },
});
