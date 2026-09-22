import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseToolConfig } from '@resume/config/server';
import { runMigrations } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import { PostgresExpiredResumeCleaner } from '@resume/infrastructure/privacy-cleanup';
import { seedFixedResume } from '@resume/infrastructure/resume-seed';

const testDatabase = parseDatabaseToolConfig({ ...process.env, APP_ENV: 'test' }, 'test');
const privacyDatabase = parseDatabaseToolConfig({ ...process.env, APP_ENV: 'test' }, 'privacy');
const schema = `privacy_${randomUUID().replaceAll('-', '')}`;
const migrationsDirectory = resolve(import.meta.dirname, '../../database/migrations');
const migrationPool = createPostgresPool({
  connectionString: testDatabase.connectionString,
  max: 4,
  applicationName: 'resume-opt-privacy-migration-test',
});
const privacyPool = createPostgresPool({
  connectionString: privacyDatabase.connectionString,
  max: 2,
  applicationName: 'resume-opt-privacy-cleanup-test',
});
const cleaner = new PostgresExpiredResumeCleaner(privacyPool, schema);

function qualified(table: string) {
  if (!/^[a-z_]+$/u.test(table)) throw new Error('测试表名不安全');
  return `"${schema}"."${table}"`;
}

beforeAll(async () => {
  await migrationPool.query(`create schema "${schema}" authorization resume_opt_test`);
  await runMigrations(migrationPool, migrationsDirectory, schema);
});

afterAll(async () => {
  if (/^privacy_[a-f0-9]{32}$/u.test(schema)) {
    await migrationPool.query(`drop schema "${schema}" cascade`);
  }
  await Promise.all([migrationPool.end(), privacyPool.end()]);
});

afterEach(async () => {
  await migrationPool.query(
    `truncate table
      ${qualified('deletion_events')}, ${qualified('audit_events')},
      ${qualified('idempotency_requests')}, ${qualified('resume_versions')},
      ${qualified('resumes')}, ${qualified('users')}, ${qualified('templates')}
     cascade`,
  );
});

async function expiredFixture(options: { exported?: boolean; overdue?: boolean } = {}) {
  const userId = randomUUID();
  const resumeId = randomUUID();
  const firstVersionId = randomUUID();
  const secondVersionId = randomUUID();
  await seedFixedResume(migrationPool, {
    userId,
    resumeId,
    versionId: firstVersionId,
    schema,
  });
  await migrationPool.query(
    `update ${qualified('resumes')}
        set revision = 2,
            deleted_at = clock_timestamp() - interval '8 days',
            restore_until = clock_timestamp() ${options.overdue === false ? '+' : '-'} interval '1 second'
      where id = $1`,
    [resumeId],
  );
  await migrationPool.query(
    `insert into ${qualified('resume_versions')}
      (id, resume_id, user_id, revision, title_snapshot, schema_version,
       template_id, template_version, renderer_version, snapshot, content_hash,
       reason, source_version_id)
     select $1, id, user_id, 2, title, schema_version, template_id, template_version,
            '1.0.0', document, 'delete-fixture', 'delete', $2
       from ${qualified('resumes')} where id = $3`,
    [secondVersionId, firstVersionId, resumeId],
  );
  await migrationPool.query(
    `insert into ${qualified('deletion_events')}
      (id, resume_id, user_id, event_type, revision, occurred_at, restore_until,
       trace_id, manifest_export_id, manifest_exported_at)
     select $1, id, user_id, 'soft_delete', 2, deleted_at, restore_until, $2,
            case when $3::boolean then $4::uuid end,
            case when $3::boolean then clock_timestamp() end
       from ${qualified('resumes')} where id = $5`,
    [randomUUID(), randomUUID(), options.exported !== false, randomUUID(), resumeId],
  );
  await migrationPool.query(
    `insert into ${qualified('idempotency_requests')}
      (user_id, operation, key, request_hash, status, response_body, expires_at,
       resource_type, resource_id)
     values ($1, 'resume.delete', $2, 'fixture', 'completed', $3::jsonb,
             clock_timestamp() + interval '7 days', 'resume', $4)`,
    [userId, randomUUID(), JSON.stringify({ id: resumeId, revision: '2' }), resumeId],
  );
  await migrationPool.query(
    `insert into ${qualified('audit_events')}
      (id, actor_user_id, action, resource_type, resource_id, trace_id, result_code, metadata)
     values ($1, $2, 'resume.delete', 'resume', $3, $4, 'DELETED', '{}'::jsonb)`,
    [randomUUID(), userId, resumeId, randomUUID()],
  );
  return { userId, resumeId };
}

async function counts(resumeId: string) {
  const result = await migrationPool.query<{
    resumes: number;
    versions: number;
    receipts: number;
  }>(
    `select
       (select count(*)::int from ${qualified('resumes')} where id = $1) as resumes,
       (select count(*)::int from ${qualified('resume_versions')} where resume_id = $1) as versions,
       (select count(*)::int from ${qualified('idempotency_requests')}
         where resource_type = 'resume' and resource_id = $1) as receipts`,
    [resumeId],
  );
  return result.rows[0];
}

