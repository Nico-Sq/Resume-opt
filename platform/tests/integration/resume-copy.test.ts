import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CopyResume,
  GetResumeForEditor,
  IdempotencyKeyReusedError,
  ResourceNotFoundError,
  RevisionConflictError,
  SaveResumeDocument,
  type CopyResumeInput,
} from '@resume/application';
import { parseDatabaseToolConfig, parseServerRuntimeConfig } from '@resume/config/server';
import type { ResumeDocumentV1 } from '@resume/domain/resume';
import { FixedIdentityProvider } from '@resume/infrastructure/fixed-identity';
import { runMigrations } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import { seedFixedResume } from '@resume/infrastructure/resume-seed';
import { PostgresUserTransactionManager } from '@resume/infrastructure/resume-transactions';
import { sha256CanonicalJson } from '../../packages/infrastructure/src/resume/canonical-json';

const config = parseServerRuntimeConfig({ ...process.env, APP_ENV: 'test' });
const migration = parseDatabaseToolConfig({ ...process.env, APP_ENV: 'test' }, 'migration');
const schema = `copy_${randomUUID().replaceAll('-', '')}`;
const migrationsDirectory = resolve(import.meta.dirname, '../../database/migrations');
const migrationPool = createPostgresPool({
  connectionString: migration.connectionString,
  max: 1,
  applicationName: 'resume-opt-copy-migration-test',
});
const applicationPool = createPostgresPool({
  connectionString: config.PG_DEV_URL,
  max: 6,
  applicationName: 'resume-opt-copy-app-test',
});
let schemaCreated = false;

beforeAll(async () => {
  await migrationPool.query(`create schema "${schema}" authorization resume_opt_migrator`);
  schemaCreated = true;
  await migrationPool.query(`grant usage on schema "${schema}" to resume_opt_app`);
  await runMigrations(migrationPool, migrationsDirectory, schema);
});

afterAll(async () => {
  if (schemaCreated && /^copy_[a-f0-9]{32}$/u.test(schema)) {
    await migrationPool.query(`drop schema "${schema}" cascade`);
  }
  await Promise.all([migrationPool.end(), applicationPool.end()]);
});

function transactionManager() {
  return new PostgresUserTransactionManager(applicationPool, schema);
}

function copyUseCase(userId: string) {
  return new CopyResume(
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
  return { userId, resumeId, document: stored.document };
}

function copyInput(
  sourceResumeId: string,
  overrides: Partial<CopyResumeInput> = {},
): CopyResumeInput {
  return {
    sourceResumeId,
    sourceRevision: '1',
    idempotencyKey: randomUUID(),
    title: '岗位定制副本',
    traceId: randomUUID(),
    ...overrides,
  };
}

function collectIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectIds);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === 'id' && typeof child === 'string' ? [child] : collectIds(child),
  );
}

function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'id')
      .map(([key, child]) => [key, withoutIds(child)]),
  );
}

function semanticProjection(document: ResumeDocumentV1): unknown {
  const { sectionsById, moduleOrder, typography, ...rest } = document;
  return {
    ...rest,
    sections: moduleOrder.map((id) => withoutIds(sectionsById[id])),
    typography: {
      ...typography,
      moduleOverrides: moduleOrder.map((id) => typography.moduleOverrides[id] ?? null),
    },
  };
}

function copyReadyDocument(document: ResumeDocumentV1): ResumeDocumentV1 {
  const next = structuredClone(document);
  const basic = Object.values(next.sectionsById).find((section) => section.kind === 'basic');
  const basicEntry = basic?.entries[0];
  const project = Object.values(next.sectionsById).find((section) => section.kind === 'project');
  if (!basicEntry || !project) throw new Error('测试文档缺少基本信息或项目模块');
  basicEntry.avatarAssetId = randomUUID();
  next.typography.moduleOverrides[project.id] = { fontSizePt: 12, fontWeight: 700 };
  return next;
}

