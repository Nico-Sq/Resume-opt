import type { AuthenticatedSession } from '@resume/application';
import type { BetterAuthOptions } from 'better-auth';
import { getSchema } from 'better-auth/db';
import type { Dialect } from 'kysely';

export const BETTER_AUTH_VERSION = '1.7.5';
export const BETTER_AUTH_CLI_VERSION = '1.7.5';

export const BETTER_AUTH_DATABASE = {
  type: 'postgres',
  casing: 'snake',
  schemaName: 'public',
  transaction: true,
  generateId: 'uuid',
} as const;

export const BETTER_AUTH_ENDPOINTS = [
  { method: 'POST', path: '/api/auth/sign-up/email' },
  { method: 'POST', path: '/api/auth/sign-in/email' },
  { method: 'POST', path: '/api/auth/sign-out' },
  { method: 'GET', path: '/api/auth/get-session' },
  { method: 'GET', path: '/api/auth/verify-email' },
  { method: 'POST', path: '/api/auth/send-verification-email' },
  { method: 'POST', path: '/api/auth/request-password-reset' },
  { method: 'GET', path: '/api/auth/reset-password/:token' },
  { method: 'POST', path: '/api/auth/reset-password' },
] as const;

export const betterAuthCoreOptions = {
  basePath: '/api/auth',
  advanced: { database: { generateId: BETTER_AUTH_DATABASE.generateId } },
  user: { modelName: 'auth_users' },
  session: {
    modelName: 'auth_sessions',
    expiresIn: 60 * 60 * 24 * 7,
    disableSessionRefresh: true,
    freshAge: 60 * 10,
    cookieCache: { enabled: false },
  },
  account: { modelName: 'auth_accounts' },
  verification: { modelName: 'auth_verifications', storeIdentifier: 'hashed' },
  emailVerification: { sendOnSignUp: true, expiresIn: 60 * 60 * 24 },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    resetPasswordTokenExpiresIn: 60 * 30,
    revokeSessionsOnPasswordReset: true,
  },
  socialProviders: {},
  plugins: [],
} satisfies BetterAuthOptions;

export const BETTER_AUTH_SCHEMA_MODELS = Object.keys(getSchema(betterAuthCoreOptions)).sort();

export function createBetterAuthOptions(dialect: Dialect): BetterAuthOptions {
  return {
    ...betterAuthCoreOptions,
    database: {
      dialect,
      type: BETTER_AUTH_DATABASE.type,
      casing: BETTER_AUTH_DATABASE.casing,
      schemaName: BETTER_AUTH_DATABASE.schemaName,
      transaction: BETTER_AUTH_DATABASE.transaction,
    },
  };
}

interface BetterAuthSessionResult {
  session: { expiresAt: Date | string; token: string };
  user: { id: string; email: string; name: string; emailVerified: boolean };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function toAuthenticatedSession(result: BetterAuthSessionResult): AuthenticatedSession {
  if (!UUID.test(result.user.id)) throw new Error('Better Auth 返回了无效用户 ID');

  const expiresAt = new Date(result.session.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) throw new Error('Better Auth 返回了无效会话到期时间');

  return {
    userId: result.user.id,
    displayName: result.user.name,
    emailVerified: result.user.emailVerified,
    expiresAt: expiresAt.toISOString(),
  };
}
