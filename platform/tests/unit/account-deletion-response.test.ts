import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  respondToDeleteAccount,
  type AccountDeletionRequestStore,
  type AccountDeletionSessionProvider,
} from '../../apps/web/src/server/http/account-deletion-response';

const origin = 'http://localhost:3000';
const userId = '11111111-1111-4111-8111-111111111111';

function request(body: unknown, key = randomUUID()) {
  return new Request(`${origin}/api/v1/account`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      Origin: origin,
      'X-CSRF-Token': 'csrf-token',
    },
    body: JSON.stringify(body),
  });
}

function dependencies(createdAt: Date) {
  const revokeAllSessions = vi.fn().mockResolvedValue(undefined);
  const accept = vi.fn().mockResolvedValue({
    requestId: '22222222-2222-4222-8222-222222222222',
    requestedAt: '2026-09-22T00:00:00.000Z',
    replayed: false,
  });
  const recordAuthRevocation = vi.fn().mockResolvedValue(undefined);
  const provider: AccountDeletionSessionProvider = {
    getSession: vi.fn().mockResolvedValue({ userId, emailVerified: true }),
    getCsrfToken: vi.fn().mockResolvedValue('csrf-token'),
    getAuthoritativeSession: vi.fn().mockResolvedValue({
      userId,
      emailVerified: true,
      createdAt,
    }),
    verifyCurrentPassword: vi.fn().mockResolvedValue(true),
    revokeAllSessions,
  };
  const store: AccountDeletionRequestStore = {
    accept,
    recordAuthRevocation,
  };
  return { accept, provider, recordAuthRevocation, revokeAllSessions, store };
}

describe('account deletion response', () => {
  it('rejects a session older than the ten-minute reauthentication window', async () => {
    const now = Date.parse('2026-09-22T00:10:00.000Z');
    const { accept, provider, store } = dependencies(new Date(now - 10 * 60 * 1_000));

    const response = await respondToDeleteAccount(
      request({ confirm: true, password: 'correct-password' }),
      provider,
      store,
      origin,
      now,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
    expect(accept).not.toHaveBeenCalled();
  });

  it('keeps an accepted deletion successful when Auth session revocation is temporarily down', async () => {
    const now = Date.parse('2026-09-22T00:05:00.000Z');
    const { provider, recordAuthRevocation, revokeAllSessions, store } = dependencies(
      new Date(now - 60_000),
    );
    revokeAllSessions.mockRejectedValueOnce(new Error('auth unavailable'));

    const response = await respondToDeleteAccount(
      request({ confirm: true, password: 'correct-password' }),
      provider,
      store,
      origin,
      now,
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      data: { status: 'accepted', requestId: '22222222-2222-4222-8222-222222222222' },
    });
    expect(recordAuthRevocation).toHaveBeenCalledWith(
      userId,
      '22222222-2222-4222-8222-222222222222',
      'AUTH_SESSION_REVOCATION_FAILED',
    );
  });

  it('requires an exact confirmation and the current password', async () => {
    const now = Date.parse('2026-09-22T00:05:00.000Z');
    const { accept, provider, store } = dependencies(new Date(now - 60_000));

    const response = await respondToDeleteAccount(
      request({ confirm: false, password: 'correct-password' }),
      provider,
      store,
      origin,
      now,
    );

    expect(response.status).toBe(422);
    expect(accept).not.toHaveBeenCalled();
  });
});
