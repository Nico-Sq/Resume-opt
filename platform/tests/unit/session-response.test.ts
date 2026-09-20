import { describe, expect, it } from 'vitest';

import { respondWithSession } from '../../apps/web/src/server/http/session-response';

const request = () =>
  new Request('http://localhost:3000/api/v1/session', {
    headers: { 'X-Request-Id': '10000000-0000-4000-8000-000000000001' },
  });

describe('safe session response', () => {
  it('returns only the public identity fields without session metadata', async () => {
    const response = await respondWithSession(request(), {
      getSession: () =>
        Promise.resolve({
          userId: '20000000-0000-4000-8000-000000000002',
          displayName: '测试用户',
          emailVerified: true,
          expiresAt: '2026-09-27T00:00:00.000Z',
        }),
    });

    expect(await response.json()).toEqual({
      data: {
        userId: '20000000-0000-4000-8000-000000000002',
        displayName: '测试用户',
        emailVerified: true,
      },
      traceId: '10000000-0000-4000-8000-000000000001',
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('returns null for an anonymous request and a safe error when PostgreSQL fails', async () => {
    const anonymous = await respondWithSession(request(), {
      getSession: () => Promise.resolve(null),
    });
    expect(((await anonymous.json()) as { data: unknown }).data).toBeNull();

    const unavailable = await respondWithSession(request(), {
      getSession: () => Promise.reject(new Error('database detail')),
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      code: 'SESSION_UNAVAILABLE',
      message: '会话服务暂时不可用',
      traceId: '10000000-0000-4000-8000-000000000001',
      retryable: true,
    });
  });
});
