import { describe, expect, it } from 'vitest';

import { parseServerRuntimeConfig } from '@resume/config/server';

const validInput = {
  APP_ENV: 'local',
  AUTH_MODE: 'fixed',
  PG_DEV_URL: 'postgresql://app:secret@db.local:5432/resume_opt_dev',
  PG_MIGRATION_URL: 'postgresql://migrator:secret@db.local:5432/resume_opt_dev',
  PG_TEST_URL: 'postgresql://test:secret@db.local:5432/resume_opt_test',
  DEV_FIXED_USER_ID: '00000000-0000-4000-8000-000000000001',
  DEV_FIXED_RESUME_ID: '00000000-0000-4000-8000-000000000002',
};

describe('server runtime configuration', () => {
  it('parses isolated development, migration and test connections', () => {
    const config = parseServerRuntimeConfig(validInput);

    expect(config.DATABASE_POOL_MAX).toBe(5);
    expect(new URL(config.PG_TEST_URL).pathname).toBe('/resume_opt_test');
  });

  it('rejects fixed identity outside local and test environments', () => {
    expect(() => parseServerRuntimeConfig({ ...validInput, APP_ENV: 'production' })).toThrow(
      '固定身份只允许用于 local/test',
    );
  });

  it('rejects a test connection aimed at the development database', () => {
    expect(() =>
      parseServerRuntimeConfig({ ...validInput, PG_TEST_URL: validInput.PG_DEV_URL }),
    ).toThrow('测试连接必须指向 resume_opt_test');
  });

  it('does not expose unrelated process variables in the parsed contract', () => {
    const config = parseServerRuntimeConfig({ ...validInput, UNEXPECTED_SECRET: 'value' });

    expect(config).not.toHaveProperty('UNEXPECTED_SECRET');
  });
});
