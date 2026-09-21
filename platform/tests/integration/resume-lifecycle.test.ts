import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DeleteResume,
  GetResumeForEditor,
  ListDeletedResumes,
  ResourceNotFoundError,
  RestoreWindowExpiredError,
  RevisionConflictError,
  SaveResumeDocument,
  UndeleteResume,
  type DeleteResumeInput,
} from '@resume/application';
import { parseDatabaseToolConfig, parseServerRuntimeConfig } from '@resume/config/server';
import { FixedIdentityProvider } from '@resume/infrastructure/fixed-identity';
import { runMigrations } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import { seedFixedResume } from '@resume/infrastructure/resume-seed';
import { PostgresUserTransactionManager } from '@resume/infrastructure/resume-transactions';

const config = parseServerRuntimeConfig({ ...process.env, APP_ENV: 'test' });
const migration = parseDatabaseToolConfig({ ...process.env, APP_ENV: 'test' }, 'migration');
const schema = `lifecycle_${randomUUID().replaceAll('-', '')}`;
const migrationsDirectory = resolve(import.meta.dirname, '../../database/migrations');
const migrationPool = createPostgresPool({
  connectionString: migration.connectionString,
  max: 1,
  applicationName: 'resume-opt-lifecycle-migration-test',
});
const applicationPool = createPostgresPool({
  connectionString: config.PG_DEV_URL,
  max: 6,
  applicationName: 'resume-opt-lifecycle-app-test',
});
let schemaCreated = false;

beforeAll(async () => {
  await migrationPool.query(`create schema "${schema}" authorization resume_opt_migrator`);
  schemaCreated = true;
  await migrationPool.query(`grant usage on schema "${schema}" to resume_opt_app`);
  await runMigrations(migrationPool, migrationsDirectory, schema);
});

afterAll(async () => {
  if (schemaCreated && /^lifecycle_[a-f0-9]{32}$/u.test(schema)) {
    await migrationPool.query(`drop schema "${schema}" cascade`);
  }
  await Promise.all([migrationPool.end(), applicationPool.end()]);
});

function lifecycleCases(userId: string) {
  const identity = new FixedIdentityProvider({ appEnvironment: 'test', userId });
  const transactions = new PostgresUserTransactionManager(applicationPool, schema);
  return {
    deleteResume: new DeleteResume(identity, transactions),
    listDeleted: new ListDeletedResumes(identity, transactions),
    read: new GetResumeForEditor(identity, transactions),
    restore: new UndeleteResume(identity, transactions),
    save: new SaveResumeDocument(identity, transactions),
  };
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
  const current = await lifecycleCases(userId).read.execute(resumeId);
  return { userId, resumeId, current };
}

function deleteInput(resumeId: string, overrides: Partial<DeleteResumeInput> = {}) {
  return {
    resumeId,
    confirm: true as const,
    baseRevision: '1',
    idempotencyKey: randomUUID(),
    traceId: randomUUID(),
    ...overrides,
  };
}

