import { createHmac } from 'node:crypto';

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
  reportOperationalFailure,
  type OperationalAlertContext,
  type OperationalAlertReceiver,
} from '../observability/operational-alert';
import {
  BETTER_AUTH_ENDPOINTS,
  betterAuthCoreOptions,
  createBetterAuthOptions,
  toAuthenticatedSession,
} from './better-auth-contract';

type SendVerificationEmail = NonNullable<
  NonNullable<BetterAuthOptions['emailVerification']>['sendVerificationEmail']
>;
type SendResetPassword = NonNullable<
  NonNullable<BetterAuthOptions['emailAndPassword']>['sendResetPassword']
>;

export interface AuthMailMessage {
  purpose: 'verify-email' | 'reset-password';
  to: string;
  url: string;
  token: string;
}

export class InMemoryAuthMailbox {
  readonly #messages: AuthMailMessage[] = [];

  readonly sendVerificationEmail: SendVerificationEmail = ({ user, url, token }) => {
    this.#messages.push({ purpose: 'verify-email', to: user.email, url, token });
    return Promise.resolve();
  };

  readonly sendResetPassword: SendResetPassword = ({ user, url, token }) => {
    this.#messages.push({ purpose: 'reset-password', to: user.email, url, token });
    return Promise.resolve();
  };

  readAll(): readonly AuthMailMessage[] {
    return this.#messages.map((message) => ({ ...message }));
  }
}

export interface BetterAuthServerOptions {
  authPool: Pool;
  baseURL: string;
  secret: string;
  sendVerificationEmail: SendVerificationEmail;
  sendResetPassword: SendResetPassword;
  mailTimeoutMs?: number;
  schemaName?: string;
  operationalAlerts?: {
    context: OperationalAlertContext;
    receiver: OperationalAlertReceiver;
  };
}

const EMAIL_VERIFICATION_PREFIX = 'resume-opt:verify-email:';
const DEFAULT_MAIL_TIMEOUT_MS = 5_000;

