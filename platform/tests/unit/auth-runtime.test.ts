import { afterEach, describe, expect, it, vi } from 'vitest';

import { getBetterAuthServer } from '../../apps/web/src/server/runtime';

afterEach(() => vi.unstubAllEnvs());

describe('Better Auth runtime fail-closed boundaries', () => {
  it('does not fall back to the fixed identity mode', () => {
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('AUTH_MODE', 'fixed');
    vi.stubEnv('PG_DEV_URL', 'postgresql://app:secret@db.local:5432/resume_opt_dev');
    vi.stubEnv('DEV_FIXED_USER_ID', '10000000-0000-4000-8000-000000000001');
    vi.stubEnv('DEV_FIXED_RESUME_ID', '10000000-0000-4000-8000-000000000002');
    vi.stubEnv('DEV_FIXED_VERSION_ID', '10000000-0000-4000-8000-000000000003');

    expect(() => getBetterAuthServer()).toThrow('真实身份服务未配置');
  });

  it('keeps public environments closed until a real mail sender is configured', () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('AUTH_MODE', 'better-auth');
    vi.stubEnv('PG_DEV_URL', 'postgresql://app:secret@db.example:5432/resume_opt_production');
    vi.stubEnv('PG_AUTH_URL', 'postgresql://auth:secret@db.example:5432/resume_opt_production');
    vi.stubEnv('BETTER_AUTH_URL', 'https://resume.example.cn');
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-only-secret-with-at-least-32-characters');

    expect(() => getBetterAuthServer()).toThrow('公开环境邮件发送器尚未配置');
  });
});
