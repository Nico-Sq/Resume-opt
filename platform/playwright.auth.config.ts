import { defineConfig } from '@playwright/test';

const port = process.env.PLAYWRIGHT_AUTH_PORT ?? '3300';
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'real-auth.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  outputDir: 'artifacts/playwright-auth',
  reporter: process.env.CI
    ? [
        ['github'],
        ['line'],
        [
          './scripts/ci/sanitized-playwright-reporter.ts',
          {
            scope: 'V02-032-real-auth-chrome',
            outputPath: 'artifacts/ci/playwright-auth.json',
          },
        ],
      ]
    : [['line']],
  projects: [{ name: 'real-auth-chrome' }],
  use: {
    baseURL,
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    headless: true,
    locale: 'zh-CN',
    trace: 'off',
  },
  webServer: {
    command: 'pnpm --filter @resume/web start',
    url: `${baseURL}/api/health/ready`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      APP_ENV: 'test',
      AUTH_MODE: 'better-auth',
      BETTER_AUTH_URL: baseURL,
      PORT: port,
    },
  },
});
