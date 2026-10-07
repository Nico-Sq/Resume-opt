import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseToolConfig } from '@resume/config/server';
import {
  PostgresAccountDeletionCleaner,
  PostgresAccountDeletionRequests,
} from '@resume/infrastructure/account-deletion';
import { runMigrations } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import { seedFixedResume } from '@resume/infrastructure/resume-seed';
import { PostgresUserTransactionManager } from '@resume/infrastructure/resume-transactions';

const testDatabase = parseDatabaseToolConfig({ ...process.env, APP_ENV: 'test' }, 'test');
const privacyDatabase = parseDatabaseToolConfig({ ...process.env, APP_ENV: 'test' }, 'privacy');

const schema = `account_delete_${randomUUID().replaceAll('-', '')}`;
const migrationsDirectory = resolve(import.meta.dirname, '../../database/migrations');
const migrationPool = createPostgresPool({
  connectionString: testDatabase.connectionString,
  max: 4,
  applicationName: 'resume-opt-account-delete-migration-test',
});
const privacyPool = createPostgresPool({
  connectionString: privacyDatabase.connectionString,
  max: 2,
  applicationName: 'resume-opt-account-delete-cleanup-test',
});
const requests = new PostgresAccountDeletionRequests(migrationPool, schema);
const cleaner = new PostgresAccountDeletionCleaner(privacyPool, schema);

function qualified(table: string) {
  if (!/^[a-z_]+$/u.test(table)) throw new Error('测试表名不安全');
  return `"${schema}"."${table}"`;
}

beforeAll(async () => {
  await migrationPool.query(`create schema "${schema}" authorization resume_opt_test`);
  await migrationPool.query(
    `grant usage on schema "${schema}" to resume_opt_app, resume_opt_auth, resume_opt_privacy`,
  );
  await runMigrations(migrationPool, migrationsDirectory, schema);
});

afterAll(async () => {
  if (/^account_delete_[a-f0-9]{32}$/u.test(schema)) {
    await migrationPool.query(`drop schema "${schema}" cascade`);
  }
  await Promise.all([migrationPool.end(), privacyPool.end()]);
});

afterEach(async () => {
  await migrationPool.query(
    `truncate table
      ${qualified('privacy_requests')}, ${qualified('deletion_events')},
      ${qualified('audit_events')}, ${qualified('idempotency_requests')},
      ${qualified('resume_versions')}, ${qualified('resumes')},
      ${qualified('auth_verifications')}, ${qualified('auth_sessions')},
      ${qualified('auth_accounts')}, ${qualified('auth_users')},
      ${qualified('users')}, ${qualified('templates')} cascade`,
  );
});

async function fixture(email = `${randomUUID()}@example.cn`) {
  const userId = randomUUID();
  const resumeId = randomUUID();
  await migrationPool.query(
    `insert into ${qualified('auth_users')}
      (id, name, email, email_verified, created_at, updated_at)
     values ($1, '注销测试用户', $2, true, now(), now())`,
    [userId, email],
  );
  await seedFixedResume(migrationPool, {
    userId,
    resumeId,
    versionId: randomUUID(),
    schema,
  });
  const accountId = randomUUID();
  await migrationPool.query(
    `insert into ${qualified('auth_sessions')}
      (id, expires_at, token, created_at, updated_at, user_id)
     values ($1, now() + interval '1 day', $2, now(), now(), $3)`,
    [randomUUID(), accountId, userId],
  );
  await migrationPool.query(
    `insert into ${qualified('auth_accounts')}
      (id, account_id, provider_id, user_id, password, created_at, updated_at)
     values ($1, $2, 'credential', $3, 'hashed-fixture', now(), now())`,
    [randomUUID(), accountId, userId],
  );
  await migrationPool.query(
    `insert into ${qualified('auth_verifications')}
      (id, identifier, value, expires_at, created_at, updated_at)
     values ($1, 'reset-fixture', $2::text, now() + interval '1 hour', now(), now())`,
    [randomUUID(), userId],
  );
  await migrationPool.query(
    `insert into ${qualified('idempotency_requests')}
      (user_id, operation, key, request_hash, status, response_body, expires_at,
       resource_type, resource_id)
     values ($1, 'resume.save', $2, 'fixture', 'completed', '{}'::jsonb,
             now() + interval '1 day', 'resume', $3)`,
    [userId, randomUUID(), resumeId],
  );
  await migrationPool.query(
    `insert into ${qualified('audit_events')}
      (id, actor_user_id, action, resource_type, resource_id, trace_id, result_code)
     values ($1, $2, 'resume.save', 'resume', $3, $4, 'SAVED')`,
    [randomUUID(), userId, resumeId, randomUUID()],
  );
  return { email, userId, resumeId };
}

async function accept(userId: string, idempotencyKey = randomUUID()) {
  return requests.accept({
    userId,
    idempotencyKey,
    requestHash: 'confirmed-account-delete-v1',
    traceId: randomUUID(),
  });
}

