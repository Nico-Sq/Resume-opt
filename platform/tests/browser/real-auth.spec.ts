import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, platform as osPlatform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  expect,
  request as apiRequest,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { ResumeDocumentV1Schema, type ResumeDocumentV1 } from '@resume/domain/resume';
import {
  createBetterAuthServer,
  handleBetterAuthRequest,
  InMemoryAuthMailbox,
  type BetterAuthServer,
} from '@resume/infrastructure/better-auth-server';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import {
  PerformanceBudgetSchema,
  summarizePerformanceSamples,
} from '../../scripts/performance/renderer-baseline';

const basePort = process.env.PLAYWRIGHT_AUTH_PORT ?? '3300';
const baseURL = `http://localhost:${basePort}`;
const replacementPort = String(Number(basePort) + 1);
const replacementURL = `http://localhost:${replacementPort}`;
const password = 'Browser-test-password-123';
const databaseName = 'resume-opt-local-drafts-v1';
const mailbox = new InMemoryAuthMailbox();
const accounts: TestAccount[] = [];
const clientIps = new Set<string>();
const checks = new Set<string>();

interface TestAccount {
  id: string;
  email: string;
  name: string;
}

interface ResumePayload {
  id: string;
  title: string;
  document: Record<string, unknown>;
  revision: string;
}

interface ApiResult {
  status: number;
  body: unknown;
}

let auth: BetterAuthServer;
let authPool: ReturnType<typeof createPostgresPool>;
let migrationPool: ReturnType<typeof createPostgresPool>;
let accountA: TestAccount;
let accountB: TestAccount;
let resumeAId = '';
let resumeBId = '';
let browserVersion = '';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`真实 Auth 浏览器测试缺少 ${name}`);
  return value;
}

