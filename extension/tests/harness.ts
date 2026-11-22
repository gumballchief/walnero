import { chromium, test as base, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';

const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3-test');
export const SHOTS = path.resolve(import.meta.dirname, '../test-shots');

export const test = base.extend<{ context: BrowserContext; extensionId: string; popup: Page }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      viewport: { width: 380, height: 600 },
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(new URL(worker.url()).host);
  },
  popup: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await use(page);
    if (problems.length) console.log('page errors:', problems.join('\n'));
  },
});
export { expect } from '@playwright/test';