describe('PostgreSQL resume lifecycle', () => {
  it('soft deletes for seven days and atomically records a version, event and audit', async () => {
    const current = await fixture();
    const cases = lifecycleCases(current.userId);
    const command = deleteInput(current.resumeId);
    const result = await cases.deleteResume.execute(command);

    expect(result).toMatchObject({ id: current.resumeId, revision: '2', replayed: false });
    expect(
      (new Date(result.restoreUntil).getTime() - new Date(result.deletedAt).getTime()) /
        (24 * 60 * 60 * 1000),
    ).toBe(7);
    await expect(cases.read.execute(current.resumeId)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
    await expect(cases.listDeleted.execute()).resolves.toMatchObject({
      items: [{ id: current.resumeId, revision: '2', restoreUntil: result.restoreUntil }],
      nextCursor: null,
    });

    const evidence = await migrationPool.query<{
      deleted_at: Date;
      restore_until: Date;
      revision: string;
      reason: string;
      prior_hash: string;
      lifecycle_hash: string;
      events: number;
      audits: number;
    }>(
      `select r.deleted_at, r.restore_until, r.revision::text,
              v.reason, p.content_hash as prior_hash, v.content_hash as lifecycle_hash,
              (select count(*)::int from "${schema}".deletion_events e where e.resume_id = r.id) as events,
              (select count(*)::int from "${schema}".audit_events a where a.resource_id = r.id) as audits
         from "${schema}".resumes r
         join "${schema}".resume_versions v on v.resume_id = r.id and v.revision = 2
         join "${schema}".resume_versions p on p.resume_id = r.id and p.revision = 1
        where r.id = $1`,
      [current.resumeId],
    );
    expect(evidence.rows[0]).toMatchObject({
      revision: '2',
      reason: 'delete',
      events: 1,
      audits: 1,
    });
    expect(evidence.rows[0]?.lifecycle_hash).toBe(evidence.rows[0]?.prior_hash);
  });

  it('restores at deadline minus one second, advances revision and replays exact receipts', async () => {
    const current = await fixture();
    const cases = lifecycleCases(current.userId);
    const deleteCommand = deleteInput(current.resumeId);
    const deleted = await cases.deleteResume.execute(deleteCommand);
    await expect(
      cases.deleteResume.execute({ ...deleteCommand, traceId: randomUUID() }),
    ).resolves.toEqual({ ...deleted, replayed: true });
    await migrationPool.query(
      `update "${schema}".resumes set restore_until = clock_timestamp() + interval '1 second'
        where id = $1`,
      [current.resumeId],
    );
    const restoreCommand = {
      resumeId: current.resumeId,
      baseRevision: '2',
      idempotencyKey: randomUUID(),
      traceId: randomUUID(),
    };
    const restored = await cases.restore.execute(restoreCommand);

    expect(restored).toMatchObject({ resume: { id: current.resumeId, revision: '3' } });
    await expect(
      cases.restore.execute({ ...restoreCommand, traceId: randomUUID() }),
    ).resolves.toEqual({ ...restored, replayed: true });
    await expect(cases.read.execute(current.resumeId)).resolves.toMatchObject({ revision: '3' });
    await expect(cases.listDeleted.execute()).resolves.toEqual({ items: [], nextCursor: null });
    const evidence = await migrationPool.query<{ reasons: string[]; events: string[] }>(
      `select
         array(select reason from "${schema}".resume_versions where resume_id = $1 order by revision) as reasons,
         array(select event_type from "${schema}".deletion_events where resume_id = $1 order by revision) as events`,
      [current.resumeId],
    );
    expect(evidence.rows[0]).toEqual({
      reasons: ['initial', 'delete', 'restore'],
      events: ['soft_delete', 'restore'],
    });
  });

  it('rejects restore at deadline plus one second and keeps the tombstone unchanged', async () => {
    const current = await fixture();
    const cases = lifecycleCases(current.userId);
    await cases.deleteResume.execute(deleteInput(current.resumeId));
    await migrationPool.query(
      `update "${schema}".resumes
          set deleted_at = clock_timestamp() - interval '8 days',
              restore_until = clock_timestamp() - interval '1 second'
        where id = $1`,
      [current.resumeId],
    );
    await expect(
      cases.restore.execute({
        resumeId: current.resumeId,
        baseRevision: '2',
        idempotencyKey: randomUUID(),
        traceId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(RestoreWindowExpiredError);
    const state = await migrationPool.query<{ revision: string; events: number }>(
      `select r.revision::text,
              (select count(*)::int from "${schema}".deletion_events e where e.resume_id = r.id) as events
         from "${schema}".resumes r where r.id = $1`,
      [current.resumeId],
    );
    expect(state.rows[0]).toEqual({ revision: '2', events: 1 });
  });

  it('allows only one shared-revision writer across save and delete', async () => {
    const current = await fixture();
    const cases = lifecycleCases(current.userId);
    const results = await Promise.allSettled([
      cases.deleteResume.execute(deleteInput(current.resumeId)),
      cases.save.execute({
        resumeId: current.resumeId,
        baseRevision: '1',
        clientSeq: 1,
        document: current.current.document,
        idempotencyKey: randomUUID(),
        traceId: randomUUID(),
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(
      failure?.reason instanceof RevisionConflictError ||
        failure?.reason instanceof ResourceNotFoundError,
    ).toBe(true);
  });

  it('does not let a concurrent save resurrect a tombstone while it is restored', async () => {
    const current = await fixture();
    const cases = lifecycleCases(current.userId);
    await cases.deleteResume.execute(deleteInput(current.resumeId));
    const results = await Promise.allSettled([
      cases.restore.execute({
        resumeId: current.resumeId,
        baseRevision: '2',
        idempotencyKey: randomUUID(),
        traceId: randomUUID(),
      }),
      cases.save.execute({
        resumeId: current.resumeId,
        baseRevision: '2',
        clientSeq: 2,
        document: current.current.document,
        idempotencyKey: randomUUID(),
        traceId: randomUUID(),
      }),
    ]);

    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    const failure: unknown = results[1].status === 'rejected' ? results[1].reason : undefined;
    expect(
      failure instanceof ResourceNotFoundError || failure instanceof RevisionConflictError,
    ).toBe(true);
    await expect(cases.read.execute(current.resumeId)).resolves.toMatchObject({ revision: '3' });
  });

  it('returns not found to another account for both delete and restore', async () => {
    const current = await fixture();
    const owner = lifecycleCases(current.userId);
    const deleted = await owner.deleteResume.execute(deleteInput(current.resumeId));
    const other = lifecycleCases(randomUUID());

    await expect(other.deleteResume.execute(deleteInput(current.resumeId))).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
    await expect(
      other.restore.execute({
        resumeId: current.resumeId,
        baseRevision: deleted.revision,
        idempotencyKey: randomUUID(),
        traceId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('rolls back the tombstone and idempotency claim when event insertion fails', async () => {
    const current = await fixture();
    const cases = lifecycleCases(current.userId);
    const command = deleteInput(current.resumeId);
    await migrationPool.query(
      `create function "${schema}".reject_delete_event() returns trigger language plpgsql as $$
         begin raise exception 'injected deletion event failure'; end $$;
       create trigger reject_delete_event before insert on "${schema}".deletion_events
       for each row execute function "${schema}".reject_delete_event()`,
    );
    try {
      await expect(cases.deleteResume.execute(command)).rejects.toThrow(
        'injected deletion event failure',
      );
    } finally {
      await migrationPool.query(`drop trigger reject_delete_event on "${schema}".deletion_events`);
      await migrationPool.query(`drop function "${schema}".reject_delete_event()`);
    }
    const state = await migrationPool.query<{
      deleted_at: Date | null;
      revision: string;
      versions: number;
      requests: number;
    }>(
      `select r.deleted_at, r.revision::text,
              (select count(*)::int from "${schema}".resume_versions v where v.resume_id = r.id) as versions,
              (select count(*)::int from "${schema}".idempotency_requests i where i.key = $2) as requests
         from "${schema}".resumes r where r.id = $1`,
      [current.resumeId, command.idempotencyKey],
    );
    expect(state.rows[0]).toEqual({ deleted_at: null, revision: '1', versions: 1, requests: 0 });
  });
});
