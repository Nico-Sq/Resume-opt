import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GetResumeForEditor,
  IdempotencyKeyReusedError,
  ResourceNotFoundError,
  RevisionConflictError,
  SaveResumeDocument,
  type SaveResumeDocumentInput,
} from '@resume/application';
import { parseServerRuntimeConfig } from '@resume/config/server';
import type { ResumeDocumentV1 } from '@resume/domain/resume';
import { FixedIdentityProvider } from '@resume/infrastructure/fixed-identity';
import { runMigrations } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import { seedFixedResume } from '@resume/infrastructure/resume-seed';
import { PostgresUserTransactionManager } from '@resume/infrastructure/resume-transactions';

const config = parseServerRuntimeConfig({
  ...process.env,
  APP_ENV: 'test',
  AUTH_MODE: 'better-auth',
});
const schema = `save_${randomUUID().replaceAll('-', '')}`;
const migrationsDirectory = resolve(import.meta.dirname, '../../database/migrations');
const migrationPool = createPostgresPool({
  connectionString: config.PG_MIGRATION_URL,
  max: 1,
  applicationName: 'resume-opt-save-migration-test',
});
const applicationPool = createPostgresPool({
  connectionString: config.PG_DEV_URL,
  max: 6,
  applicationName: 'resume-opt-save-app-test',
});
let schemaCreated = false;

beforeAll(async () => {
  await migrationPool.query(`create schema "${schema}" authorization resume_opt_migrator`);
  schemaCreated = true;
  await migrationPool.query(`grant usage on schema "${schema}" to resume_opt_app`);
  await runMigrations(migrationPool, migrationsDirectory, schema);
});

afterAll(async () => {
  if (schemaCreated && /^save_[a-f0-9]{32}$/u.test(schema)) {
    await migrationPool.query(`drop schema "${schema}" cascade`);
  }
  await Promise.all([migrationPool.end(), applicationPool.end()]);
});

function transactionManager() {
  return new PostgresUserTransactionManager(applicationPool, schema);
}

function saveUseCase(userId: string) {
  return new SaveResumeDocument(
    new FixedIdentityProvider({ appEnvironment: 'test', userId }),
    transactionManager(),
  );
}

function readUseCase(userId: string) {
  return new GetResumeForEditor(
    new FixedIdentityProvider({ appEnvironment: 'test', userId }),
    transactionManager(),
  );
}

async function fixture() {
  const userId = randomUUID();
  const resumeId = randomUUID();
  await seedFixedResume(migrationPool, {
    userId,
    resumeId,
    versionId: randomUUID(),
    schema,
  });
  const stored = await readUseCase(userId).execute(resumeId);
  return { userId, resumeId, document: stored.document };
}

function namedDocument(document: ResumeDocumentV1, name: string): ResumeDocumentV1 {
  const next = structuredClone(document);
  const basic = Object.values(next.sectionsById).find((section) => section.kind === 'basic');
  const entry = basic?.entries[0];
  if (!entry) throw new Error('测试文档缺少基本信息');
  entry.name = name;
  return next;
}

function input(
  resumeId: string,
  document: ResumeDocumentV1,
  overrides: Partial<SaveResumeDocumentInput> = {},
): SaveResumeDocumentInput {
  return {
    resumeId,
    document,
    baseRevision: '1',
    clientSeq: 1,
    idempotencyKey: randomUUID(),
    traceId: randomUUID(),
    ...overrides,
  };
}

