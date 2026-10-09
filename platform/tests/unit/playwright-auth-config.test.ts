import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Playwright identity isolation', () => {
  it('runs fixed and real-auth Chrome suites on separate managed servers', async () => {
    const [fixedConfig, authConfig, packageJsonText] = await Promise.all([
      readFile(resolve(import.meta.dirname, '../../playwright.config.ts'), 'utf8'),
      readFile(resolve(import.meta.dirname, '../../playwright.auth.config.ts'), 'utf8'),
      readFile(resolve(import.meta.dirname, '../../package.json'), 'utf8'),
    ]);
    const packageJson = JSON.parse(packageJsonText) as { scripts: Record<string, string> };

    expect(fixedConfig).toContain("AUTH_MODE: 'fixed'");
    expect(fixedConfig).toContain("PLAYWRIGHT_PORT ?? '3200'");
    expect(fixedConfig).toContain("testIgnore: 'real-auth.spec.ts'");
    expect(fixedConfig).toContain("name: 'fixed-chrome'");
    expect(fixedConfig).toContain('sanitized-playwright-reporter.ts');
    expect(fixedConfig).toContain('reuseExistingServer: false');
    expect(authConfig).toContain("AUTH_MODE: 'better-auth'");
    expect(authConfig).toContain("PLAYWRIGHT_AUTH_PORT ?? '3300'");
    expect(authConfig).toContain("testMatch: 'real-auth.spec.ts'");
    expect(authConfig).toContain("name: 'real-auth-chrome'");
    expect(authConfig).toContain('sanitized-playwright-reporter.ts');
    expect(authConfig).toContain("trace: 'off'");
    expect(authConfig).toContain('reuseExistingServer: false');
    expect(packageJson.scripts['test:browser']).toContain('test:browser:auth');
    expect(packageJson.scripts['test:browser:fixed']).toContain('playwright.config.ts');
    expect(packageJson.scripts['test:browser:auth']).toContain('playwright.auth.config.ts');
  });
});
