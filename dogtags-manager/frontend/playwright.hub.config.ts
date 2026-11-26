import { defineConfig } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL;
if (!baseURL || !process.env.E2E_USERNAME || !process.env.E2E_PASSWORD) {
  throw new Error('Real HUB tests require explicit E2E_BASE_URL, E2E_USERNAME and E2E_PASSWORD.');
}
const target = new URL(baseURL);
if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
    || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
  throw new Error('HUB acceptance may run only against an explicit loopback HTTP service.');
}

export default defineConfig({
  testDir: './tests',
  testMatch: ['hub/**/*.spec.ts', 'e2e/**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL,
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
  },
});