describe('PostgreSQL resume copy transaction', () => {
  it('creates one independent initial snapshot with equivalent content and fresh IDs', async () => {
    const current = await fixture();
    const sourceDocument = copyReadyDocument(current.document);
    await saveUseCase(current.userId).execute({
      resumeId: current.resumeId,
      document: sourceDocument,
      baseRevision: '1',
      clientSeq: 1,
      idempotencyKey: randomUUID(),
      traceId: randomUUID(),
    });
    const command = copyInput(current.resumeId, { sourceRevision: '2' });
    const result = await copyUseCase(current.userId).execute(command);
    const target = result.resume.document;
    const expected = structuredClone(sourceDocument);
    const basic = Object.values(expected.sectionsById).find((section) => section.kind === 'basic');
    for (const entry of basic?.entries ?? []) entry.avatarAssetId = null;
    const sourceIds = new Set(collectIds(sourceDocument));

    expect(result).toMatchObject({
      resume: { title: command.title, revision: '1' },
      replayed: false,
    });
    expect(collectIds(target).every((id) => !sourceIds.has(id))).toBe(true);
    expect(sha256CanonicalJson(semanticProjection(target))).toBe(
      sha256CanonicalJson(semanticProjection(expected)),
    );
    expect(new Set(Object.keys(target.sectionsById))).toEqual(new Set(target.moduleOrder));
    expect(Object.keys(target.typography.moduleOverrides)).toEqual([
      Object.values(target.sectionsById).find((section) => section.kind === 'project')?.id,
    ]);

    const persisted = await migrationPool.query<{
      source_versions: number;
      target_versions: number;
      reason: string;
      source_version_id: string | null;
      snapshot: ResumeDocumentV1;
      content_hash: string;
      audit_count: number;
    }>(
      `select
         (select count(*)::int from "${schema}".resume_versions where resume_id = $1) as source_versions,
         (select count(*)::int from "${schema}".resume_versions where resume_id = $2) as target_versions,
         v.reason, v.source_version_id, v.snapshot, v.content_hash,
         (select count(*)::int from "${schema}".audit_events where resource_id = $2) as audit_count
       from "${schema}".resume_versions v where v.resume_id = $2`,
      [current.resumeId, result.resume.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      source_versions: 2,
      target_versions: 1,
      reason: 'initial',
      source_version_id: null,
      snapshot: target,
      content_hash: sha256CanonicalJson(target),
      audit_count: 1,
    });
  });

  it('rejects a stale source revision without creating a target or idempotency row', async () => {
    const current = await fixture();
    await saveUseCase(current.userId).execute({
      resumeId: current.resumeId,
      document: current.document,
      baseRevision: '1',
      clientSeq: 1,
      idempotencyKey: randomUUID(),
      traceId: randomUUID(),
    });
    const command = copyInput(current.resumeId);

    const error = await copyUseCase(current.userId)
      .execute(command)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RevisionConflictError);
    expect((error as RevisionConflictError).currentRevision).toBe('2');
    const counts = await migrationPool.query<{ resumes: number; requests: number }>(
      `select
         (select count(*)::int from "${schema}".resumes where user_id = $1) as resumes,
         (select count(*)::int from "${schema}".idempotency_requests
           where key = $2 and operation = 'resume.copy') as requests`,
      [current.userId, command.idempotencyKey],
    );
    expect(counts.rows[0]).toEqual({ resumes: 1, requests: 0 });
  });

  it('replays the same target after a lost acknowledgement even if the source later changes', async () => {
    const current = await fixture();
    const command = copyInput(current.resumeId);
    const first = await copyUseCase(current.userId).execute(command);
    await saveUseCase(current.userId).execute({
      resumeId: current.resumeId,
      document: current.document,
      baseRevision: '1',
      clientSeq: 1,
      idempotencyKey: randomUUID(),
      traceId: randomUUID(),
    });
    const replay = await copyUseCase(current.userId).execute({
      ...command,
      traceId: randomUUID(),
    });

    expect(replay).toEqual({ ...first, replayed: true });
    await expect(
      copyUseCase(current.userId).execute({
        ...command,
        title: '偷换后的副本名称',
        traceId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    const counts = await migrationPool.query<{ resumes: number; target_versions: number }>(
      `select
         (select count(*)::int from "${schema}".resumes where user_id = $1) as resumes,
         (select count(*)::int from "${schema}".resume_versions where resume_id = $2) as target_versions`,
      [current.userId, first.resume.id],
    );
    expect(counts.rows[0]).toEqual({ resumes: 2, target_versions: 1 });
  });

  it('does not reveal or copy another account resume', async () => {
    const current = await fixture();
    const otherUserId = randomUUID();
    await migrationPool.query(
      `insert into "${schema}".users(id, status, display_name) values ($1, 'active', '其他账户')`,
      [otherUserId],
    );

    await expect(
      copyUseCase(otherUserId).execute(copyInput(current.resumeId)),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    const count = await migrationPool.query<{ count: number }>(
      `select count(*)::int as count from "${schema}".resumes where user_id = $1`,
      [otherUserId],
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  it('rolls back target, receipt and audit when initial version insertion fails', async () => {
    const current = await fixture();
    const command = copyInput(current.resumeId);
    await migrationPool.query(
      `create function "${schema}".reject_copy_version() returns trigger language plpgsql as $$
         begin
           if new.resume_id <> '${current.resumeId}'::uuid then raise exception 'injected copy failure'; end if;
           return new;
         end $$;
       create trigger reject_copy_version before insert on "${schema}".resume_versions
       for each row execute function "${schema}".reject_copy_version()`,
    );
    try {
      await expect(copyUseCase(current.userId).execute(command)).rejects.toThrow(
        'injected copy failure',
      );
    } finally {
      await migrationPool.query(`drop trigger reject_copy_version on "${schema}".resume_versions`);
      await migrationPool.query(`drop function "${schema}".reject_copy_version()`);
    }

    const rolledBack = await migrationPool.query<{
      resumes: number;
      requests: number;
      audits: number;
    }>(
      `select
         (select count(*)::int from "${schema}".resumes where user_id = $1) as resumes,
         (select count(*)::int from "${schema}".idempotency_requests where key = $2) as requests,
         (select count(*)::int from "${schema}".audit_events where trace_id = $3) as audits`,
      [current.userId, command.idempotencyKey, command.traceId],
    );
    expect(rolledBack.rows[0]).toEqual({ resumes: 1, requests: 0, audits: 0 });
    await expect(copyUseCase(current.userId).execute(command)).resolves.toMatchObject({
      resume: { title: command.title, revision: '1' },
      replayed: false,
    });
  });
});
