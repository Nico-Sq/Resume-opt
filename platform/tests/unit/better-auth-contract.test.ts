import { describe, expect, it } from 'vitest';

import {
  BETTER_AUTH_CLI_VERSION,
  BETTER_AUTH_DATABASE,
  BETTER_AUTH_ENDPOINTS,
  BETTER_AUTH_SCHEMA_MODELS,
  BETTER_AUTH_VERSION,
  betterAuthCoreOptions,
  toAuthenticatedSession,
} from '@resume/infrastructure/better-auth-contract';
import { auth } from '../../packages/infrastructure/better-auth.contract.config';

interface HandlerMetadata {
  path: string;
  options: { method: string | readonly string[] };
}

function sensitiveKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => sensitiveKeys(item, `${path}[${String(index)}]`));
  }
  if (!value || typeof value !== 'object') return [];

  return Object.entries(value).flatMap(([key, item]) => {
    const itemPath = `${path}.${key}`;
    const own = /token|password|secret|credential|sessionId|accessToken|refreshToken/iu.test(key)
      ? [itemPath]
      : [];
    return [...own, ...sensitiveKeys(item, itemPath)];
  });
}

describe('Better Auth V0.2 contract', () => {
  it('locks the reviewed library, database, route and session contract', () => {
    expect({
      library: BETTER_AUTH_VERSION,
      cli: BETTER_AUTH_CLI_VERSION,
      database: BETTER_AUTH_DATABASE,
      endpoints: BETTER_AUTH_ENDPOINTS,
      options: betterAuthCoreOptions,
    }).toMatchInlineSnapshot(`
      {
        "cli": "1.7.5",
        "database": {
          "casing": "snake",
          "generateId": "uuid",
          "schemaName": "public",
          "transaction": true,
          "type": "postgres",
        },
        "endpoints": [
          {
            "method": "POST",
            "path": "/api/auth/sign-up/email",
          },
          {
            "method": "POST",
            "path": "/api/auth/sign-in/email",
          },
          {
            "method": "POST",
            "path": "/api/auth/sign-out",
          },
          {
            "method": "GET",
            "path": "/api/auth/get-session",
          },
          {
            "method": "GET",
            "path": "/api/auth/verify-email",
          },
          {
            "method": "POST",
            "path": "/api/auth/send-verification-email",
          },
          {
            "method": "POST",
            "path": "/api/auth/request-password-reset",
          },
          {
            "method": "GET",
            "path": "/api/auth/reset-password/:token",
          },
          {
            "method": "POST",
            "path": "/api/auth/reset-password",
          },
        ],
        "library": "1.7.5",
        "options": {
          "account": {
            "modelName": "auth_accounts",
          },
          "advanced": {
            "database": {
              "generateId": "uuid",
            },
          },
          "basePath": "/api/auth",
          "emailAndPassword": {
            "enabled": true,
            "requireEmailVerification": true,
            "resetPasswordTokenExpiresIn": 1800,
            "revokeSessionsOnPasswordReset": true,
          },
          "emailVerification": {
            "expiresIn": 86400,
            "sendOnSignUp": true,
          },
          "plugins": [],
          "session": {
            "cookieCache": {
              "enabled": false,
            },
            "disableSessionRefresh": true,
            "expiresIn": 604800,
            "freshAge": 600,
            "modelName": "auth_sessions",
          },
          "socialProviders": {},
          "user": {
            "modelName": "auth_users",
          },
          "verification": {
            "modelName": "auth_verifications",
            "storeIdentifier": "hashed",
          },
        },
      }
    `);
  });

  it('maps the standard models and UUID generation without a separate identity map', () => {
    expect(BETTER_AUTH_SCHEMA_MODELS).toEqual([
      'auth_accounts',
      'auth_sessions',
      'auth_users',
      'auth_verifications',
    ]);
    expect(betterAuthCoreOptions.advanced.database.generateId).toBe('uuid');
  });

  it('keeps every allowed route backed by the locked Better Auth handlers', () => {
    const handlers = Object.values(auth.api) as unknown as HandlerMetadata[];
    const actual = handlers.flatMap((handler) => {
      const configuredMethod = handler.options.method;
      const methods: readonly string[] =
        typeof configuredMethod === 'string' ? [configuredMethod] : configuredMethod;
      return methods.map((method) => ({ method, path: `/api/auth${handler.path}` }));
    });

    expect(actual).toEqual(expect.arrayContaining([...BETTER_AUTH_ENDPOINTS]));
  });

  it('projects a token-free session DTO and validates its shared UUID', () => {
    const response = toAuthenticatedSession({
      session: {
        expiresAt: new Date('2026-09-27T00:00:00.000Z'),
        token: 'must-not-leak',
      },
      user: {
        id: '10000000-0000-4000-8000-000000000001',
        email: 'user@example.cn',
        name: '测试用户',
        emailVerified: true,
      },
    });

    expect(response).toEqual({
      userId: '10000000-0000-4000-8000-000000000001',
      displayName: '测试用户',
      emailVerified: true,
      expiresAt: '2026-09-27T00:00:00.000Z',
    });
    expect(sensitiveKeys(response)).toEqual([]);
    expect(JSON.stringify(response)).not.toContain('must-not-leak');
    expect(() =>
      toAuthenticatedSession({
        session: { expiresAt: '2026-09-27T00:00:00.000Z', token: 'not-returned' },
        user: {
          id: 'not-a-uuid',
          email: 'user@example.cn',
          name: '测试用户',
          emailVerified: true,
        },
      }),
    ).toThrow('无效用户 ID');
  });
});