describe('bounded expired resume cleanup', () => {
  it('grants only the cleanup function and no direct body-table access to the privacy role', async () => {
    const privileges = await migrationPool.query<{
      privacy_execute: boolean;
      app_execute: boolean;
      privacy_body_read: boolean;
    }>(
      `select
         has_function_privilege('resume_opt_privacy', $1, 'execute') as privacy_execute,
         has_function_privilege('resume_opt_app', $1, 'execute') as app_execute,
         has_table_privilege('resume_opt_privacy', $2, 'select') as privacy_body_read`,
      [`${schema}.purge_expired_resumes(integer,boolean,uuid)`, `${schema}.resumes`],
    );
    expect(privileges.rows[0]).toEqual({
      privacy_execute: true,
      app_execute: false,
      privacy_body_read: false,
    });
  });

  it('keeps dry-run read-only and blocks unexported or not-yet-expired tombstones', async () => {
    const eligible = await expiredFixture();
    const blocked = await expiredFixture({ exported: false });
    const early = await expiredFixture({ overdue: false });
    const report = await cleaner.run({ limit: 10, dryRun: true, runId: randomUUID() });

    expect(report).toMatchObject({ selectedCount: 1, purgedCount: 0 });
    expect(report.blockedUnexportedCount).toBeGreaterThanOrEqual(1);
    await expect(counts(eligible.resumeId)).resolves.toEqual({
      resumes: 1,
      versions: 2,
      receipts: 1,
    });
    await expect(counts(blocked.resumeId)).resolves.toMatchObject({ resumes: 1 });
    await expect(counts(early.resumeId)).resolves.toMatchObject({ resumes: 1 });
  });

  it('removes the body, self-referencing versions and explicit receipts but retains minimal events', async () => {
    const fixture = await expiredFixture();
    const report = await cleaner.run({ limit: 1, dryRun: false, runId: randomUUID() });

    expect(report).toMatchObject({
      selectedCount: 1,
      purgedCount: 1,
      versionsDeleted: 2,
      receiptsDeleted: 1,
      auditsDeleted: 1,
    });
    await expect(counts(fixture.resumeId)).resolves.toEqual({
      resumes: 0,
      versions: 0,
      receipts: 0,
    });
    const retained = await migrationPool.query<{ event_type: string }>(
      `select event_type from ${qualified('deletion_events')}
        where resume_id = $1 order by revision`,
      [fixture.resumeId],
    );
    expect(retained.rows).toEqual([{ event_type: 'soft_delete' }, { event_type: 'hard_delete' }]);
    expect(JSON.stringify(report)).not.toContain('张三');
  });

  it('lets a locked restore win without purging the resumed resource', async () => {
    const fixture = await expiredFixture();
    const restoreClient = await migrationPool.connect();
    try {
      await restoreClient.query('begin');
      await restoreClient.query(`set local search_path to "${schema}", public`);
      await restoreClient.query('select id from resumes where id = $1 for update', [
        fixture.resumeId,
      ]);
      const cleanup = await cleaner.run({ limit: 100, dryRun: false, runId: randomUUID() });
      expect(cleanup.purgedCount).toBe(0);
      await restoreClient.query(
        `update resumes set deleted_at = null, restore_until = null, revision = 3 where id = $1`,
        [fixture.resumeId],
      );
      await restoreClient.query(
        `insert into deletion_events
          (id, resume_id, user_id, event_type, revision, occurred_at, trace_id)
         values ($1, $2, $3, 'restore', 3, clock_timestamp(), $4)`,
        [randomUUID(), fixture.resumeId, fixture.userId, randomUUID()],
      );
      await restoreClient.query('commit');
    } finally {
      restoreClient.release();
    }
    expect(
      (await cleaner.run({ limit: 100, dryRun: false, runId: randomUUID() })).purgedCount,
    ).toBe(0);
    await expect(counts(fixture.resumeId)).resolves.toMatchObject({ resumes: 1 });
  });

  it('rolls an interrupted purge back and safely completes on the next run', async () => {
    const fixture = await expiredFixture();
    await migrationPool.query(
      `create function "${schema}".reject_hard_delete() returns trigger language plpgsql as $$
         begin
           if new.event_type = 'hard_delete' then raise exception 'injected purge failure'; end if;
           return new;
         end $$;
       create trigger reject_hard_delete before insert on ${qualified('deletion_events')}
       for each row execute function "${schema}".reject_hard_delete()`,
    );
    try {
      await expect(cleaner.run({ limit: 100, dryRun: false, runId: randomUUID() })).rejects.toThrow(
        'injected purge failure',
      );
    } finally {
      await migrationPool.query(
        `drop trigger reject_hard_delete on ${qualified('deletion_events')}`,
      );
      await migrationPool.query(`drop function "${schema}".reject_hard_delete()`);
    }
    await expect(counts(fixture.resumeId)).resolves.toEqual({
      resumes: 1,
      versions: 2,
      receipts: 1,
    });
    expect(
      (await cleaner.run({ limit: 100, dryRun: false, runId: randomUUID() })).purgedCount,
    ).toBe(1);
    expect(
      (await cleaner.run({ limit: 100, dryRun: false, runId: randomUUID() })).purgedCount,
    ).toBe(0);
  });
});