describe('account deletion lifecycle', () => {
  it('atomically disables business access and replays only the same request', async () => {
    const { userId } = await fixture();
    const key = randomUUID();

    const first = await accept(userId, key);
    const replay = await accept(userId, key);
    const conflicting = await accept(userId, randomUUID());

    expect(first).toMatchObject({ replayed: false });
    expect(replay).toMatchObject({
      requestId: (first as { requestId: string }).requestId,
      replayed: true,
    });
    expect(conflicting).toBe('key_reused');
    const timeline = await migrationPool.query<{
      status: string;
      deleted_at: Date;
      event_type: string;
      resource_type: string;
    }>(
      `select u.status, u.deleted_at, e.event_type, e.resource_type
         from ${qualified('users')} u
         join ${qualified('deletion_events')} e on e.user_id = u.id
        where u.id = $1 and e.event_type = 'account_delete'`,
      [userId],
    );
    expect(timeline.rows).toEqual([
      {
        status: 'disabled',
        deleted_at: expect.any(Date) as Date,
        event_type: 'account_delete',
        resource_type: 'account',
      },
    ]);
    await expect(
      new PostgresUserTransactionManager(migrationPool, schema).withUser(userId, () =>
        Promise.resolve('old-session-write'),
      ),
    ).rejects.toThrow('需要登录');
  });

  it('lets an in-flight business transaction finish before account disable wins the user lock', async () => {
    const { userId, resumeId } = await fixture();
    const transactions = new PostgresUserTransactionManager(migrationPool, schema);
    let release!: () => void;
    let locked!: () => void;
    const lockedPromise = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = transactions.withUser(userId, async (transaction) => {
      locked();
      await releasePromise;
      return transaction.resumes.findActiveById(resumeId);
    });
    await lockedPromise;
    let deletionSettled = false;
    const deletion = accept(userId).finally(() => {
      deletionSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(deletionSettled).toBe(false);

    release();
    await expect(inFlight).resolves.toMatchObject({ id: resumeId });
    await expect(deletion).resolves.toMatchObject({ replayed: false });
  });

  it('requires an exported tombstone, clears every owned object, and is reentrant', async () => {
    const email = `${randomUUID()}@example.cn`;
    const { userId } = await fixture(email);
    const receipt = await accept(userId);
    if (typeof receipt === 'string') throw new Error('注销受理失败');

    expect(await cleaner.run({ limit: 10, dryRun: true, runId: randomUUID() })).toMatchObject({
      selectedCount: 0,
      blockedUnexportedCount: 1,
    });
    await migrationPool.query(
      `update ${qualified('deletion_events')}
          set manifest_export_id = $1, manifest_exported_at = now()
        where resource_type = 'account' and resource_id = $2`,
      [randomUUID(), userId],
    );

    const report = await cleaner.run({ limit: 10, dryRun: false, runId: randomUUID() });
    expect(report).toMatchObject({
      selectedCount: 1,
      purgedCount: 1,
      resumesDeleted: 1,
      versionsDeleted: 1,
      receiptsDeleted: 1,
      auditsDeleted: 2,
      authSessionsDeleted: 1,
      authAccountsDeleted: 1,
      authVerificationsDeleted: 1,
      authUsersDeleted: 1,
    });
    expect(await cleaner.run({ limit: 10, dryRun: false, runId: randomUUID() })).toMatchObject({
      selectedCount: 0,
      purgedCount: 0,
    });

    const remaining = await migrationPool.query<{
      users: number;
      resumes: number;
      versions: number;
      sessions: number;
      accounts: number;
      auth_users: number;
      verifications: number;
      request_status: string;
      deletion_events: number;
    }>(
      `select
        (select count(*)::int from ${qualified('users')} where id = $1) users,
        (select count(*)::int from ${qualified('resumes')} where user_id = $1) resumes,
        (select count(*)::int from ${qualified('resume_versions')} where user_id = $1) versions,
        (select count(*)::int from ${qualified('auth_sessions')} where user_id = $1) sessions,
        (select count(*)::int from ${qualified('auth_accounts')} where user_id = $1) accounts,
        (select count(*)::int from ${qualified('auth_users')} where id = $1) auth_users,
        (select count(*)::int from ${qualified('auth_verifications')} where value = $1::text) verifications,
        (select status from ${qualified('privacy_requests')} where user_id = $1) request_status,
        (select count(*)::int from ${qualified('deletion_events')} where user_id = $1) deletion_events`,
      [userId],
    );
    expect(remaining.rows[0]).toEqual({
      users: 0,
      resumes: 0,
      versions: 0,
      sessions: 0,
      accounts: 0,
      auth_users: 0,
      verifications: 0,
      request_status: 'completed',
      deletion_events: 1,
    });

    const newUserId = randomUUID();
    await migrationPool.query(
      `insert into ${qualified('auth_users')}
        (id, name, email, email_verified, created_at, updated_at)
       values ($1, '重新注册用户', $2, false, now(), now())`,
      [newUserId, email],
    );
    expect(newUserId).not.toBe(userId);
  });

  it('does not grant body-table access or cleanup execution to Web and Auth roles', async () => {
    const privileges = await migrationPool.query<{
      privacy_execute: boolean;
      app_execute: boolean;
      privacy_body_read: boolean;
    }>(
      `select
        has_function_privilege('resume_opt_privacy', $1, 'execute') privacy_execute,
        has_function_privilege('resume_opt_app', $1, 'execute') app_execute,
        has_table_privilege('resume_opt_privacy', $2, 'select') privacy_body_read`,
      [`${schema}.purge_deleted_accounts(integer,boolean,uuid)`, `${schema}.resumes`],
    );
    expect(privileges.rows[0]).toEqual({
      privacy_execute: true,
      app_execute: false,
      privacy_body_read: false,
    });
  });
});
