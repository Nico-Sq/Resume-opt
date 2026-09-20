import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseToolConfig } from '@resume/config/server';
import {
  BetterAuthSessionProvider,
  createBetterAuthServer,
  handleBetterAuthRequest,
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
const sentVerificationTokens: Array<{ email: string; token: string }> = [];
let auth: BetterAuthServer;

function qualified(table: string): string {
  if (!/^[a-z_]+$/u.test(table)) throw new Error('测试表名不安全');
  return `"${schema}"."${table}"`;
}

function request(
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
  cookie?: string,
) {
  const headers = new Headers({ Origin: baseURL });
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
) {
  const authRequest = request(path, method, body, cookie);
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
  return sessionCookie(response);
}

beforeAll(async () => {
  await migrationPool.query(`create schema "${schema}" authorization resume_opt_migrator`);
  await migrationPool.query(`grant usage on schema "${schema}" to resume_opt_app, resume_opt_auth`);
  await runMigrations(migrationPool, migrationsDirectory, schema);
  auth = createBetterAuthServer({
    authPool,
    baseURL,
    secret: 'integration-test-secret-with-at-least-32-characters',
    schemaName: schema,
    sendVerificationEmail: ({ user, token }) => {
      sentVerificationTokens.push({ email: user.email, token });
      return Promise.resolve();
    },
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
    expect(sentVerificationTokens).toContainEqual({
      email: normalizedEmail,
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

    const logout = await call('/api/auth/sign-out', 'POST', undefined, cookie);
    expect(logout.status).toBe(200);
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
});
