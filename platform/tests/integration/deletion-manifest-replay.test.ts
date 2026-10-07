import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseToolConfig } from '@resume/config/server';
import { runMigrations } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import {
  acknowledgeDeletionManifest,
  createDeletionManifest,
  readDeletionManifest,
  replayDeletionManifest,
} from '../../scripts/ops/deletion-manifest';

const testDatabase = parseDatabaseToolConfig({ ...process.env, APP_ENV: 'test' }, 'test');
const privacyDatabase = parseDatabaseToolConfig({ ...process.env, APP_ENV: 'test' }, 'privacy');
const runId = randomUUID().replaceAll('-', '');
const sourceSchema = `manifest_source_${runId}`;
const targetSchema = `manifest_target_${runId}`;
const migrationsDirectory = resolve(import.meta.dirname, '../../database/migrations');
const testPool = createPostgresPool({
  connectionString: testDatabase.connectionString,
  max: 4,
  applicationName: 'resume-opt-manifest-replay-test',
});
const privacyPool = createPostgresPool({
  connectionString: privacyDatabase.connectionString,
  max: 2,
  applicationName: 'resume-opt-manifest-export-test',
});

const users = {
  deleted: randomUUID(),
  restored: randomUUID(),
  hardDeleted: randomUUID(),
  accountDeleted: randomUUID(),
};
const resumes = {
  deleted: randomUUID(),
  restored: randomUUID(),
  hardDeleted: randomUUID(),
  accountDeleted: randomUUID(),
};

function qualified(schema: string, table: string): string {
  return `"${schema}"."${table}"`;
}

async function seedBackup(schema: string): Promise<void> {
  await testPool.query(
    `insert into ${qualified(schema, 'templates')}
       (template_id, version, renderer_version, manifest, asset_hash, status)
     values ('ats-basic', '1.0.0', '1.0.0', '{}'::jsonb, 'manifest-test', 'published')`,
  );
  for (const [name, userId] of Object.entries(users)) {
    await testPool.query(
      `insert into ${qualified(schema, 'auth_users')}
         (id, name, email, email_verified, created_at, updated_at)
       values ($1, $2, $3, true, now(), now())`,
      [userId, name, `${name}-${runId}@example.test`],
    );
    await testPool.query(
      `insert into ${qualified(schema, 'auth_sessions')}
         (id, expires_at, token, created_at, updated_at, user_id)
       values ($1, now() + interval '1 day', $2, now(), now(), $3)`,
      [randomUUID(), `session-${name}-${runId}`, userId],
    );
    await testPool.query(
      `insert into ${qualified(schema, 'auth_accounts')}
         (id, account_id, provider_id, user_id, password, created_at, updated_at)
       values ($1, $2, 'credential', $3, 'hashed-test-value', now(), now())`,
      [randomUUID(), `${name}-${runId}`, userId],
    );
    await testPool.query(
      `insert into ${qualified(schema, 'auth_verifications')}
         (id, identifier, value, expires_at, created_at, updated_at)
       values ($1, $2, $3, now() + interval '1 hour', now(), now())`,
      [randomUUID(), `verify-${name}-${runId}`, userId],
    );
    const resumeId = resumes[name as keyof typeof resumes];
    await testPool.query(
      `insert into ${qualified(schema, 'resumes')}
         (id, user_id, title, document, revision, schema_version, template_id, template_version)
       values ($1, $2, $3, '{}'::jsonb, 1, 1, 'ats-basic', '1.0.0')`,
      [resumeId, userId, name],
    );
    await testPool.query(
      `insert into ${qualified(schema, 'resume_versions')}
         (id, resume_id, user_id, revision, title_snapshot, schema_version, template_id,
          template_version, renderer_version, snapshot, content_hash, reason)
       values ($1, $2, $3, 1, $4, 1, 'ats-basic', '1.0.0', '1.0.0', '{}'::jsonb,
               $5, 'initial')`,
      [randomUUID(), resumeId, userId, name, `hash-${name}`],
    );
  }
}

async function addSourceEvents(): Promise<void> {
  const rows = [
    [
      randomUUID(),
      resumes.deleted,
      users.deleted,
      'soft_delete',
      2,
      '2026-10-08T00:01:00Z',
      '2026-10-15T00:01:00Z',
      randomUUID(),
    ],
    [
      randomUUID(),
      resumes.restored,
      users.restored,
      'soft_delete',
      2,
      '2026-10-08T00:02:00Z',
      '2026-10-15T00:02:00Z',
      randomUUID(),
    ],
    [
      randomUUID(),
      resumes.restored,
      users.restored,
      'restore',
      3,
      '2026-10-08T00:03:00Z',
      null,
      randomUUID(),
    ],
    [
      randomUUID(),
      resumes.hardDeleted,
      users.hardDeleted,
      'hard_delete',
      2,
      '2026-10-08T00:04:00Z',
      null,
      randomUUID(),
    ],
    [
      randomUUID(),
      null,
      users.accountDeleted,
      'account_delete',
      1,
      '2026-10-08T00:05:00Z',
      null,
      randomUUID(),
    ],
  ] as const;
  for (const row of rows) {
    await testPool.query(
      `insert into ${qualified(sourceSchema, 'deletion_events')}
         (id, resume_id, user_id, event_type, revision, occurred_at, restore_until,
          policy_version, trace_id)
       values ($1, $2, $3, $4, $5, $6, $7, 1, $8)`,
      [...row],
    );
  }
}

