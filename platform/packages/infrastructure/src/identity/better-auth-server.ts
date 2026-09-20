import {
  AuthenticationRequiredError,
  type AuthenticatedSession,
  type IdentityProvider,
  type SessionProvider,
} from '@resume/application';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { PostgresDialect } from 'kysely';
import type { Pool } from 'pg';

import {
  BETTER_AUTH_ENDPOINTS,
  betterAuthCoreOptions,
  createBetterAuthOptions,
  toAuthenticatedSession,
} from './better-auth-contract';

type SendVerificationEmail = NonNullable<
  NonNullable<BetterAuthOptions['emailVerification']>['sendVerificationEmail']
>;

export interface BetterAuthServerOptions {
  authPool: Pool;
  baseURL: string;
  secret: string;
  sendVerificationEmail: SendVerificationEmail;
  schemaName?: string;
}

export function createBetterAuthServer(options: BetterAuthServerOptions) {
  return betterAuth({
    ...createBetterAuthOptions(new PostgresDialect({ pool: options.authPool }), options.schemaName),
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: [new URL(options.baseURL).origin],
    emailVerification: {
      ...betterAuthCoreOptions.emailVerification,
      sendVerificationEmail: options.sendVerificationEmail,
    },
  });
}

export type BetterAuthServer = ReturnType<typeof createBetterAuthServer>;

function isAllowedEndpoint(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return BETTER_AUTH_ENDPOINTS.some(({ method, path }) => {
    if (method !== request.method) return false;
    if (!path.includes(':token')) return path === pathname;
    const prefix = path.slice(0, path.indexOf(':token'));
    return pathname.startsWith(prefix) && pathname.length > prefix.length;
  });
}

function tokenFreeBody(pathname: string, body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  if (pathname === '/api/auth/sign-in/email' || pathname === '/api/auth/sign-up/email') {
    const safe = { ...(body as Record<string, unknown>) };
    delete safe.token;
    return safe;
  }
  return body;
}

export async function handleBetterAuthRequest(
  auth: BetterAuthServer,
  request: Request,
  sessionProvider: SessionProvider,
) {
  if (!isAllowedEndpoint(request)) {
    return Response.json({ code: 'AUTH_ENDPOINT_NOT_FOUND' }, { status: 404 });
  }

  const pathname = new URL(request.url).pathname;
  if (pathname === '/api/auth/get-session') {
    return Response.json(await sessionProvider.getSession(), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }

  const response = await auth.handler(request);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    return new Response(response.body, { status: response.status, headers });
  }

  const body = tokenFreeBody(pathname, await response.json());
  headers.delete('content-length');
  return Response.json(body, { status: response.status, headers });
}

const safeIdentifier = /^[a-z_][a-z0-9_]*$/u;

export class BetterAuthSessionProvider implements SessionProvider, IdentityProvider {
  readonly #schema: string;

  constructor(
    private readonly auth: BetterAuthServer,
    private readonly applicationPool: Pool,
    private readonly requestHeaders: Headers,
    schema = 'public',
  ) {
    if (!safeIdentifier.test(schema)) throw new Error('不安全的数据库 schema');
    this.#schema = schema;
  }

  async getSession(): Promise<AuthenticatedSession | null> {
    const result = await this.auth.api.getSession({
      headers: this.requestHeaders,
      query: { disableCookieCache: true, disableRefresh: true },
    });
    if (!result) return null;

    const session = toAuthenticatedSession(result);
    const client = await this.applicationPool.connect();
    try {
      await client.query('begin');
      await client.query(`set local search_path to "${this.#schema}", public`);
      await client.query("select set_config('app.user_id', $1, true)", [session.userId]);
      const user = await client.query<{ active: boolean }>(
        "select status = 'active' and deleted_at is null as active from users where id = $1",
        [session.userId],
      );
      await client.query('commit');
      return user.rows[0]?.active ? session : null;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async requireIdentity() {
    const session = await this.getSession();
    if (!session?.emailVerified) throw new AuthenticationRequiredError();
    return { userId: session.userId };
  }
}
