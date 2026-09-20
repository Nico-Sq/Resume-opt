import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseToolConfig } from '@resume/config/server';
import {
  BetterAuthSessionProvider,
  createBetterAuthServer,
  handleBetterAuthRequest,
  InMemoryAuthMailbox,
  type BetterAuthServer,
} from '@resume/infrastructure/better-auth-server';
import { runMigrations } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';

const migration = parseDatabaseToolConfig({ ...process.env, APP_ENV: 'test' }, 'migration');
const authConnectionString = process.env.PG_AUTH_URL;
if (!authConnectionString) throw new Error('真实 Auth Session 测试缺少 PG_AUTH_URL');
const appConnectionString = process.env.PG_DEV_URL;
if (!appConnectionString) throw new Error('真实 Auth Session 测试缺少 PG_DEV_URL');

const schema = `auth_session_${randomUUID().replaceAll('-', '')}`;
const baseURL = 'http://localhost:3000';
const secureBaseURL = 'https://resume.example';
const authSecret = 'integration-test-secret-with-at-least-32-characters';
const migrationsDirectory = fileURLToPath(new URL('../../database/migrations', import.meta.url));
const migrationPool = createPostgresPool({
  connectionString: migration.connectionString,
  max: 1,
  applicationName: 'resume-opt-auth-session-migration-test',
});
const authPool = createPostgresPool({
  connectionString: authConnectionString,
  max: 3,
  applicationName: 'resume-opt-auth-session-test',
});
const applicationPool = createPostgresPool({
  connectionString: appConnectionString,
  max: 3,
  applicationName: 'resume-opt-session-identity-test',
});
const mailbox = new InMemoryAuthMailbox();
let auth: BetterAuthServer;
let authPeer: BetterAuthServer;
let secureAuth: BetterAuthServer;
let verificationDeliveryError: Error | undefined;
let resetDeliveryError: Error | undefined;
let blockVerificationDelivery = false;
let clientIpSequence = 1;

function qualified(table: string): string {
  if (!/^[a-z_]+$/u.test(table)) throw new Error('测试表名不安全');
  return `"${schema}"."${table}"`;
}