async function deliverWithTimeout(
  delivery: Promise<void>,
  timeoutMs: number,
  onFailure: () => Promise<void>,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      delivery,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('邮件发送超时'));
        }, timeoutMs);
      }),
    ]);
  } catch {
    await onFailure();
    throw new Error('邮件发送失败');
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createBetterAuthServer(options: BetterAuthServerOptions) {
  const mailTimeoutMs = options.mailTimeoutMs ?? DEFAULT_MAIL_TIMEOUT_MS;
  const operationalAlerts = options.operationalAlerts;
  const reportMailFailure = operationalAlerts
    ? () =>
        reportOperationalFailure(
          'auth-mail-delivery-failed',
          operationalAlerts.context,
          operationalAlerts.receiver,
        )
    : () => {
        console.error('认证邮件发送失败');
        return Promise.resolve();
      };
  const auth = betterAuth<BetterAuthOptions>({
    ...createBetterAuthOptions(new PostgresDialect({ pool: options.authPool }), options.schemaName),
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: [new URL(options.baseURL).origin],
    emailVerification: {
      ...betterAuthCoreOptions.emailVerification,
      sendVerificationEmail: async (data, request) => {
        const context = await auth.$context;
        await context.internalAdapter.createVerificationValue({
          identifier: `${EMAIL_VERIFICATION_PREFIX}${data.token}`,
          value: data.user.id,
          expiresAt: new Date(
            Date.now() + betterAuthCoreOptions.emailVerification.expiresIn * 1_000,
          ),
        });
        try {
          await deliverWithTimeout(
            options.sendVerificationEmail(data, request),
            mailTimeoutMs,
            reportMailFailure,
          );
        } catch {
          return;
        }
      },
    },
    emailAndPassword: {
      ...betterAuthCoreOptions.emailAndPassword,
      sendResetPassword: (data, request) =>
        deliverWithTimeout(
          options.sendResetPassword(data, request),
          mailTimeoutMs,
          reportMailFailure,
        ),
    },
  });
  return auth;
}

export type BetterAuthServer = ReturnType<typeof createBetterAuthServer>;

export interface AuthoritativeAuthSession {
  userId: string;
  emailVerified: boolean;
  createdAt: Date;
}

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

function rejectUnsafeAuthWrite(request: Request, baseURL: string): Response | null {
  if (request.method !== 'POST') return null;
  const origin = request.headers.get('origin');
  if (origin !== new URL(baseURL).origin) {
    return Response.json(
      { code: 'AUTH_ORIGIN_FORBIDDEN' },
      { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin') {
    return Response.json(
      { code: 'AUTH_CROSS_SITE_FORBIDDEN' },
      { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return Response.json(
      { code: 'AUTH_UNSUPPORTED_MEDIA_TYPE' },
      { status: 415, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  return null;
}

export async function handleBetterAuthRequest(
  auth: BetterAuthServer,
  request: Request,
  sessionProvider: SessionProvider,
) {
  if (!isAllowedEndpoint(request)) {
    return Response.json({ code: 'AUTH_ENDPOINT_NOT_FOUND' }, { status: 404 });
  }

  const url = new URL(request.url);
  const { pathname } = url;
  const authContext = await auth.$context;
  const unsafeWrite = rejectUnsafeAuthWrite(request, authContext.baseURL);
  if (unsafeWrite) return unsafeWrite;
  if (pathname === '/api/auth/get-session') {
    return Response.json(await sessionProvider.getSession(), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }

  const callbackURL = url.searchParams.get('callbackURL');
  const hasCallback =
    pathname === '/api/auth/verify-email' ||
    (request.method === 'GET' && pathname.startsWith('/api/auth/reset-password/'));
  if (callbackURL && hasCallback) {
    let callbackIsTrusted = false;
    try {
      callbackIsTrusted =
        new URL(callbackURL, authContext.baseURL).origin === new URL(authContext.baseURL).origin;
    } catch {
      callbackIsTrusted = false;
    }
    if (!callbackIsTrusted) {
      return Response.json(
        { code: 'AUTH_ORIGIN_FORBIDDEN' },
        { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }
  }

  let authRequest = request;
  if (pathname === '/api/auth/verify-email') {
    const token = url.searchParams.get('token');
    if (token) {
      if (token.length > 4_096) {
        url.searchParams.set('token', 'invalid');
        authRequest = new Request(url, request);
      } else {
        const verification = await authContext.internalAdapter.consumeVerificationValue(
          `${EMAIL_VERIFICATION_PREFIX}${token}`,
        );
        if (!verification) {
          url.searchParams.set('token', 'invalid');
          authRequest = new Request(url, request);
        }
      }
    }
  }

  const response = await auth.handler(authRequest);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  if (response.status === 429) {
    const retryAfter = headers.get('x-retry-after');
    if (retryAfter) headers.set('Retry-After', retryAfter);
  }
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
    private readonly csrfSecret?: string,
  ) {
    if (!safeIdentifier.test(schema)) throw new Error('不安全的数据库 schema');
    this.#schema = schema;
  }

  async getCsrfToken(): Promise<string | null> {
    if (!this.csrfSecret) throw new Error('CSRF 密钥未配置');
    const result = await this.auth.api.getSession({
      headers: this.requestHeaders,
      query: { disableCookieCache: true, disableRefresh: true },
    });
    if (!result) return null;
    return createHmac('sha256', this.csrfSecret)
      .update(`resume-opt:csrf\0${result.session.token}`)
      .digest('base64url');
  }

  async getAuthoritativeSession(): Promise<AuthoritativeAuthSession | null> {
    const result = await this.auth.api.getSession({
      headers: this.requestHeaders,
      query: { disableCookieCache: true, disableRefresh: true },
    });
    if (!result) return null;
    return {
      userId: result.user.id,
      emailVerified: result.user.emailVerified,
      createdAt: new Date(result.session.createdAt),
    };
  }

  async verifyCurrentPassword(password: string): Promise<boolean> {
    try {
      const result = await this.auth.api.verifyPassword({
        headers: this.requestHeaders,
        body: { password },
      });
      return result.status;
    } catch (error) {
      const statusCode =
        typeof error === 'object' && error !== null && 'statusCode' in error
          ? Number(error.statusCode)
          : 0;
      if (statusCode >= 400 && statusCode < 500) return false;
      throw error;
    }
  }

  async revokeAllSessions(userId: string): Promise<void> {
    const context = await this.auth.$context;
    await context.internalAdapter.deleteUserSessions(userId);
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
