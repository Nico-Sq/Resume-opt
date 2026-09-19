import { defineConfig } from '@playwright/test';

const fixedIdentity = {
  APP_ENV: 'local',
  AUTH_MODE: 'fixed',
  DEV_FIXED_USER_ID: '00000000-0000-4000-8000-000000000001',
  DEV_FIXED_RESUME_ID: '00000000-0000-4000-8000-000000000002',
  DEV_FIXED_VERSION_ID: '00000000-0000-4000-8000-000000000003',
};

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: 'artifacts/playwright',
  reporter: [['line']],
  use: {
    baseURL: 'http://localhost:3000',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    headless: true,
    locale: 'zh-CN',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: fixedIdentity,
  },
});