function request(
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
  cookie?: string,
  clientIp = `192.0.2.${String(clientIpSequence++)}`,
) {
  const headers = new Headers({ Origin: baseURL, 'X-Resume-Client-Ip': clientIp });
  if (body) headers.set('Content-Type', 'application/json');
  if (cookie) headers.set('Cookie', cookie);
  return new Request(`${baseURL}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function call(
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
  cookie?: string,
  clientIp?: string,
) {
  const authRequest = request(path, method, body, cookie, clientIp);
  return handleBetterAuthRequest(
    auth,
    authRequest,
    new BetterAuthSessionProvider(auth, applicationPool, authRequest.headers, schema),
  );
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.getSetCookie()[0] ?? response.headers.get('set-cookie');
  if (!setCookie) throw new Error('登录响应缺少 Session Cookie');
  return setCookie.split(';', 1)[0] ?? '';
}

async function register(email: string, name: string) {
  const suppliedOwner = randomUUID();
  const response = await call('/api/auth/sign-up/email', 'POST', {
    email,
    name,
    password: 'Strong-password-123',
    userId: suppliedOwner,
  });
  const body = (await response.json()) as { user: { id: string; email: string } };
  expect(response.status).toBe(200);
  expect(body.user.id).not.toBe(suppliedOwner);
  expect(JSON.stringify(body)).not.toMatch(/token|password/iu);
  return body.user;
}

function latestMail(purpose: 'verify-email' | 'reset-password', email: string) {
  const message = [...mailbox.readAll()]
    .reverse()
    .find((candidate) => candidate.purpose === purpose && candidate.to === email);
  if (!message) throw new Error(`未找到 ${email} 的 ${purpose} 测试邮件`);
  return message;
}

async function verifyEmail(email: string) {
  const response = await call(
    `/api/auth/verify-email?token=${encodeURIComponent(latestMail('verify-email', email).token)}`,
    'GET',
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toBeNull();
  return response;
}

async function requestPasswordReset(email: string) {
  return call('/api/auth/request-password-reset', 'POST', {
    email,
    redirectTo: '/reset-password',
  });
}

async function verifyAndLogin(email: string) {
  await migrationPool.query(
    `update ${qualified('auth_users')} set email_verified = true where email = $1`,
    [email],
  );
  const response = await call('/api/auth/sign-in/email', 'POST', {
    email,
    password: 'Strong-password-123',
  });
  const body = await response.clone().text();
  expect(response.status).toBe(200);
  expect(body).not.toMatch(/token|password/iu);
  const cookieHeader =
    response.headers.getSetCookie()[0] ?? response.headers.get('set-cookie') ?? '';
  expect(cookieHeader).toMatch(/; HttpOnly/iu);
  expect(cookieHeader).toMatch(/; SameSite=Lax/iu);
  expect(cookieHeader).toMatch(/; Path=\//iu);
  expect(cookieHeader).not.toMatch(/; Domain=/iu);
  return sessionCookie(response);
}

beforeAll(async () => {
  await migrationPool.query(`create schema "${schema}" authorization resume_opt_migrator`);
  await migrationPool.query(`grant usage on schema "${schema}" to resume_opt_app, resume_opt_auth`);
  await runMigrations(migrationPool, migrationsDirectory, schema);
  auth = createBetterAuthServer({
    authPool,
    baseURL,
    secret: authSecret,
    schemaName: schema,
    sendVerificationEmail: (data, request) => {
      if (verificationDeliveryError) return Promise.reject(verificationDeliveryError);
      if (blockVerificationDelivery) return new Promise<void>(() => undefined);
      return mailbox.sendVerificationEmail(data, request);
    },
    sendResetPassword: (data, request) => {
      if (resetDeliveryError) return Promise.reject(resetDeliveryError);
      return mailbox.sendResetPassword(data, request);
    },
    mailTimeoutMs: 25,
  });
  authPeer = createBetterAuthServer({
    authPool,
    baseURL,
    secret: authSecret,
    schemaName: schema,
    sendVerificationEmail: mailbox.sendVerificationEmail,
    sendResetPassword: mailbox.sendResetPassword,
  });
  secureAuth = createBetterAuthServer({
    authPool,
    baseURL: secureBaseURL,
    secret: authSecret,
    schemaName: schema,
    sendVerificationEmail: mailbox.sendVerificationEmail,
    sendResetPassword: mailbox.sendResetPassword,
  });
});

afterAll(async () => {
  if (/^auth_session_[a-f0-9]{32}$/u.test(schema)) {
    await migrationPool.query(`drop schema "${schema}" cascade`);
  }
  await Promise.all([migrationPool.end(), authPool.end(), applicationPool.end()]);
});

describe('Better Auth real PostgreSQL handler and sessions', () => {
  it('registers with library hashing, fake mail and generic duplicate handling', async () => {
    const email = `Case-${randomUUID()}@Example.cn`;
    const normalizedEmail = email.toLowerCase();
    const user = await register(email, '注册用户');

    expect(user.email).toBe(normalizedEmail);
    expect(mailbox.readAll()).toContainEqual({
      purpose: 'verify-email',
      to: normalizedEmail,
      url: expect.any(String) as string,
      token: expect.any(String) as string,
    });

    const password = await migrationPool.query<{ password: string }>(
      `select password from ${qualified('auth_accounts')} where user_id = $1`,
      [user.id],
    );
    expect(password.rows[0]?.password).toBeTruthy();
    expect(password.rows[0]?.password).not.toContain('Strong-password-123');

    const duplicate = await call('/api/auth/sign-up/email', 'POST', {
      email: normalizedEmail,
      name: '重复用户',
      password: 'Strong-password-123',
    });
    expect(duplicate.status).toBe(200);
    const users = await migrationPool.query<{ count: number }>(
      `select count(*)::int as count from ${qualified('auth_users')} where email = $1`,
      [normalizedEmail],
    );
    expect(users.rows[0]?.count).toBe(1);
  });

  it('rejects invalid fields and does not create a session before email verification', async () => {
    const invalid = await call('/api/auth/sign-up/email', 'POST', {
      email: 'not-an-email',
      name: '',
      password: 'short',
    });
    expect(invalid.status).toBe(400);

    const email = `${randomUUID()}@example.cn`;
    await register(email, '未验证用户');
    const login = await call('/api/auth/sign-in/email', 'POST', {
      email,
      password: 'Strong-password-123',
    });
    expect(login.status).toBe(403);
    expect(login.headers.get('set-cookie')).toBeNull();
  });

  it('consumes email verification tokens once across expiry and concurrent requests', async () => {
    const email = `${randomUUID()}@example.cn`;
    const user = await register(email, '验证用户');
    const token = latestMail('verify-email', email).token;

    const existingResend = await call('/api/auth/send-verification-email', 'POST', { email });
    const unknownResend = await call('/api/auth/send-verification-email', 'POST', {
      email: `${randomUUID()}@example.cn`,
    });
    expect(existingResend.status).toBe(200);
    expect(unknownResend.status).toBe(200);
    expect(await unknownResend.json()).toEqual(await existingResend.json());

    const rawToken = await migrationPool.query<{ count: number }>(
      `select count(*)::int as count from ${qualified('auth_verifications')} where identifier like $1 or value = $1`,
      [`%${token}%`],
    );
    expect(rawToken.rows[0]?.count).toBe(0);

    const rejectedCallback = await call(
      `/api/auth/verify-email?token=${encodeURIComponent(latestMail('verify-email', email).token)}&callbackURL=${encodeURIComponent('https://example.invalid/steal')}`,
      'GET',
    );
    expect(rejectedCallback.status).toBe(403);
    await verifyEmail(email);
    const verified = await migrationPool.query<{ email_verified: boolean }>(
      `select email_verified from ${qualified('auth_users')} where id = $1`,
      [user.id],
    );
    expect(verified.rows[0]?.email_verified).toBe(true);
    expect(
      (
        await call(
          `/api/auth/verify-email?token=${encodeURIComponent(latestMail('verify-email', email).token)}`,
          'GET',
        )
      ).status,
    ).toBe(401);
    expect((await call('/api/auth/verify-email?token=tampered', 'GET')).status).toBe(401);

    const expiredEmail = `${randomUUID()}@example.cn`;
    const expiredUser = await register(expiredEmail, '过期验证用户');
    await migrationPool.query(
      `update ${qualified('auth_verifications')} set expires_at = now() - interval '1 second' where value = $1`,
      [expiredUser.id],
    );
    expect(
      (
        await call(
          `/api/auth/verify-email?token=${encodeURIComponent(latestMail('verify-email', expiredEmail).token)}`,
          'GET',
        )
      ).status,
    ).toBe(401);

    const concurrentEmail = `${randomUUID()}@example.cn`;
    await register(concurrentEmail, '并发验证用户');
    const concurrentPath = `/api/auth/verify-email?token=${encodeURIComponent(latestMail('verify-email', concurrentEmail).token)}`;
    const statuses = await Promise.all([
      call(concurrentPath, 'GET').then((response) => response.status),
      call(concurrentPath, 'GET').then((response) => response.status),
    ]);
    expect(statuses.sort()).toEqual([200, 401]);
  });

  it('resets passwords once, revokes old sessions and keeps account discovery generic', async () => {
    const email = `${randomUUID()}@example.cn`;
    const user = await register(email, '重置用户');
    await verifyEmail(email);
    const [cookieA, cookieB] = await Promise.all([verifyAndLogin(email), verifyAndLogin(email)]);

    const accepted = await requestPasswordReset(email);
    const unknown = await requestPasswordReset(`${randomUUID()}@example.cn`);
    expect(accepted.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual(await accepted.clone().json());

    const token = latestMail('reset-password', email).token;
    const rawToken = await migrationPool.query<{ count: number }>(
      `select count(*)::int as count from ${qualified('auth_verifications')} where identifier like $1 or value = $1`,
      [`%${token}%`],
    );
    expect(rawToken.rows[0]?.count).toBe(0);

    const callback = await call(
      `/api/auth/reset-password/${encodeURIComponent(token)}?callbackURL=/reset-password`,
      'GET',
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toContain(
      `/reset-password?token=${encodeURIComponent(token)}`,
    );
    expect(
      (
        await call(
          `/api/auth/reset-password/${encodeURIComponent(token)}?callbackURL=${encodeURIComponent('https://example.invalid/steal')}`,
          'GET',
        )
      ).status,
    ).toBe(403);

    const reset = await call('/api/auth/reset-password', 'POST', {
      token,
      newPassword: 'New-strong-password-456',
    });
    expect(reset.status).toBe(200);
    expect(
      await new BetterAuthSessionProvider(
        auth,
        applicationPool,
        new Headers({ Cookie: cookieA }),
        schema,
      ).getSession(),
    ).toBeNull();
    expect(
      await new BetterAuthSessionProvider(
        auth,
        applicationPool,
        new Headers({ Cookie: cookieB }),
        schema,
      ).getSession(),
    ).toBeNull();
    expect(
      (
        await call('/api/auth/reset-password', 'POST', {
          token,
          newPassword: 'Another-strong-password-789',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('/api/auth/reset-password', 'POST', {
          token: 'tampered',
          newPassword: 'Another-strong-password-789',
        })
      ).status,
    ).toBe(400);

    const oldPassword = await call('/api/auth/sign-in/email', 'POST', {
      email,
      password: 'Strong-password-123',
    });
    const newPassword = await call('/api/auth/sign-in/email', 'POST', {
      email,
      password: 'New-strong-password-456',
    });
    expect(oldPassword.status).toBe(401);
    expect(newPassword.status).toBe(200);

    await requestPasswordReset(email);
    const expiredToken = latestMail('reset-password', email).token;
    await migrationPool.query(
      `update ${qualified('auth_verifications')} set expires_at = now() - interval '1 second' where value = $1`,
      [user.id],
    );
    expect(
      (
        await call('/api/auth/reset-password', 'POST', {
          token: expiredToken,
          newPassword: 'Expired-strong-password-789',
        })
      ).status,
    ).toBe(400);

    await requestPasswordReset(email);
    const concurrentToken = latestMail('reset-password', email).token;
    const statuses = await Promise.all([
      call('/api/auth/reset-password', 'POST', {
        token: concurrentToken,
        newPassword: 'Concurrent-password-A-789',
      }).then((response) => response.status),
      call('/api/auth/reset-password', 'POST', {
        token: concurrentToken,
        newPassword: 'Concurrent-password-B-789',
      }).then((response) => response.status),
    ]);
    expect(statuses.sort()).toEqual([200, 400]);
  });

  it('keeps identities after fake-mail failure and permits a safe retry', async () => {
    const email = `${randomUUID()}@example.cn`;
    verificationDeliveryError = new Error('fake verification delivery failed');
    const registration = await call('/api/auth/sign-up/email', 'POST', {
      email,
      name: '邮件失败用户',
      password: 'Strong-password-123',
    });
    verificationDeliveryError = undefined;
    expect(registration.status).toBe(200);

    const user = await migrationPool.query<{ id: string }>(
      `select id from ${qualified('auth_users')} where email = $1`,
      [email],
    );
    expect(user.rowCount).toBe(1);
    expect((await call('/api/auth/send-verification-email', 'POST', { email })).status).toBe(200);
    await verifyEmail(email);

    const timeoutEmail = `${randomUUID()}@example.cn`;
    await register(timeoutEmail, '超时邮件用户');
    blockVerificationDelivery = true;
    const startedAt = Date.now();
    const timedOut = await call('/api/auth/send-verification-email', 'POST', {
      email: timeoutEmail,
    });
    blockVerificationDelivery = false;
    expect(timedOut.status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(
      (await call('/api/auth/send-verification-email', 'POST', { email: timeoutEmail })).status,
    ).toBe(200);

    resetDeliveryError = new Error('fake reset delivery failed');
    const failedReset = await requestPasswordReset(email);
    resetDeliveryError = undefined;
    expect(failedReset.status).toBe(200);
    expect((await requestPasswordReset(email)).status).toBe(200);
    expect(latestMail('reset-password', email).token).toBeTruthy();
  });

  it('returns a token-free session, revokes logout immediately and blocks extra endpoints', async () => {
    const email = `${randomUUID()}@example.cn`;
    const user = await register(email, '会话用户');
    const cookie = await verifyAndLogin(email);

    const session = await call('/api/auth/get-session', 'GET', undefined, cookie);
    const sessionBody = (await session.json()) as Record<string, unknown>;
    expect(session.status).toBe(200);
    expect(sessionBody).toMatchObject({
      userId: user.id,
      displayName: '会话用户',
      emailVerified: true,
    });
    expect(JSON.stringify(sessionBody)).not.toMatch(/token|password|sessionId/iu);
    expect(session.headers.get('cache-control')).toBe('private, no-store');

    const blocked = await call('/api/auth/list-sessions', 'GET', undefined, cookie);
    expect(blocked.status).toBe(404);

    const csrfProvider = new BetterAuthSessionProvider(
      auth,
      applicationPool,
      new Headers({ Cookie: cookie }),
      schema,
      authSecret,
    );
    const csrfToken = await csrfProvider.getCsrfToken();
    if (!csrfToken) throw new Error('登录会话缺少 CSRF Token');
    expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(cookie).not.toContain(csrfToken);

    const secureRequest = new Request(`${secureBaseURL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: secureBaseURL,
        'X-Resume-Client-Ip': '198.51.100.90',
      },
      body: JSON.stringify({ email, password: 'Strong-password-123' }),
    });
    const secureLogin = await handleBetterAuthRequest(
      secureAuth,
      secureRequest,
      new BetterAuthSessionProvider(secureAuth, applicationPool, secureRequest.headers, schema),
    );
    expect(secureLogin.status).toBe(200);
    expect(secureLogin.headers.get('set-cookie')).toMatch(/; Secure/iu);

    const logout = await call('/api/auth/sign-out', 'POST', {}, cookie);
    expect(logout.status).toBe(200);
    expect(await csrfProvider.getCsrfToken()).toBeNull();
    expect(
      await new BetterAuthSessionProvider(
        auth,
        applicationPool,
        new Headers({ Cookie: cookie }),
        schema,
      ).getSession(),
    ).toBeNull();
  });

  it('keeps concurrent request identities separate and rejects expired or disabled users', async () => {
    const emailA = `${randomUUID()}@example.cn`;
    const emailB = `${randomUUID()}@example.cn`;
    const [userA, userB] = await Promise.all([
      register(emailA, '并发用户A'),
      register(emailB, '并发用户B'),
    ]);
    const [cookieA, cookieB] = await Promise.all([verifyAndLogin(emailA), verifyAndLogin(emailB)]);
    const providerA = new BetterAuthSessionProvider(
      auth,
      applicationPool,
      new Headers({ Cookie: cookieA }),
      schema,
    );
    const providerB = new BetterAuthSessionProvider(
      auth,
      applicationPool,
      new Headers({ Cookie: cookieB }),
      schema,
    );

    const [identityA, identityB] = await Promise.all([
      providerA.requireIdentity(),
      providerB.requireIdentity(),
    ]);
    expect(identityA.userId).toBe(userA.id);
    expect(identityB.userId).toBe(userB.id);

    await migrationPool.query(
      `update ${qualified('users')} set status = 'disabled' where id = $1`,
      [userA.id],
    );
    expect(await providerA.getSession()).toBeNull();
    await expect(providerA.requireIdentity()).rejects.toThrow('需要登录');
    expect(
      await (await call('/api/auth/get-session', 'GET', undefined, cookieA)).json(),
    ).toBeNull();

    await migrationPool.query(
      `update ${qualified('auth_sessions')} set expires_at = now() - interval '1 second' where user_id = $1`,
      [userB.id],
    );
    expect(await providerB.getSession()).toBeNull();
  });

  it('rejects unsafe auth writes before account lookup', async () => {
    const unusedSessionProvider = { getSession: () => Promise.resolve(null) };
    const missingOrigin = new Request(`${baseURL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const crossSite = new Request(`${baseURL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: '{}',
    });
    const wrongMedia = new Request(`${baseURL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: baseURL },
      body: '{}',
    });

    expect((await handleBetterAuthRequest(auth, missingOrigin, unusedSessionProvider)).status).toBe(
      403,
    );
    expect((await handleBetterAuthRequest(auth, crossSite, unusedSessionProvider)).status).toBe(
      403,
    );
    expect((await handleBetterAuthRequest(auth, wrongMedia, unusedSessionProvider)).status).toBe(
      415,
    );
  });

  it('atomically limits two auth instances and ignores forged forwarded IP headers', async () => {
    const clientIp = '198.51.100.77';
    const responses = await Promise.all(
      Array.from({ length: 8 }, async (_value, index) => {
        const authRequest = request(
          '/api/auth/sign-up/email',
          'POST',
          {
            email: `${randomUUID()}@example.cn`,
            name: `限流用户${String(index)}`,
            password: 'Strong-password-123',
          },
          undefined,
          clientIp,
        );
        authRequest.headers.set('X-Forwarded-For', `203.0.113.${String(index + 1)}`);
        const server = index % 2 === 0 ? auth : authPeer;
        return handleBetterAuthRequest(
          server,
          authRequest,
          new BetterAuthSessionProvider(server, applicationPool, authRequest.headers, schema),
        );
      }),
    );

    const accepted = responses.filter((response) => response.status === 200);
    const limited = responses.filter((response) => response.status === 429);
    expect(accepted).toHaveLength(5);
    expect(limited).toHaveLength(3);
    expect(limited.every((response) => Number(response.headers.get('retry-after')) > 0)).toBe(true);
    const row = await migrationPool.query<{ count: number }>(
      `select count from ${qualified('auth_rate_limits')} where key = $1`,
      [`${clientIp}|/sign-up/email`],
    );
    expect(row.rows).toEqual([{ count: 5 }]);
  });
});
