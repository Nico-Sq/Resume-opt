import { describe, expect, it } from 'vitest';

import { parseDatabaseToolConfig, parseServerRuntimeConfig } from '@resume/config/server';

const fixedInput = {
  APP_ENV: 'local',
  AUTH_MODE: 'fixed',
  PG_DEV_URL: 'postgresql://app:secret@db.local:5432/resume_opt_dev',
  DEV_FIXED_USER_ID: '00000000-0000-4000-8000-000000000001',
  DEV_FIXED_RESUME_ID: '00000000-0000-4000-8000-000000000002',
  DEV_FIXED_VERSION_ID: '00000000-0000-4000-8000-000000000003',
};
const realAuthInput = {
  AUTH_MODE: 'better-auth',
  PG_AUTH_URL: 'postgresql://auth:secret@db.local:5432/resume_opt_dev',
  BETTER_AUTH_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'test-only-secret-with-at-least-32-characters',
};

describe('server runtime configuration', () => {
  it.each([
    ['local', 'fixed'],
    ['test', 'fixed'],
    ['local', 'better-auth'],
    ['test', 'better-auth'],
    ['staging', 'better-auth'],
    ['production', 'better-auth'],
  ] as const)('accepts the supported %s + %s startup mode', (appEnvironment, authMode) => {
    const publicEnvironment = ['staging', 'production'].includes(appEnvironment);
    const database = publicEnvironment ? `resume_opt_${appEnvironment}` : 'resume_opt_dev';
    const input = {
      ...(authMode === 'fixed' ? fixedInput : realAuthInput),
      APP_ENV: appEnvironment,
      AUTH_MODE: authMode,
      PG_DEV_URL: `postgresql://app:secret@db.local:5432/${database}`,
      ...(authMode === 'better-auth'
        ? {
            PG_AUTH_URL: `postgresql://auth:secret@db.local:5432/${database}`,
            BETTER_AUTH_URL: publicEnvironment
              ? `https://${appEnvironment}.example.cn`
              : 'http://localhost:3000',
          }
        : {}),
    };

    expect(() => parseServerRuntimeConfig(input)).not.toThrow();
  });

  it.each(['staging', 'production'] as const)('rejects fixed identity in %s', (appEnvironment) => {
    expect(() => parseServerRuntimeConfig({ ...fixedInput, APP_ENV: appEnvironment })).toThrow(
      '固定身份只允许用于 local/test',
    );
  });

  it.each(['PG_AUTH_URL', 'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET'] as const)(
    'rejects real auth without %s',
    (missingKey) => {
      const input: Record<string, string | undefined> = { ...fixedInput, ...realAuthInput };
      input[missingKey] = undefined;
      expect(() => parseServerRuntimeConfig(input)).toThrow('真实身份模式必须配置该值');
    },
  );

  it('rejects missing business, migration and test database configuration', () => {
    expect(() => parseServerRuntimeConfig({ ...fixedInput, PG_DEV_URL: undefined })).toThrow();
    expect(() => parseDatabaseToolConfig({ APP_ENV: 'local' }, 'migration')).toThrow(
      '缺少 PG_MIGRATION_URL',
    );
    expect(() => parseDatabaseToolConfig({ APP_ENV: 'test' }, 'test')).toThrow('缺少 PG_TEST_URL');
    expect(() => parseDatabaseToolConfig({ APP_ENV: 'test' }, 'privacy')).toThrow(
      '缺少 PG_PRIVACY_URL',
    );
  });

  it('keeps runtime credentials separate from migration and test tools', () => {
    const config = parseServerRuntimeConfig({
      ...fixedInput,
      PG_MIGRATION_URL: 'postgresql://migrator:secret@db.local/resume_opt_dev',
      PG_TEST_URL: 'postgresql://test:secret@db.local/resume_opt_test',
      PG_PRIVACY_URL: 'postgresql://privacy:secret@db.local/resume_opt_test',
    });

    expect(config).not.toHaveProperty('PG_MIGRATION_URL');
    expect(config).not.toHaveProperty('PG_TEST_URL');
    expect(config).not.toHaveProperty('PG_PRIVACY_URL');
  });

  it('rejects mismatched or shared business and auth database roles', () => {
    expect(() =>
      parseServerRuntimeConfig({
        ...fixedInput,
        ...realAuthInput,
        PG_AUTH_URL: 'postgresql://auth:secret@other.local:5432/resume_opt_dev',
      }),
    ).toThrow('必须连接同一 PostgreSQL 数据库');
    expect(() =>
      parseServerRuntimeConfig({
        ...fixedInput,
        ...realAuthInput,
        PG_AUTH_URL: fixedInput.PG_DEV_URL,
      }),
    ).toThrow('必须使用不同数据库角色');
  });

  it('accepts only an origin as the Better Auth base URL', () => {
    expect(() =>
      parseServerRuntimeConfig({
        ...fixedInput,
        ...realAuthInput,
        BETTER_AUTH_URL: 'http://user:password@localhost:3000/private?token=value',
      }),
    ).toThrow('认证地址必须是无凭据、无路径的站点 Origin');
    expect(() =>
      parseServerRuntimeConfig({
        ...fixedInput,
        ...realAuthInput,
        APP_ENV: 'production',
        PG_DEV_URL: 'postgresql://app:secret@db.local:5432/resume_opt_production',
        PG_AUTH_URL: 'postgresql://auth:secret@db.local:5432/resume_opt_production',
      }),
    ).toThrow('必须使用 HTTPS');
  });

  it('rejects development tools aimed at production or test databases', () => {
    expect(() =>
      parseDatabaseToolConfig(
        {
          APP_ENV: 'local',
          PG_MIGRATION_URL: 'postgresql://migrator:secret@db.local/resume_opt_production',
        },
        'migration',
      ),
    ).toThrow('必须指向 resume_opt_dev');
    expect(() =>
      parseDatabaseToolConfig(
        {
          APP_ENV: 'production',
          PG_MIGRATION_URL: 'postgresql://migrator:secret@db.local/resume_opt_dev',
        },
        'migration',
      ),
    ).toThrow('不得指向管理库、开发库或测试库');
    expect(() =>
      parseDatabaseToolConfig(
        {
          APP_ENV: 'test',
          PG_TEST_URL: 'postgresql://test:secret@db.local/resume_opt_dev',
        },
        'test',
      ),
    ).toThrow('测试连接必须指向 resume_opt_test');
  });

  it('keeps privacy cleanup on its isolated test role until deletion export is verified', () => {
    const connectionString = 'postgresql://resume_opt_privacy:secret@db.local:5432/resume_opt_test';
    expect(
      parseDatabaseToolConfig({ APP_ENV: 'test', PG_PRIVACY_URL: connectionString }, 'privacy'),
    ).toEqual({ appEnvironment: 'test', connectionString });
    expect(() =>
      parseDatabaseToolConfig(
        { APP_ENV: 'production', PG_PRIVACY_URL: connectionString },
        'privacy',
      ),
    ).toThrow('只允许 APP_ENV=test');
    expect(() =>
      parseDatabaseToolConfig(
        {
          APP_ENV: 'test',
          PG_PRIVACY_URL: 'postgresql://resume_opt_test:secret@db.local/resume_opt_test',
        },
        'privacy',
      ),
    ).toThrow('必须使用 resume_opt_privacy');
  });

  it('does not include a failing connection URL or password in configuration errors', () => {
    const unsafeUrl = 'postgresql://app:do-not-leak@db.local:5432/resume_opt_test';
    let message = '';
    try {
      parseServerRuntimeConfig({ ...fixedInput, PG_DEV_URL: unsafeUrl });
    } catch (error) {
      message = String(error);
    }

    expect(message).not.toContain(unsafeUrl);
    expect(message).not.toContain('do-not-leak');
  });
});
