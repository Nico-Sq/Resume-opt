import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GetResumeForEditor,
  RenameResume,
  ResourceNotFoundError,
  RevisionConflictError,
  SaveResumeDocument,
  type RenameResumeInput,
} from '@resume/application';
import { parseDatabaseToolConfig, parseServerRuntimeConfig } from '@resume/config/server';
import type { ResumeDocumentV1 } from '@resume/domain/resume';
import { FixedIdentityProvider } from '@resume/infrastructure/fixed-identity';
import { runMigrations } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import { seedFixedResume } from '@resume/infrastructure/resume-seed';
import { PostgresUserTransactionManager } from '@resume/infrastructure/resume-transactions';

const config = parseServerRuntimeConfig({ ...process.env, APP_ENV: 'test' });
const migration = parseDatabaseToolConfig({ ...process.env, APP_ENV: 'test' }, 'migration');
const schema = `rename_${randomUUID().replaceAll('-', '')}`;
const migrationsDirectory = resolve(import.meta.dirname, '../../database/migrations');
const migrationPool = createPostgresPool({
  connectionString: migration.connectionString,
  max: 1,
  applicationName: 'resume-opt-rename-migration-test',
});
const applicationPool = createPostgresPool({
  connectionString: config.PG_DEV_URL,
  max: 6,
  applicationName: 'resume-opt-rename-app-test',
});
let schemaCreated = false;

beforeAll(async () => {
  await migrationPool.query(`create schema "${schema}" authorization resume_opt_migrator`);
  schemaCreated = true;
  await migrationPool.query(`grant usage on schema "${schema}" to resume_opt_app`);
  await runMigrations(migrationPool, migrationsDirectory, schema);
});

afterAll(async () => {
  if (schemaCreated && /^rename_[a-f0-9]{32}$/u.test(schema)) {
    await migrationPool.query(`drop schema "${schema}" cascade`);
  }
  await Promise.all([migrationPool.end(), applicationPool.end()]);
});

function transactionManager() {
  return new PostgresUserTransactionManager(applicationPool, schema);
}

function renameUseCase(userId: string) {
  return new RenameResume(
    new FixedIdentityProvider({ appEnvironment: 'test', userId }),
    transactionManager(),
  );
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
  return { userId, resumeId, title: stored.title, document: stored.document };
}

function renameInput(
  resumeId: string,
  overrides: Partial<RenameResumeInput> = {},
): RenameResumeInput {
  return {
    resumeId,
    title: '后端工程师简历🙂',
    baseRevision: '1',
    idempotencyKey: randomUUID(),
    traceId: randomUUID(),
    ...overrides,
  };
}

function namedDocument(document: ResumeDocumentV1, name: string): ResumeDocumentV1 {
  const next = structuredClone(document);
  const basic = Object.values(next.sectionsById).find((section) => section.kind === 'basic');
  const entry = basic?.entries[0];
  if (!entry) throw new Error('测试文档缺少基本信息');
  entry.name = name;
  return next;
}

