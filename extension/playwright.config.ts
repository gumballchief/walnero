import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 480_000,
  workers: 1,
  reporter: 'list',
});