beforeAll(async () => {
  await testPool.query(`create schema "${sourceSchema}" authorization resume_opt_test`);
  await testPool.query(`create schema "${targetSchema}" authorization resume_opt_test`);
  await runMigrations(testPool, migrationsDirectory, sourceSchema);
  await runMigrations(testPool, migrationsDirectory, targetSchema);
  await seedBackup(sourceSchema);
  await seedBackup(targetSchema);
  await addSourceEvents();
});

afterAll(async () => {
  await testPool.query(`drop schema if exists "${sourceSchema}" cascade`);
  await testPool.query(`drop schema if exists "${targetSchema}" cascade`);
  await Promise.all([testPool.end(), privacyPool.end()]);
});

describe('independent deletion manifest replay', () => {
  it('replays delete, restore, hard-delete and account terminal events idempotently', async () => {
    const manifest = await readDeletionManifest(privacyPool, sourceSchema, {
      manifestId: randomUUID(),
      generatedAt: '2026-10-08T00:06:00.000Z',
    });
    expect(await acknowledgeDeletionManifest(privacyPool, sourceSchema, manifest)).toBe(5);
    const expected = {
      expectedThroughSequence: manifest.throughSequence,
      expectedPayloadSha256: manifest.payloadSha256,
    };

    const first = await replayDeletionManifest(testPool, targetSchema, manifest, expected);
    expect(first).toMatchObject({
      importedEventCount: 5,
      sessionsRevoked: 4,
      verificationTokensRevoked: 4,
      resumesSoftDeleted: 1,
      resumesRestored: 1,
      resumesHardDeleted: 1,
      accountsDeleted: 1,
    });
    const state = await testPool.query<{
      deleted_at: Date | null;
      restored_deleted_at: Date | null;
      deleted_revision: string;
      restored_revision: string;
      hard_deleted: number;
      account_deleted: number;
      sessions: number;
      verifications: number;
      events: number;
    }>(
      `select
         (select deleted_at from ${qualified(targetSchema, 'resumes')} where id = $1) deleted_at,
         (select deleted_at from ${qualified(targetSchema, 'resumes')} where id = $2) restored_deleted_at,
         (select revision::text from ${qualified(targetSchema, 'resumes')} where id = $1) deleted_revision,
         (select revision::text from ${qualified(targetSchema, 'resumes')} where id = $2) restored_revision,
         (select count(*)::int from ${qualified(targetSchema, 'resumes')} where id = $3) hard_deleted,
         (select count(*)::int from ${qualified(targetSchema, 'users')} where id = $4) account_deleted,
         (select count(*)::int from ${qualified(targetSchema, 'auth_sessions')}) sessions,
         (select count(*)::int from ${qualified(targetSchema, 'auth_verifications')}) verifications,
         (select count(*)::int from ${qualified(targetSchema, 'deletion_events')}) events`,
      [resumes.deleted, resumes.restored, resumes.hardDeleted, users.accountDeleted],
    );
    expect(state.rows[0]).toEqual({
      deleted_at: expect.any(Date) as Date,
      restored_deleted_at: null,
      deleted_revision: '2',
      restored_revision: '3',
      hard_deleted: 0,
      account_deleted: 0,
      sessions: 0,
      verifications: 0,
      events: 5,
    });

    await expect(
      replayDeletionManifest(testPool, targetSchema, manifest, expected),
    ).resolves.toMatchObject({
      importedEventCount: 5,
      sessionsRevoked: 0,
      verificationTokensRevoked: 0,
      accountsDeleted: 0,
    });
  });

  it('rolls back and stays isolated when a restore event references content outside the backup', async () => {
    const existingEvents = await testPool.query<{ count: number }>(
      `select count(*)::int as count from ${qualified(targetSchema, 'deletion_events')}`,
    );
    const manifest = createDeletionManifest(
      [
        {
          sequence: '999999',
          id: randomUUID(),
          resourceType: 'resume',
          resourceId: randomUUID(),
          userId: randomUUID(),
          eventType: 'restore',
          revision: '2',
          occurredAt: '2026-10-08T00:10:00.000Z',
          restoreUntil: null,
          policyVersion: 1,
          traceId: randomUUID(),
        },
      ],
      { manifestId: randomUUID(), generatedAt: '2026-10-08T00:11:00.000Z' },
    );
    await expect(
      replayDeletionManifest(testPool, targetSchema, manifest, {
        expectedThroughSequence: manifest.throughSequence,
        expectedPayloadSha256: manifest.payloadSha256,
      }),
    ).rejects.toThrow('保持隔离');
    const after = await testPool.query<{ count: number }>(
      `select count(*)::int as count from ${qualified(targetSchema, 'deletion_events')}`,
    );
    expect(after.rows[0]?.count).toBe(existingEvents.rows[0]?.count);
  });

  it('does not expose manifest functions to the ordinary application role', async () => {
    const privileges = await testPool.query<{ app_read: boolean; app_acknowledge: boolean }>(
      `select
         has_function_privilege('resume_opt_app', $1, 'execute') app_read,
         has_function_privilege('resume_opt_app', $2, 'execute') app_acknowledge`,
      [
        `${sourceSchema}.read_deletion_manifest_events()`,
        `${sourceSchema}.acknowledge_deletion_manifest(uuid,uuid[])`,
      ],
    );
    expect(privileges.rows[0]).toEqual({ app_read: false, app_acknowledge: false });
  });
});