describe('PostgreSQL resume rename transaction', () => {
  it('atomically advances revision with an unchanged body and a matching title snapshot', async () => {
    const current = await fixture();
    const command = renameInput(current.resumeId);
    const result = await renameUseCase(current.userId).execute(command);

    expect(result).toMatchObject({
      resume: {
        id: current.resumeId,
        title: command.title,
        revision: '2',
        locale: 'zh-CN',
      },
      replayed: false,
    });
    const persisted = await migrationPool.query<{
      title: string;
      document: ResumeDocumentV1;
      revision: string;
      version_count: number;
      audit_count: number;
    }>(
      `select r.title, r.document, r.revision::text,
              (select count(*)::int from "${schema}".resume_versions v where v.resume_id = r.id) as version_count,
              (select count(*)::int from "${schema}".audit_events a where a.resource_id = r.id) as audit_count
         from "${schema}".resumes r where r.id = $1`,
      [current.resumeId],
    );
    expect(persisted.rows[0]).toMatchObject({
      title: command.title,
      document: current.document,
      revision: '2',
      version_count: 2,
      audit_count: 1,
    });
    const versions = await migrationPool.query<{
      revision: string;
      title_snapshot: string;
      snapshot: ResumeDocumentV1;
      content_hash: string;
      reason: string;
    }>(
      `select revision::text, title_snapshot, snapshot, content_hash, reason
         from "${schema}".resume_versions where resume_id = $1 order by revision`,
      [current.resumeId],
    );
    expect(versions.rows[1]).toMatchObject({
      revision: '2',
      title_snapshot: command.title,
      snapshot: current.document,
      content_hash: versions.rows[0]?.content_hash,
      reason: 'edit',
    });
  });

  it('replays a lost acknowledgement with the same key and creates only one version', async () => {
    const current = await fixture();
    const command = renameInput(current.resumeId);
    const first = await renameUseCase(current.userId).execute(command);
    const replay = await renameUseCase(current.userId).execute({
      ...command,
      traceId: randomUUID(),
    });

    expect(replay).toEqual({ ...first, replayed: true });
    const count = await migrationPool.query<{ versions: number; requests: number }>(
      `select
         (select count(*)::int from "${schema}".resume_versions where resume_id = $1) as versions,
         (select count(*)::int from "${schema}".idempotency_requests
           where key = $2 and operation = 'resume.rename') as requests`,
      [current.resumeId, command.idempotencyKey],
    );
    expect(count.rows[0]).toEqual({ versions: 2, requests: 1 });
  });

  it('allows only one shared-revision writer across body save and rename', async () => {
    const current = await fixture();
    const renamedTitle = '并发重命名';
    const savedDocument = namedDocument(current.document, '并发正文修改');
    const results = await Promise.allSettled([
      renameUseCase(current.userId).execute(renameInput(current.resumeId, { title: renamedTitle })),
      saveUseCase(current.userId).execute({
        resumeId: current.resumeId,
        document: savedDocument,
        baseRevision: '1',
        clientSeq: 1,
        idempotencyKey: randomUUID(),
        traceId: randomUUID(),
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure?.reason).toBeInstanceOf(RevisionConflictError);
    const state = await migrationPool.query<{
      title: string;
      document: ResumeDocumentV1;
      revision: string;
      versions: number;
    }>(
      `select r.title, r.document, r.revision::text,
              (select count(*)::int from "${schema}".resume_versions v where v.resume_id = r.id) as versions
         from "${schema}".resumes r where r.id = $1`,
      [current.resumeId],
    );
    expect(state.rows[0]?.revision).toBe('2');
    expect(state.rows[0]?.versions).toBe(2);
    if (results[0].status === 'fulfilled') {
      expect(state.rows[0]).toMatchObject({ title: renamedTitle, document: current.document });
    } else {
      expect(state.rows[0]).toMatchObject({ title: current.title, document: savedDocument });
    }
  });

  it('does not reveal or mutate another account resume', async () => {
    const current = await fixture();
    const otherUserId = randomUUID();
    await migrationPool.query(
      `insert into "${schema}".users(id, status, display_name) values ($1, 'active', '其他账户')`,
      [otherUserId],
    );

    await expect(
      renameUseCase(otherUserId).execute(renameInput(current.resumeId, { title: '越权重命名' })),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(readUseCase(current.userId).execute(current.resumeId)).resolves.toMatchObject({
      title: current.title,
      revision: '1',
      document: current.document,
    });
  });

  it('rolls back title, revision and idempotency when its version insert fails', async () => {
    const current = await fixture();
    const command = renameInput(current.resumeId, { title: '回滚后重试' });
    await migrationPool.query(
      `create function "${schema}".reject_rename_version() returns trigger language plpgsql as $$
         begin
           if new.reason = 'edit' then raise exception 'injected rename failure'; end if;
           return new;
         end $$;
       create trigger reject_rename_version before insert on "${schema}".resume_versions
       for each row execute function "${schema}".reject_rename_version()`,
    );
    try {
      await expect(renameUseCase(current.userId).execute(command)).rejects.toThrow(
        'injected rename failure',
      );
    } finally {
      await migrationPool.query(
        `drop trigger reject_rename_version on "${schema}".resume_versions`,
      );
      await migrationPool.query(`drop function "${schema}".reject_rename_version()`);
    }

    const rolledBack = await migrationPool.query<{
      title: string;
      revision: string;
      versions: number;
      requests: number;
    }>(
      `select r.title, r.revision::text,
              (select count(*)::int from "${schema}".resume_versions v where v.resume_id = r.id) as versions,
              (select count(*)::int from "${schema}".idempotency_requests i where i.key = $2) as requests
         from "${schema}".resumes r where r.id = $1`,
      [current.resumeId, command.idempotencyKey],
    );
    expect(rolledBack.rows[0]).toEqual({
      title: current.title,
      revision: '1',
      versions: 1,
      requests: 0,
    });
    await expect(renameUseCase(current.userId).execute(command)).resolves.toMatchObject({
      resume: { title: command.title, revision: '2' },
      replayed: false,
    });
  });
});
