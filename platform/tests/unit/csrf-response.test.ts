import { describe, expect, it, vi } from 'vitest';

import {
  rejectUnsafeCookieWrite,
  respondWithCsrf,
  type CsrfSessionProvider,
} from '../../apps/web/src/server/http/csrf-response';

const session = {
  userId: '10000000-0000-4000-8000-000000000001',
  displayName: '测试用户',
  emailVerified: true,
  expiresAt: '2026-09-27T00:00:00.000Z',
};

function provider(overrides: Partial<CsrfSessionProvider> = {}): CsrfSessionProvider {
  return {
    getSession: () => Promise.resolve(session),
    getCsrfToken: () => Promise.resolve('derived-csrf-token'),
    ...overrides,
  };
}

function writeRequest(headers: Record<string, string> = {}) {
  return new Request('https://resume.example/api/v1/resumes/1/document', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      origin: 'https://resume.example',
      'sec-fetch-site': 'same-origin',
      'x-csrf-token': 'derived-csrf-token',
      ...headers,
    },
    body: '{}',
  });
}

describe('cookie write security boundary', () => {
  it('issues only a derived CSRF token for a verified session', async () => {
    const response = await respondWithCsrf(
      new Request('https://resume.example/api/v1/csrf'),
      provider(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { csrfToken: 'derived-csrf-token' } });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('rejects missing or cross-site origins before reading the session', async () => {
    const getSession = vi.fn(() => Promise.resolve(session));
    const target = provider({ getSession });
    const missingOrigin = writeRequest({ origin: '' });
    const crossSite = writeRequest({
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    });

    expect(
      (await rejectUnsafeCookieWrite(missingOrigin, 'https://resume.example', target))?.status,
    ).toBe(403);
    expect(
      (await rejectUnsafeCookieWrite(crossSite, 'https://resume.example', target))?.status,
    ).toBe(403);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('requires JSON, a verified session and the exact session-bound token', async () => {
    const wrongMedia = await rejectUnsafeCookieWrite(
      writeRequest({ 'content-type': 'text/plain' }),
      'https://resume.example',
      provider(),
    );
    const anonymous = await rejectUnsafeCookieWrite(
      writeRequest(),
      'https://resume.example',
      provider({
        getSession: () => Promise.resolve(null),
        getCsrfToken: () => Promise.resolve(null),
      }),
    );
    const wrongToken = await rejectUnsafeCookieWrite(
      writeRequest({ 'x-csrf-token': 'wrong' }),
      'https://resume.example',
      provider(),
    );
    const accepted = await rejectUnsafeCookieWrite(
      writeRequest(),
      'https://resume.example',
      provider(),
    );

    expect(wrongMedia?.status).toBe(415);
    expect(anonymous?.status).toBe(401);
    expect(wrongToken?.status).toBe(403);
    expect(accepted).toBeNull();
  });

  it('does not echo or log session-token failures', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await respondWithCsrf(
      new Request('https://resume.example/api/v1/csrf'),
      provider({ getCsrfToken: () => Promise.reject(new Error('raw-session-token')) }),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('raw-session-token');
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