describe('PostgreSQL resume save transaction', () => {
  it('atomically updates the current document, creates one immutable version and replays one receipt', async () => {
    const current = await fixture();
    const document = namedDocument(current.document, '第一次保存');
    const command = input(current.resumeId, document, { clientSeq: 18 });
    const first = await saveUseCase(current.userId).execute(command);
    const replay = await saveUseCase(current.userId).execute({
      ...command,
      traceId: randomUUID(),
    });

    expect(first.replayed).toBe(false);
    expect(first.receipt).toMatchObject({
      resumeId: current.resumeId,
      revision: '2',
      acknowledgedSeq: 18,
    });
    expect(replay).toEqual({ receipt: first.receipt, replayed: true });

    const persisted = await migrationPool.query<{
      document: ResumeDocumentV1;
      revision: string;
      version_count: number;
      idempotency_count: number;
      audit_count: number;
    }>(
      `select r.document, r.revision::text,
              (select count(*)::int from "${schema}".resume_versions v where v.resume_id = r.id) as version_count,
              (select count(*)::int from "${schema}".idempotency_requests i where i.user_id = r.user_id) as idempotency_count,
              (select count(*)::int from "${schema}".audit_events a where a.resource_id = r.id) as audit_count
         from "${schema}".resumes r where r.id = $1`,
      [current.resumeId],
    );
    expect(persisted.rows[0]).toMatchObject({
      document,
      revision: '2',
      version_count: 2,
      idempotency_count: 1,
      audit_count: 1,
    });
    const version = await migrationPool.query<{ snapshot: ResumeDocumentV1; content_hash: string }>(
      `select snapshot, content_hash from "${schema}".resume_versions where id = $1`,
      [first.receipt.versionId],
    );
    expect(version.rows[0]?.snapshot).toEqual(document);
    expect(version.rows[0]?.content_hash).toBe(first.receipt.contentHash);
  });

  it('rejects reuse of one idempotency key with a different request without another write', async () => {
    const current = await fixture();
    const key = randomUUID();
    await saveUseCase(current.userId).execute(
      input(current.resumeId, namedDocument(current.document, '原请求'), {
        idempotencyKey: key,
      }),
    );

    await expect(
      saveUseCase(current.userId).execute(
        input(current.resumeId, namedDocument(current.document, '偷换后的请求'), {
          idempotencyKey: key,
        }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);

    const count = await migrationPool.query<{ count: number }>(
      `select count(*)::int as count from "${schema}".resume_versions where resume_id = $1`,
      [current.resumeId],
    );
    expect(count.rows[0]?.count).toBe(2);
  });

  it('serializes concurrent retries with the same key into one version and one receipt', async () => {
    const current = await fixture();
    const command = input(current.resumeId, namedDocument(current.document, '并发重放'), {
      clientSeq: 12,
    });
    const [first, second] = await Promise.all([
      saveUseCase(current.userId).execute(command),
      saveUseCase(current.userId).execute({ ...command, traceId: randomUUID() }),
    ]);

    expect(first.receipt).toEqual(second.receipt);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    const count = await migrationPool.query<{ count: number }>(
      `select count(*)::int as count from "${schema}".resume_versions where resume_id = $1`,
      [current.resumeId],
    );
    expect(count.rows[0]?.count).toBe(2);
  });

  it('allows only one of two concurrent writers from the same revision', async () => {
    const current = await fixture();
    const results = await Promise.allSettled([
      saveUseCase(current.userId).execute(
        input(current.resumeId, namedDocument(current.document, '设备甲')),
      ),
      saveUseCase(current.userId).execute(
        input(current.resumeId, namedDocument(current.document, '设备乙')),
      ),
    ]);

    const successes = results.filter((result) => result.status === 'fulfilled');
    const failures = results.filter((result) => result.status === 'rejected');
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    const conflict = failures[0]?.reason as unknown;
    expect(conflict).toBeInstanceOf(RevisionConflictError);
    expect((conflict as RevisionConflictError).currentRevision).toBe('2');

    const state = await migrationPool.query<{ revision: string; count: number }>(
      `select r.revision::text,
              (select count(*)::int from "${schema}".resume_versions v where v.resume_id = r.id) as count
         from "${schema}".resumes r where r.id = $1`,
      [current.resumeId],
    );
    expect(state.rows[0]).toEqual({ revision: '2', count: 2 });
  });

  it('returns the same not-found error to another account and leaves no idempotency row', async () => {
    const current = await fixture();
    const otherUserId = randomUUID();
    await migrationPool.query(
      `insert into "${schema}".users(id, status, display_name) values ($1, 'active', '其他账户')`,
      [otherUserId],
    );

    await expect(
      saveUseCase(otherUserId).execute(
        input(current.resumeId, namedDocument(current.document, '越权内容')),
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);

    const count = await migrationPool.query<{ count: number }>(
      `select count(*)::int as count from "${schema}".idempotency_requests where user_id = $1`,
      [otherUserId],
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  it('rolls back CAS and idempotency when version insertion fails, then accepts the same key', async () => {
    const current = await fixture();
    const command = input(current.resumeId, namedDocument(current.document, '回滚后重试'));
    await migrationPool.query(
      `create function "${schema}".reject_autosave_version() returns trigger language plpgsql as $$
         begin
           if new.reason = 'autosave' then raise exception 'injected version failure'; end if;
           return new;
         end $$;
       create trigger reject_autosave_version before insert on "${schema}".resume_versions
       for each row execute function "${schema}".reject_autosave_version()`,
    );

    try {
      await expect(saveUseCase(current.userId).execute(command)).rejects.toThrow(
        'injected version failure',
      );
    } finally {
      await migrationPool.query(
        `drop trigger reject_autosave_version on "${schema}".resume_versions`,
      );
      await migrationPool.query(`drop function "${schema}".reject_autosave_version()`);
    }

    const rolledBack = await migrationPool.query<{
      revision: string;
      version_count: number;
      idempotency_count: number;
    }>(
      `select r.revision::text,
              (select count(*)::int from "${schema}".resume_versions v where v.resume_id = r.id) as version_count,
              (select count(*)::int from "${schema}".idempotency_requests i where i.key = $2) as idempotency_count
         from "${schema}".resumes r where r.id = $1`,
      [current.resumeId, command.idempotencyKey],
    );
    expect(rolledBack.rows[0]).toEqual({
      revision: '1',
      version_count: 1,
      idempotency_count: 0,
    });

    await expect(saveUseCase(current.userId).execute(command)).resolves.toMatchObject({
      receipt: { revision: '2' },
      replayed: false,
    });
  });
});
