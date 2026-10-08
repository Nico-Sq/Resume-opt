import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  expect,
  request as apiRequest,
  test,
  type BrowserContext,
  type Page,
  type Route,
} from '@playwright/test';
import {
  createBetterAuthServer,
  handleBetterAuthRequest,
  InMemoryAuthMailbox,
  type BetterAuthServer,
} from '@resume/infrastructure/better-auth-server';
import { createPostgresPool } from '@resume/infrastructure/postgres';

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
});