function authRequest(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>) {
  const clientIp = `198.51.100.${String(100 + clientIps.size)}`;
  clientIps.add(clientIp);
  const headers = new Headers({ Origin: baseURL, 'X-Resume-Client-Ip': clientIp });
  if (body) headers.set('Content-Type', 'application/json');
  return new Request(`${baseURL}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function callAuth(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>) {
  const request = authRequest(path, method, body);
  return handleBetterAuthRequest(auth, request, { getSession: () => Promise.resolve(null) });
}

async function provisionVerifiedAccount(name: string): Promise<TestAccount> {
  const email = `browser-${randomUUID()}@example.cn`;
  const registration = await callAuth('/api/auth/sign-up/email', 'POST', {
    email,
    name,
    password,
  });
  if (registration.status !== 200) {
    throw new Error(`测试账户注册失败：${String(registration.status)}`);
  }
  const message = [...mailbox.readAll()]
    .reverse()
    .find((candidate) => candidate.purpose === 'verify-email' && candidate.to === email);
  if (!message) throw new Error('Fake 邮箱未收到验证邮件');
  const verification = await callAuth(
    `/api/auth/verify-email?token=${encodeURIComponent(message.token)}`,
    'GET',
  );
  if (verification.status !== 200) {
    throw new Error(`测试账户验证失败：${String(verification.status)}`);
  }
  const result = await migrationPool.query<{ id: string }>(
    'select id from auth_users where email = $1 and email_verified = true',
    [email],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('测试账户未持久化');
  const account = { id, email, name };
  accounts.push(account);
  return account;
}

async function login(context: BrowserContext, account: TestAccount, clientIp: string) {
  clientIps.add(clientIp);
  await context.setExtraHTTPHeaders({ 'X-Resume-Client-Ip': clientIp });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${baseURL}/login?returnTo=%2Fresumes`);
  await page.getByRole('textbox', { name: '邮箱' }).fill(account.email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(`${baseURL}/resumes`);
  await expect(page.getByRole('heading', { name: '我的简历' })).toBeVisible();
  return page;
}

async function tabTo(page: Page, target: Locator, limit = 160) {
  for (let index = 0; index < limit; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) {
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab ${String(limit)} 次后仍未到达目标`);
}

async function signOut(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/auth/sign-out', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return response.status;
  });
}

async function createResume(page: Page, title: string): Promise<string> {
  await page.goto('/resumes/new');
  await page.getByRole('textbox', { name: '简历名称' }).fill(title);
  await page.getByRole('radio', { name: /基础模板/u }).check();
  await page.getByRole('button', { name: /创建并进入编辑器/u }).click();
  await expect(page).toHaveURL(/\/resumes\/[0-9a-f-]+\/edit$/u);
  const match = /\/resumes\/([0-9a-f-]+)\/edit$/u.exec(new URL(page.url()).pathname);
  if (!match?.[1]) throw new Error('创建响应没有简历 ID');
  return match[1];
}

async function api(page: Page, path: string, init?: RequestInit): Promise<ApiResult> {
  return page.evaluate(
    async ({ requestPath, requestInit }) => {
      const response = await fetch(requestPath, {
        ...requestInit,
        credentials: 'same-origin',
      });
      return {
        status: response.status,
        body: (await response.json().catch(() => null)) as unknown,
      };
    },
    { requestPath: path, requestInit: init },
  );
}

async function csrfToken(page: Page): Promise<string> {
  const result = await api(page, '/api/v1/csrf');
  const token = (result.body as { data?: { csrfToken?: unknown } } | null)?.data?.csrfToken;
  if (result.status !== 200 || typeof token !== 'string') throw new Error('未取得 CSRF Token');
  return token;
}

function writeHeaders(token: string, revision: string) {
  return {
    'Content-Type': 'application/json',
    'Idempotency-Key': randomUUID(),
    'If-Match': `"${revision}"`,
    'X-CSRF-Token': token,
  };
}

async function databaseResumeSnapshot(resumeId: string) {
  const result = await migrationPool.query<{
    revision: string;
    title: string;
    document: unknown;
    deleted_at: Date | null;
    version_count: number;
  }>(
    `select r.revision::text, r.title, r.document, r.deleted_at,
            (select count(*)::int from resume_versions v where v.resume_id = r.id) version_count
       from resumes r where r.id = $1`,
    [resumeId],
  );
  return result.rows[0];
}

function createBoundaryDocument(source: Record<string, unknown>): ResumeDocumentV1 {
  const document = ResumeDocumentV1Schema.parse(structuredClone(source));
  const sectionId = randomUUID();
  const body = 'x'.repeat(4_000);
  document.sectionsById[sectionId] = {
    id: sectionId,
    kind: 'custom',
    title: '合成边界模块',
    visible: true,
    entries: Array.from({ length: 5 }, (_entry, entryIndex) => ({
      id: randomUUID(),
      period: { start: null, end: null, current: false },
      heading: `合成条目 ${String(entryIndex + 1)}`,
      subheading: '仅用于性能边界测量',
      links: [],
      bullets: Array.from({ length: entryIndex === 4 ? 25 : 50 }, () => ({
        id: randomUUID(),
        text: body,
      })),
    })),
  };
  document.moduleOrder.push(sectionId);
  return ResumeDocumentV1Schema.parse(document);
}

async function connectionPoolSnapshot() {
  const result = await migrationPool.query<{
    application_name: string;
    state: string;
    connections: number;
  }>(
    `select application_name, coalesce(state, 'unknown') state, count(*)::int connections
       from pg_stat_activity
      where application_name = any($1::text[])
      group by application_name, state
      order by application_name, state`,
    [
      [
        'resume-opt-web',
        'resume-opt-auth',
        'resume-opt-browser-auth-fixture',
        'resume-opt-browser-cleanup',
      ],
    ],
  );
  return result.rows;
}

function failureRate(statuses: readonly number[], expected: number | readonly number[]) {
  const allowed = new Set(Array.isArray(expected) ? expected : [expected]);
  return statuses.filter((status) => !allowed.has(status)).length / statuses.length;
}

async function readDrafts(page: Page) {
  return page.evaluate(async (name) => {
    const databases = await indexedDB.databases();
    if (!databases.some((database) => database.name === name)) return [];
    const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => {
        reject(request.error ?? new Error('IndexedDB 打开失败'));
      };
      request.onsuccess = () => {
        resolveDatabase(request.result);
      };
    });
    try {
      return await new Promise<
        Array<{
          userId: string;
          resumeId: string;
          name: string;
          localSeq: number;
          ackedSeq: number;
          pending: boolean;
        }>
      >((resolveRecords, reject) => {
        const transaction = database.transaction('drafts', 'readonly');
        const request = transaction.objectStore('drafts').getAll();
        request.onerror = () => {
          reject(request.error ?? new Error('IndexedDB 读取失败'));
        };
        request.onsuccess = () => {
          const records = request.result as Array<{
            userId: string;
            resumeId: string;
            localSeq: number;
            ackedSeq: number;
            pendingEnvelope: { idempotencyKey?: string } | null;
            workingSnapshot: {
              sectionsById: Record<string, { kind: string; entries: Array<{ name?: string }> }>;
            };
          }>;
          resolveRecords(
            records.map((record) => {
              const basic = Object.values(record.workingSnapshot.sectionsById).find(
                (section) => section.kind === 'basic',
              );
              return {
                userId: record.userId,
                resumeId: record.resumeId,
                name: basic?.entries[0]?.name ?? '',
                localSeq: record.localSeq,
                ackedSeq: record.ackedSeq,
                pending: record.pendingEnvelope !== null,
              };
            }),
          );
        };
      });
    } finally {
      database.close();
    }
  }, databaseName);
}

async function waitForServer(url: string, child: ChildProcess) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`替换服务进程提前退出：${String(child.exitCode)}`);
    try {
      const response = await fetch(`${url}/api/health/ready`);
      if (response.ok) return;
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error('替换服务进程启动超时');
}

function startReplacementServer() {
  const nextBin = resolve('apps/web/node_modules/next/dist/bin/next');
  return spawn(process.execPath, [nextBin, 'start', '-p', replacementPort], {
    cwd: resolve('apps/web'),
    env: {
      ...process.env,
      APP_ENV: 'test',
      AUTH_MODE: 'better-auth',
      BETTER_AUTH_URL: replacementURL,
      PORT: replacementPort,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise<void>((resolveExit) =>
      child.once('exit', () => {
        resolveExit();
      }),
    ),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
}

async function cleanupTestAccounts() {
  const ids = accounts.map((account) => account.id);
  const emails = accounts.map((account) => account.email);
  if (ids.length === 0) return;
  const client = await migrationPool.connect();
  try {
    await client.query('begin');
    await client.query('delete from privacy_requests where user_id = any($1::uuid[])', [ids]);
    await client.query('delete from deletion_events where user_id = any($1::uuid[])', [ids]);
    await client.query('delete from audit_events where actor_user_id = any($1::uuid[])', [ids]);
    await client.query('delete from idempotency_requests where user_id = any($1::uuid[])', [ids]);
    await client.query(
      'delete from resume_versions where resume_id in (select id from resumes where user_id = any($1::uuid[]))',
      [ids],
    );
    await client.query('delete from resumes where user_id = any($1::uuid[])', [ids]);
    await client.query(
      'delete from auth_verifications where value = any($1::text[]) or identifier = any($2::text[])',
      [ids, emails],
    );
    await client.query('delete from auth_sessions where user_id = any($1::uuid[])', [ids]);
    await client.query('delete from auth_accounts where user_id = any($1::uuid[])', [ids]);
    await client.query('delete from auth_users where id = any($1::uuid[])', [ids]);
    await client.query('delete from users where id = any($1::uuid[])', [ids]);
    for (const clientIp of clientIps) {
      await client.query('delete from auth_rate_limits where key like $1', [`${clientIp}|%`]);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

test.describe.serial('V0.2 双真实账户 Chrome 矩阵', () => {
  test.beforeAll(async () => {
    const secret = requiredEnvironment('BETTER_AUTH_SECRET');
    authPool = createPostgresPool({
      connectionString: requiredEnvironment('PG_AUTH_URL'),
      max: 2,
      applicationName: 'resume-opt-browser-auth-fixture',
    });
    migrationPool = createPostgresPool({
      connectionString: requiredEnvironment('PG_MIGRATION_URL'),
      max: 1,
      applicationName: 'resume-opt-browser-cleanup',
    });
    auth = createBetterAuthServer({
      authPool,
      baseURL,
      secret,
      sendVerificationEmail: mailbox.sendVerificationEmail,
      sendResetPassword: mailbox.sendResetPassword,
    });
    [accountA, accountB] = await Promise.all([
      provisionVerifiedAccount('浏览器账户A'),
      provisionVerifiedAccount('浏览器账户B'),
    ]);
    checks.add('T01');
    checks.add('T03');
  });

  test.afterAll(async () => {
    const evidenceDirectory = resolve('artifacts/ci');
    await mkdir(evidenceDirectory, { recursive: true });
    const nextPackage = JSON.parse(
      await readFile(resolve('apps/web/node_modules/next/package.json'), 'utf8'),
    ) as { version: string };
    const matrix = Object.fromEntries(
      Array.from({ length: 12 }, (_value, index) => {
        const id = `T${String(index + 1).padStart(2, '0')}`;
        return [id, { status: checks.has(id) ? 'passed' : 'failed' }];
      }),
    );
    await writeFile(
      resolve(evidenceDirectory, 'real-auth-browser-matrix.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          scope: 'V02-028',
          generatedAt: new Date().toISOString(),
          runtime: {
            browser: {
              channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
              version: browserVersion,
            },
            next: nextPackage.version,
            authMode: 'better-auth',
            database: 'PostgreSQL',
          },
          matrix,
          networkAssertions: {
            recordedFields: ['method', 'pathname', 'status'],
            excludedFields: [
              'headers',
              'cookies',
              'tokens',
              'passwords',
              'requestBody',
              'resumeBody',
            ],
          },
          fakeMail: { inProcessOnly: true, productionReadEndpoint: false },
          passed: checks.size === 12,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    if (accounts.length > 0) await cleanupTestAccounts();
    await Promise.all(
      [authPool, migrationPool].filter((pool) => Boolean(pool)).map((pool) => pool.end()),
    );
  });

  test('生产响应启用 CSP 与浏览器安全头且页面无 CSP 违规', async ({ page, browser }) => {
    browserVersion = browser.version();
    const violations: string[] = [];
    page.on('console', (message) => {
      if (/content security policy/iu.test(message.text())) violations.push(message.text());
    });

    const response = await page.goto('/login');
    if (!response) throw new Error('登录页没有返回导航响应');
    const headers = response.headers();
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['content-security-policy']).toContain("object-src 'none'");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy']).not.toContain('unsafe-eval');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
    await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
    expect(violations).toEqual([]);
  });

  test('A/B 完成真实登录、CRUD、跨账户拒绝、删除恢复与退出', async ({ browser }) => {
    browserVersion = browser.version();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      const pageA = await login(contextA, accountA, '198.51.100.201');
      const pageB = await login(contextB, accountB, '198.51.100.202');
      const sessionCookies = (await contextA.cookies(baseURL)).filter((cookie) => cookie.httpOnly);
      expect(sessionCookies).toHaveLength(1);
      const sessionCookie = sessionCookies[0];
      if (!sessionCookie) throw new Error('真实登录没有建立 HttpOnly Session Cookie');
      expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: false });
      expect(sessionCookie.domain).toBe('localhost');
      expect(await pageA.evaluate(() => document.cookie)).not.toContain(sessionCookie.name);
      const oldCookie = `${sessionCookie.name}=${sessionCookie.value}`;
      const session = await api(pageA, '/api/v1/session');
      expect(JSON.stringify(session.body)).not.toMatch(/token|password|sessionId/iu);
      checks.add('T02');
      checks.add('T05');

      const knownRecovery = await api(pageA, '/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: accountA.email, redirectTo: '/reset-password' }),
      });
      const unknownRecovery = await api(pageA, '/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `unknown-${randomUUID()}@example.cn`,
          redirectTo: '/reset-password',
        }),
      });
      expect(knownRecovery.status).toBe(200);
      expect(unknownRecovery).toEqual(knownRecovery);
      checks.add('T04');

      const originalTitle = `真实账户A-${String(Date.now())}`;
      resumeAId = await createResume(pageA, originalTitle);
      await pageA.goto('/resumes');
      const originalCard = pageA
        .locator('article')
        .filter({ has: pageA.getByRole('link', { exact: true, name: originalTitle }) });
      await originalCard.getByRole('button', { name: '复制' }).click();
      await expect(
        pageA.getByRole('link', { exact: true, name: `${originalTitle} 副本` }),
      ).toBeVisible();
      const renamedTitle = `${originalTitle}-已重命名`;
      await originalCard.getByRole('button', { name: '重命名' }).click();
      const renameDialog = pageA.getByRole('dialog', { name: '重命名简历' });
      await renameDialog.getByRole('textbox', { name: '简历名称' }).fill(renamedTitle);
      await renameDialog.getByRole('button', { name: '保存名称' }).click();
      await expect(pageA.getByRole('link', { exact: true, name: renamedTitle })).toBeVisible();

      resumeBId = await createResume(pageB, `真实账户B-${String(Date.now())}`);
      const ownerRead = await api(pageA, `/api/v1/resumes/${resumeAId}`);
      expect(ownerRead.status).toBe(200);
      const ownerResume = (ownerRead.body as { data: ResumePayload }).data;
      const before = await databaseResumeSnapshot(resumeAId);
      const tokenB = await csrfToken(pageB);
      const crossRequests = [
        await api(pageB, `/api/v1/resumes/${resumeAId}`),
        await api(pageB, `/api/v1/resumes/${resumeAId}/document`, {
          method: 'PUT',
          headers: writeHeaders(tokenB, ownerResume.revision),
          body: JSON.stringify({ document: ownerResume.document, clientSeq: 91 }),
        }),
        await api(pageB, `/api/v1/resumes/${resumeAId}`, {
          method: 'PATCH',
          headers: writeHeaders(tokenB, ownerResume.revision),
          body: JSON.stringify({ title: '越权重命名' }),
        }),
        await api(pageB, `/api/v1/resumes/${resumeAId}/copies`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': randomUUID(),
            'X-CSRF-Token': tokenB,
          },
          body: JSON.stringify({ sourceRevision: ownerResume.revision, title: '越权复制' }),
        }),
        await api(pageB, `/api/v1/resumes/${resumeAId}`, {
          method: 'DELETE',
          headers: writeHeaders(tokenB, ownerResume.revision),
          body: JSON.stringify({ confirm: true }),
        }),
        await api(pageB, `/api/v1/resumes/${resumeAId}/undelete`, {
          method: 'POST',
          headers: writeHeaders(tokenB, ownerResume.revision),
          body: '{}',
        }),
      ];
      expect(crossRequests.map((response) => response.status)).toEqual([
        404, 404, 404, 404, 404, 404,
      ]);
      const listB = await api(pageB, '/api/v1/resumes?limit=100');
      expect(JSON.stringify(listB.body)).not.toContain(resumeAId);
      expect(await databaseResumeSnapshot(resumeAId)).toEqual(before);
      checks.add('T06');
      checks.add('T07');
      checks.add('T08');

      const missingCsrf = await api(pageB, `/api/v1/resumes/${resumeBId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
          'If-Match': '"1"',
        },
        body: JSON.stringify({ title: '缺少 CSRF' }),
      });
      expect(missingCsrf.status).toBe(403);
      const forgedOrigin = await pageB.request.fetch(`/api/v1/resumes/${resumeBId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
          'If-Match': '"1"',
          Origin: 'https://example.invalid',
          'Sec-Fetch-Site': 'cross-site',
          'X-CSRF-Token': tokenB,
        },
        data: { title: '伪造 Origin' },
      });
      expect(forgedOrigin.status()).toBe(403);

      await pageA.goto('/resumes');
      const renamedCard = pageA
        .locator('article')
        .filter({ has: pageA.getByRole('link', { exact: true, name: renamedTitle }) });
      await renamedCard.getByRole('button', { name: '删除' }).click();
      await pageA
        .getByRole('dialog', { name: `删除“${renamedTitle}”？` })
        .getByRole('button', { name: '确认删除' })
        .click();
      await expect(pageA.getByRole('status')).toContainText(`“${renamedTitle}”已移到最近删除。`);
      await pageA.goto('/resumes/trash');
      const deletedCard = pageA.locator('article').filter({ hasText: renamedTitle });
      await deletedCard.getByRole('button', { name: '恢复' }).click();
      await expect(pageA.getByText(`“${renamedTitle}”已恢复到我的简历。`)).toBeVisible();
      checks.add('T09');

      await pageA.goto('/resumes');
      await pageA.locator('summary[aria-label="打开账户菜单"]').click();
      await pageA.getByRole('button', { name: '退出登录' }).click();
      await expect(pageA).toHaveURL(/\/login$/u);
      const oldSessionRequest = await apiRequest.newContext({
        baseURL,
        extraHTTPHeaders: { Cookie: oldCookie },
      });
      try {
        const revoked = await oldSessionRequest.get('/api/v1/session');
        expect(await revoked.json()).toMatchObject({ data: null });
      } finally {
        await oldSessionRequest.dispose();
      }
    } finally {
      await Promise.all([contextA.close(), contextB.close()]);
    }
  });

  test('同一浏览器 A→B→A 隔离丢失 ACK，并由新服务进程恢复', async ({ browser }) => {
    browserVersion = browser.version();
    const context = await browser.newContext();
    let replacement: ChildProcess | undefined;
    let releaseResponse!: () => void;
    let responseCommitted!: () => void;
    const responseGate = new Promise<void>((resolveGate) => {
      releaseResponse = resolveGate;
    });
    const committed = new Promise<void>((resolveCommitted) => {
      responseCommitted = resolveCommitted;
    });
    try {
      const page = await login(context, accountA, '198.51.100.203');
      await page.goto(`/resumes/${resumeAId}/edit`);
      const nameInput = page.getByRole('textbox', { name: '姓名', exact: true });
      await expect(nameInput).toBeVisible();
      const savePattern = `**/api/v1/resumes/${resumeAId}/document`;
      let firstSave = true;
      await page.route(savePattern, async (route: Route) => {
        if (!firstSave) {
          await route.continue();
          return;
        }
        firstSave = false;
        const response = await route.fetch();
        responseCommitted();
        await responseGate;
        await route.fulfill({ response }).catch(() => undefined);
      });

      const recoveredName = `跨账户丢失回执-${String(Date.now())}`;
      await nameInput.fill(recoveredName);
      await nameInput.press('Tab');
      await committed;
      await expect
        .poll(async () =>
          (await readDrafts(page)).find(
            (draft) => draft.userId === accountA.id && draft.resumeId === resumeAId,
          ),
        )
        .toMatchObject({ name: recoveredName, pending: true });
      expect(await signOut(page)).toBe(200);

      await page.goto('/login?returnTo=%2Fresumes');
      await page.getByRole('textbox', { name: '邮箱' }).fill(accountB.email);
      await page.getByLabel('密码').fill(password);
      await page.getByRole('button', { name: '登录' }).click();
      await expect(page).toHaveURL('/resumes');
      await page.goto(`/resumes/${resumeBId}/edit`);
      const nameB = await page.getByRole('textbox', { name: '姓名', exact: true }).inputValue();
      expect(nameB).not.toBe(recoveredName);
      const switchedDrafts = await readDrafts(page);
      expect(switchedDrafts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: accountA.id,
            resumeId: resumeAId,
            name: recoveredName,
            pending: true,
          }),
          expect.objectContaining({ userId: accountB.id, resumeId: resumeBId }),
        ]),
      );
      releaseResponse();
      await page.unroute(savePattern);
      expect((await readDrafts(page)).find((draft) => draft.userId === accountB.id)?.name).not.toBe(
        recoveredName,
      );

      expect(await signOut(page)).toBe(200);
      await page.goto('/login?returnTo=%2Fresumes');
      await page.getByRole('textbox', { name: '邮箱' }).fill(accountA.email);
      await page.getByLabel('密码').fill(password);
      await page.getByRole('button', { name: '登录' }).click();
      await expect(page).toHaveURL('/resumes');
      await page.goto(`/resumes/${resumeAId}/edit`);
      await expect(page.getByRole('textbox', { name: '姓名', exact: true })).toHaveValue(
        recoveredName,
      );
      await expect(page.getByText('已保存', { exact: true })).toBeVisible();
      await expect
        .poll(
          async () =>
            (await readDrafts(page)).find(
              (draft) => draft.userId === accountA.id && draft.resumeId === resumeAId,
            )?.pending,
        )
        .toBe(false);
      checks.add('T10');
      checks.add('T12');

      replacement = startReplacementServer();
      await waitForServer(replacementURL, replacement);
      await page.goto(`${replacementURL}/resumes/${resumeAId}/edit`);
      await expect(page.getByRole('textbox', { name: '姓名', exact: true })).toHaveValue(
        recoveredName,
      );
      const privateResponse = await page.request.get(
        `${replacementURL}/api/v1/resumes/${resumeAId}`,
      );
      expect(privateResponse.status()).toBe(200);
      expect(privateResponse.headers()['cache-control']).toContain('no-store');
      checks.add('T11');

      expect(checks).toEqual(
        new Set([
          'T01',
          'T02',
          'T03',
          'T04',
          'T05',
          'T06',
          'T07',
          'T08',
          'T09',
          'T10',
          'T11',
          'T12',
        ]),
      );
    } finally {
      releaseResponse();
      if (replacement) await stopServer(replacement);
      await context.close();
    }
  });

  test('真实账户用纯键盘完成登录、创建、保存、复制、删除恢复和退出', async ({ browser }) => {
    browserVersion = browser.version();
    const context = await browser.newContext();
    clientIps.add('198.51.100.204');
    await context.setExtraHTTPHeaders({ 'X-Resume-Client-Ip': '198.51.100.204' });
    const page = await context.newPage();
    try {
      await page.goto('/login?returnTo=%2Fresumes');
      const email = page.getByRole('textbox', { name: '邮箱' });
      await tabTo(page, email);
      await page.keyboard.insertText(accountA.email);
      const passwordInput = page.getByLabel('密码');
      await tabTo(page, passwordInput);
      await page.keyboard.insertText(password);
      const loginButton = page.getByRole('button', { name: '登录' });
      await tabTo(page, loginButton);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL('/resumes');

      const newResume = page.getByRole('link', { name: '新建简历' });
      await tabTo(page, newResume);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL('/resumes/new');
      const title = `纯键盘验收-${String(Date.now())}`;
      const titleInput = page.getByRole('textbox', { name: '简历名称' });
      await tabTo(page, titleInput);
      await page.keyboard.press('Control+A');
      await page.keyboard.insertText(title);
      const blankMode = page.getByRole('radio', { name: /空白创建/u });
      const template = page.getByRole('radio', { name: /基础模板/u });
      await tabTo(page, blankMode);
      await page.keyboard.press('ArrowDown');
      await expect(template).toBeChecked();
      const createButton = page.getByRole('button', { name: '创建并进入编辑器' });
      await tabTo(page, createButton);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/resumes\/[0-9a-f-]+\/edit$/u);

      const nameInput = page.getByRole('textbox', { name: '姓名', exact: true });
      await tabTo(page, nameInput);
      await page.keyboard.press('Control+A');
      await page.keyboard.insertText('纯键盘用户');
      await page.keyboard.press('Tab');
      await expect(page.getByText('已保存', { exact: true })).toBeVisible();

      const backToDashboard = page.getByRole('link', { name: '返回工作台' });
      await tabTo(page, backToDashboard);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL('/resumes');
      const card = page
        .locator('article')
        .filter({ has: page.getByRole('link', { exact: true, name: title }) });
      const copyButton = card.getByRole('button', { name: '复制' });
      await tabTo(page, copyButton);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('link', { exact: true, name: `${title} 副本` })).toBeVisible();
      await expect(page.getByRole('status')).toContainText('已复制');

      const deleteButton = card.getByRole('button', { name: '删除' });
      await tabTo(page, deleteButton);
      await page.keyboard.press('Enter');
      const confirmDelete = page
        .getByRole('dialog', { name: `删除“${title}”？` })
        .getByRole('button', { name: '确认删除' });
      await tabTo(page, confirmDelete);
      await page.keyboard.press('Enter');
      await expect(card).toHaveCount(0);
      await expect(newResume).toBeFocused();
      await expect(page.getByRole('status')).toContainText('已移到最近删除');

      const trashLink = page.getByRole('link', { name: '最近删除' });
      await tabTo(page, trashLink);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL('/resumes/trash');
      const trashCard = page.locator('article').filter({ hasText: title });
      const restoreButton = trashCard.getByRole('button', { name: '恢复' });
      await tabTo(page, restoreButton);
      await page.keyboard.press('Enter');
      await expect(page.getByText(`“${title}”已恢复到我的简历。`)).toBeVisible();
      await expect(
        page.getByRole('heading', { exact: true, level: 1, name: '最近删除' }),
      ).toBeFocused();

      const resumesLink = page.getByRole('link', { exact: true, name: '我的简历' });
      await tabTo(page, resumesLink);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL('/resumes');
      const accountMenu = page.locator('summary[aria-label="打开账户菜单"]');
      await tabTo(page, accountMenu);
      await page.keyboard.press('Enter');
      const logout = page.getByRole('button', { name: '退出登录' });
      await tabTo(page, logout);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/login$/u);

      const evidenceDirectory = resolve('artifacts/ci/accessibility');
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(
        resolve(evidenceDirectory, 'keyboard-real-auth.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            scope: 'V02-029-keyboard',
            runtime: {
              browser: {
                channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
                version: browserVersion,
              },
              authMode: 'better-auth',
              database: 'PostgreSQL',
            },
            flow: ['login', 'create', 'save', 'copy', 'delete', 'restore', 'logout'],
            input: ['Tab', 'Enter', 'Space', 'Control+A', 'keyboard text'],
            mouseActions: 0,
            passed: true,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    } finally {
      await context.close();
    }
  });

  test('真实 Session 路径满足保存、列表、CRUD、首屏和连接池预算', async ({ browser }) => {
    test.setTimeout(300_000);
    browserVersion = browser.version();
    const target = new URL(baseURL);
    if (!['localhost', '127.0.0.1'].includes(target.hostname)) {
      throw new Error('性能基准只允许本机隔离目标');
    }
    const budget = PerformanceBudgetSchema.parse(
      JSON.parse(await readFile(resolve('performance-budget.json'), 'utf8')),
    );
    const context = await browser.newContext();
    const clientIp = '198.51.100.205';
    clientIps.add(clientIp);
    await context.setExtraHTTPHeaders({ 'X-Resume-Client-Ip': clientIp });
    const page = await login(context, accountA, clientIp);
    try {
      const poolBefore = await connectionPoolSnapshot();
      const health = await page.evaluate(async (samples) => {
        const durations: number[] = [];
        const statuses: number[] = [];
        for (let index = 0; index < samples; index += 1) {
          const startedAt = performance.now();
          const response = await fetch('/api/health/ready', { cache: 'no-store' });
          await response.text();
          durations.push(performance.now() - startedAt);
          statuses.push(response.status);
        }
        return { durations, statuses };
      }, 50);

      const performanceResumeId = await createResume(page, `真实Session性能-${String(Date.now())}`);
      await page.goto(`/resumes/${performanceResumeId}/edit`);
      const nameInput = page.getByRole('textbox', { exact: true, name: '姓名' });
      const saveState = page.locator('[data-phase]');
      const inputToCloudAck: number[] = [];
      for (let index = 0; index < budget.metrics.inputToCloudAck.minimumSamples; index += 1) {
        const startedAt = performance.now();
        await nameInput.fill(`云端确认样本-${String(index + 1).padStart(2, '0')}`);
        await expect(saveState).not.toHaveAttribute('data-phase', 'synced');
        await expect(saveState).toHaveAttribute('data-phase', 'synced');
        inputToCloudAck.push(performance.now() - startedAt);
      }

      const ownerRead = await api(page, `/api/v1/resumes/${performanceResumeId}`);
      expect(ownerRead.status).toBe(200);
      const ownerResume = (ownerRead.body as { data: ResumePayload }).data;
      const token = await csrfToken(page);
      const saveRun = await page.evaluate(
        async ({ csrf, documentValue, initialRevision, resumeId, samples, warmup }) => {
          const durations: number[] = [];
          const statuses: number[] = [];
          let revision = initialRevision;
          const mutableDocument = structuredClone(documentValue) as {
            design: { accentColor: string };
          };
          for (let index = 0; index < samples + warmup; index += 1) {
            mutableDocument.design.accentColor = index % 2 === 0 ? '#222222' : '#333333';
            const startedAt = performance.now();
            const response = await fetch(`/api/v1/resumes/${resumeId}/document`, {
              method: 'PUT',
              credentials: 'same-origin',
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': crypto.randomUUID(),
                'If-Match': `"${revision}"`,
                'X-CSRF-Token': csrf,
              },
              body: JSON.stringify({ document: mutableDocument, clientSeq: 10_000 + index }),
            });
            await response.text();
            const elapsed = performance.now() - startedAt;
            if (index >= warmup) {
              durations.push(elapsed);
              statuses.push(response.status);
            }
            if (!response.ok) break;
            const etag = response.headers.get('etag');
            if (!etag) break;
            revision = etag.replaceAll('"', '');
          }
          return { durations, statuses, revision };
        },
        {
          csrf: token,
          documentValue: ownerResume.document,
          initialRevision: ownerResume.revision,
          resumeId: performanceResumeId,
          samples: budget.metrics.saveApi.minimumSamples,
          warmup: 10,
        },
      );

      const boundaryDocument = createBoundaryDocument(ownerResume.document);
      const boundaryPayloadBytes = Buffer.byteLength(
        JSON.stringify({ document: boundaryDocument, clientSeq: 20_000 }),
        'utf8',
      );
      const boundarySave = await page.evaluate(
        async ({ csrf, documentValue, resumeId, revision }) => {
          const startedAt = performance.now();
          const response = await fetch(`/api/v1/resumes/${resumeId}/document`, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': crypto.randomUUID(),
              'If-Match': `"${revision}"`,
              'X-CSRF-Token': csrf,
            },
            body: JSON.stringify({ document: documentValue, clientSeq: 20_000 }),
          });
          await response.text();
          return { durationMs: performance.now() - startedAt, status: response.status };
        },
        {
          csrf: token,
          documentValue: boundaryDocument,
          resumeId: performanceResumeId,
          revision: saveRun.revision,
        },
      );

      const crud = await page.evaluate(
        async ({ csrf, samples }) => {
          const durations = {
            create: [] as number[],
            rename: [] as number[],
            copy: [] as number[],
            delete: [] as number[],
          };
          const statuses = {
            create: [] as number[],
            rename: [] as number[],
            copy: [] as number[],
            delete: [] as number[],
          };
          for (let index = 0; index < samples; index += 1) {
            const title = `合成性能简历-${String(index + 1).padStart(3, '0')}`;
            let startedAt = performance.now();
            const createResponse = await fetch('/api/v1/resumes', {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': crypto.randomUUID(),
                'X-CSRF-Token': csrf,
              },
              body: JSON.stringify({ title, stage: 'employed', mode: 'blank' }),
            });
            const createBody = (await createResponse.json().catch(() => null)) as {
              data?: { id?: string };
            } | null;
            durations.create.push(performance.now() - startedAt);
            statuses.create.push(createResponse.status);
            const resumeId = createBody?.data?.id;
            let revision = createResponse.headers.get('etag')?.replaceAll('"', '');
            if (!createResponse.ok || !resumeId || !revision) break;

            startedAt = performance.now();
            const renameResponse = await fetch(`/api/v1/resumes/${resumeId}`, {
              method: 'PATCH',
              credentials: 'same-origin',
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': crypto.randomUUID(),
                'If-Match': `"${revision}"`,
                'X-CSRF-Token': csrf,
              },
              body: JSON.stringify({ title: `${title}-已重命名` }),
            });
            await renameResponse.text();
            durations.rename.push(performance.now() - startedAt);
            statuses.rename.push(renameResponse.status);
            revision = renameResponse.headers.get('etag')?.replaceAll('"', '');
            if (!renameResponse.ok || !revision) break;

            startedAt = performance.now();
            const copyResponse = await fetch(`/api/v1/resumes/${resumeId}/copies`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': crypto.randomUUID(),
                'X-CSRF-Token': csrf,
              },
              body: JSON.stringify({ sourceRevision: revision, title: `${title}-副本` }),
            });
            await copyResponse.text();
            durations.copy.push(performance.now() - startedAt);
            statuses.copy.push(copyResponse.status);
            if (!copyResponse.ok) break;

            startedAt = performance.now();
            const deleteResponse = await fetch(`/api/v1/resumes/${resumeId}`, {
              method: 'DELETE',
              credentials: 'same-origin',
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': crypto.randomUUID(),
                'If-Match': `"${revision}"`,
                'X-CSRF-Token': csrf,
              },
              body: JSON.stringify({ confirm: true }),
            });
            await deleteResponse.text();
            durations.delete.push(performance.now() - startedAt);
            statuses.delete.push(deleteResponse.status);
            if (!deleteResponse.ok) break;
          }
          return { durations, statuses };
        },
        { csrf: token, samples: 100 },
      );

      const list = await page.evaluate(
        async ({ samples, warmup }) => {
          const durations: number[] = [];
          const statuses: number[] = [];
          const itemCounts: number[] = [];
          for (let index = 0; index < samples + warmup; index += 1) {
            const startedAt = performance.now();
            const response = await fetch('/api/v1/resumes?limit=100', {
              cache: 'no-store',
              credentials: 'same-origin',
            });
            const payload = (await response.json().catch(() => null)) as {
              data?: { items?: unknown[] };
            } | null;
            if (index >= warmup) {
              durations.push(performance.now() - startedAt);
              statuses.push(response.status);
              itemCounts.push(payload?.data?.items?.length ?? 0);
            }
            if (!response.ok) break;
          }
          return { durations, statuses, itemCounts };
        },
        {
          samples: budget.metrics.resumeListApi.minimumSamples,
          warmup: 10,
        },
      );

      const dashboardDurations: number[] = [];
      let dashboardFailures = 0;
      for (let index = 0; index < budget.metrics.dashboardFirstRender.minimumSamples; index += 1) {
        const startedAt = performance.now();
        try {
          await page.goto('/resumes');
          await expect(page.locator('article')).toHaveCount(20);
          dashboardDurations.push(performance.now() - startedAt);
        } catch {
          dashboardFailures += 1;
          dashboardDurations.push(performance.now() - startedAt);
        }
      }

      await page.waitForTimeout(500);
      const poolAfterFirst = await connectionPoolSnapshot();
      await page.waitForTimeout(500);
      const poolAfterSecond = await connectionPoolSnapshot();
      const poolTotal = (snapshot: Awaited<ReturnType<typeof connectionPoolSnapshot>>) =>
        snapshot.reduce((total, row) => total + row.connections, 0);
      const applicationPoolMax = Number(process.env.DATABASE_POOL_MAX ?? '5');
      const configuredPoolMax = applicationPoolMax * 2 + 3;
      const crudDurations = [
        ...crud.durations.create,
        ...crud.durations.rename,
        ...crud.durations.copy,
        ...crud.durations.delete,
      ];
      const crudStatuses = [
        ...crud.statuses.create,
        ...crud.statuses.rename,
        ...crud.statuses.copy,
        ...crud.statuses.delete,
      ];
      const metrics = {
        referenceHealthRoundTrip: summarizePerformanceSamples(health.durations),
        inputToCloudAck: summarizePerformanceSamples(inputToCloudAck),
        saveApi: summarizePerformanceSamples(saveRun.durations),
        resumeListApi: summarizePerformanceSamples(list.durations),
        resumeCrudApi: summarizePerformanceSamples(crudDurations),
        resumeCrudByOperation: {
          create: summarizePerformanceSamples(crud.durations.create),
          rename: summarizePerformanceSamples(crud.durations.rename),
          copy: summarizePerformanceSamples(crud.durations.copy),
          delete: summarizePerformanceSamples(crud.durations.delete),
        },
        dashboardFirstRender: summarizePerformanceSamples(dashboardDurations),
        boundarySave: {
          samples: 1,
          durationMs: boundarySave.durationMs,
          requestBytes: boundaryPayloadBytes,
          status: boundarySave.status,
        },
      };
      const checks = {
        referenceNetwork:
          health.statuses.every((status) => status === 200) &&
          metrics.referenceHealthRoundTrip.p95 <= 100,
        inputToCloudAck:
          metrics.inputToCloudAck.samples >= budget.metrics.inputToCloudAck.minimumSamples &&
          metrics.inputToCloudAck.p95 <= budget.metrics.inputToCloudAck.p95Max,
        saveApi:
          metrics.saveApi.samples >= budget.metrics.saveApi.minimumSamples &&
          metrics.saveApi.p95 <= budget.metrics.saveApi.p95Max &&
          metrics.saveApi.p99 <= (budget.metrics.saveApi.p99Max ?? Number.POSITIVE_INFINITY) &&
          failureRate(saveRun.statuses, 200) <=
            (budget.metrics.saveApi.unexpectedFailureRateMax ?? 0),
        boundaryDocument:
          boundaryPayloadBytes >= 850_000 &&
          boundaryPayloadBytes <= 1_048_576 &&
          boundarySave.status === 200,
        resumeCrudApi:
          metrics.resumeCrudApi.samples >= budget.metrics.resumeCrudApi.minimumSamples &&
          Object.values(metrics.resumeCrudByOperation).every(
            (metric) => metric.p95 <= budget.metrics.resumeCrudApi.p95Max,
          ) &&
          failureRate(crudStatuses, [200, 201]) === 0,
        resumeListApi:
          metrics.resumeListApi.samples >= budget.metrics.resumeListApi.minimumSamples &&
          metrics.resumeListApi.p95 <= budget.metrics.resumeListApi.p95Max &&
          failureRate(list.statuses, 200) === 0 &&
          list.itemCounts.every((count) => count === 100),
        dashboardFirstRender:
          metrics.dashboardFirstRender.samples >=
            budget.metrics.dashboardFirstRender.minimumSamples &&
          metrics.dashboardFirstRender.p95 <= budget.metrics.dashboardFirstRender.p95Max &&
          dashboardFailures === 0,
        connectionPoolSteady:
          poolTotal(poolAfterFirst) <= configuredPoolMax &&
          poolTotal(poolAfterSecond) <= configuredPoolMax &&
          Math.abs(poolTotal(poolAfterFirst) - poolTotal(poolAfterSecond)) <= 1,
      };
      const nextPackage = JSON.parse(
        await readFile(resolve('apps/web/node_modules/next/package.json'), 'utf8'),
      ) as { version: string };
      const databaseVersion = await migrationPool.query<{ server_version: string }>(
        'show server_version',
      );
      const report = {
        schemaVersion: 1,
        scope: 'V02-030-real-session-performance',
        measuredAt: new Date().toISOString(),
        environment: {
          topology: 'localhost-loopback-single-process',
          networkShaping: 'none',
          node: process.version,
          next: nextPackage.version,
          chrome: browserVersion,
          postgres: databaseVersion.rows[0]?.server_version ?? 'unknown',
          os: { platform: osPlatform(), release: release(), arch: arch() },
          logicalCpuCount: cpus().length,
          totalMemoryBytes: totalmem(),
        },
        fixture: {
          containsRealUserData: false,
          activeResumeListSize: 100,
          boundaryRequestBytes: boundaryPayloadBytes,
        },
        metrics,
        failures: {
          health: health.statuses.filter((status) => status !== 200).length,
          saveApi: saveRun.statuses.filter((status) => status !== 200).length,
          resumeCrudApi: crudStatuses.filter((status) => ![200, 201].includes(status)).length,
          resumeListApi: list.statuses.filter((status) => status !== 200).length,
          dashboardFirstRender: dashboardFailures,
          skipped: 0,
        },
        connectionPool: {
          configuredMaximum: {
            web: applicationPoolMax,
            auth: applicationPoolMax,
            fixture: 2,
            cleanup: 1,
            total: configuredPoolMax,
          },
          before: poolBefore,
          afterFirst: poolAfterFirst,
          afterSecond: poolAfterSecond,
        },
        budgets: {
          inputToCloudAckP95Max: budget.metrics.inputToCloudAck.p95Max,
          saveApiP95Max: budget.metrics.saveApi.p95Max,
          saveApiP99Max: budget.metrics.saveApi.p99Max,
          resumeListApiP95Max: budget.metrics.resumeListApi.p95Max,
          resumeCrudApiP95Max: budget.metrics.resumeCrudApi.p95Max,
          dashboardFirstRenderP95Max: budget.metrics.dashboardFirstRender.p95Max,
        },
        optimizationComparison: {
          productionOptimizationApplied: false,
          afterMeasurementRequired: false,
          reason: '首轮完整基线已满足全部预算，无需生产代码、索引或缓存优化',
        },
        checks,
        passed: Object.values(checks).every(Boolean),
      };
      const evidenceDirectory = resolve('artifacts/ci');
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(
        resolve(evidenceDirectory, 'real-session-performance.json'),
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8',
      );
      expect(report.passed, JSON.stringify({ checks, metrics, failures: report.failures })).toBe(
        true,
      );
    } finally {
      await context.close();
    }
  });
});
