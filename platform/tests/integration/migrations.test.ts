import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseToolConfig, parseServerRuntimeConfig } from '@resume/config/server';
import { runMigrations, type MigrationResult } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';

const config = parseServerRuntimeConfig({ ...process.env, APP_ENV: 'test' });
const migration = parseDatabaseToolConfig({ ...process.env, APP_ENV: 'test' }, 'migration');
const authConnectionString = process.env.PG_AUTH_URL;
if (!authConnectionString) throw new Error('角色隔离测试缺少 PG_AUTH_URL');
const schema = `migration_${randomUUID().replaceAll('-', '')}`;
const migrationsDirectory = resolve(import.meta.dirname, '../../database/migrations');
const migrationPool = createPostgresPool({
  connectionString: migration.connectionString,
  max: 1,
  applicationName: 'resume-opt-migration-test',
});
const applicationPool = createPostgresPool({
  connectionString: config.PG_DEV_URL,
  max: 1,
  applicationName: 'resume-opt-migration-rls-test',
});
const authPool = createPostgresPool({
  connectionString: authConnectionString,
  max: 1,
  applicationName: 'resume-opt-migration-auth-role-test',
});
let firstRun: MigrationResult;
let secondRun: MigrationResult;

function qualified(table: string) {
  if (!/^[a-z_]+$/u.test(table)) throw new Error('测试表名不安全');
  return `"${schema}"."${table}"`;
}

beforeAll(async () => {
  await migrationPool.query(`create schema "${schema}" authorization resume_opt_migrator`);
  await migrationPool.query(`grant usage on schema "${schema}" to resume_opt_app`);
  firstRun = await runMigrations(migrationPool, migrationsDirectory, schema);
  secondRun = await runMigrations(migrationPool, migrationsDirectory, schema);
});

afterAll(async () => {
  if (/^migration_[a-f0-9]{32}$/u.test(schema)) {
    await migrationPool.query(`drop schema "${schema}" cascade`);
  }
  await Promise.all([migrationPool.end(), applicationPool.end(), authPool.end()]);
});

describe('initial database migration', () => {
  it('migrates an empty schema and is idempotent on the second run', () => {
    expect(firstRun.applied).toEqual([
      '0001_initial.up.sql',
      '0002_auth_identity.up.sql',
      '0003_auth_rate_limit.up.sql',
      '0004_active_business_rls.up.sql',
      '0005_resume_list_index.up.sql',
      '0006_resume_lifecycle.up.sql',
      '0007_expired_resume_cleanup.up.sql',
    ]);
    expect(secondRun.alreadyApplied).toEqual([
      '0001_initial.up.sql',
      '0002_auth_identity.up.sql',
      '0003_auth_rate_limit.up.sql',
      '0004_active_business_rls.up.sql',
      '0005_resume_list_index.up.sql',
      '0006_resume_lifecycle.up.sql',
      '0007_expired_resume_cleanup.up.sql',
    ]);
  });

  it('creates the required business and auth tables', async () => {
    const tables = await migrationPool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = $1 order by table_name`,
      [schema],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'audit_events',
      'auth_accounts',
      'auth_rate_limits',
      'auth_sessions',
      'auth_users',
      'auth_verifications',
      'deletion_events',
      'idempotency_requests',
      'resume_versions',
      'resumes',
      'schema_migrations',
      'templates',
      'users',
    ]);
  });

  it('enforces ownership through the real application role and RLS', async () => {
    const userA = '10000000-0000-4000-8000-000000000001';
    const userB = '10000000-0000-4000-8000-000000000002';
    await migrationPool.query(
      `insert into ${qualified('templates')}
        (template_id, version, renderer_version, manifest, asset_hash, status)
       values ('ats-basic', '1.0.0', '1.0.0', '{}'::jsonb, 'fixture', 'published')`,
    );
    await migrationPool.query(
      `insert into ${qualified('users')}(id, status, display_name)
       values ($1, 'active', '用户A'), ($2, 'active', '用户B')`,
      [userA, userB],
    );
    await migrationPool.query(
      `insert into ${qualified('resumes')}
        (id, user_id, title, document, schema_version, template_id, template_version)
       values
        ('20000000-0000-4000-8000-000000000001', $1, 'A简历', '{"schemaVersion":1}', 1, 'ats-basic', '1.0.0'),
        ('20000000-0000-4000-8000-000000000002', $2, 'B简历', '{"schemaVersion":1}', 1, 'ats-basic', '1.0.0')`,
      [userA, userB],
    );
    await migrationPool.query(
      `insert into ${qualified('resume_versions')}
        (id, resume_id, user_id, revision, title_snapshot, schema_version,
         template_id, template_version, renderer_version, snapshot, content_hash, reason)
       values
        ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', $1,
         1, 'A简历', 1, 'ats-basic', '1.0.0', '1.0.0', '{}', 'a', 'initial'),
        ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', $2,
         1, 'B简历', 1, 'ats-basic', '1.0.0', '1.0.0', '{}', 'b', 'initial')`,
      [userA, userB],
    );

    const client = await applicationPool.connect();
    try {
      await client.query('begin');
      await client.query(`set local search_path to "${schema}", public`);
      const anonymousRows = await client.query('select id from resumes');
      expect(anonymousRows.rowCount).toBe(0);
      expect((await client.query('select id from resume_versions')).rowCount).toBe(0);

      await client.query("select set_config('app.user_id', $1, true)", [userA]);
      const ownedRows = await client.query<{ user_id: string }>('select user_id from resumes');
      expect(ownedRows.rows).toEqual([{ user_id: userA }]);
      expect(
        (await client.query<{ user_id: string }>('select user_id from resume_versions')).rows,
      ).toEqual([{ user_id: userA }]);
      await client.query('savepoint owner_write');
      await expect(
        client.query(
          `insert into resumes
            (id, user_id, title, document, schema_version, template_id, template_version)
           values ('20000000-0000-4000-8000-000000000003', $1, '越权', '{}', 1, 'ats-basic', '1.0.0')`,
          [userB],
        ),
      ).rejects.toThrow();
      await client.query('rollback to savepoint owner_write');
      await client.query('savepoint version_write');
      await expect(
        client.query(
          `insert into resume_versions
            (id, resume_id, user_id, revision, title_snapshot, schema_version,
             template_id, template_version, renderer_version, snapshot, content_hash, reason)
           values ('30000000-0000-4000-8000-000000000003',
                   '20000000-0000-4000-8000-000000000002', $1, 2, '越权版本', 1,
                   'ats-basic', '1.0.0', '1.0.0', '{}', 'cross-owner', 'edit')`,
          [userA],
        ),
      ).rejects.toThrow();
      await client.query('rollback to savepoint version_write');
      await client.query('rollback');

      await client.query('begin');
      await client.query(`set local search_path to "${schema}", public`);
      expect((await client.query('select id from resumes')).rowCount).toBe(0);
      await client.query("select set_config('app.user_id', $1, true)", [userB]);
      expect((await client.query<{ user_id: string }>('select user_id from resumes')).rows).toEqual(
        [{ user_id: userB }],
      );
      await migrationPool.query(
        `update ${qualified('users')} set status = 'disabled' where id = $1`,
        [userB],
      );
      expect((await client.query('select id from resumes')).rowCount).toBe(0);
      expect((await client.query('select id from resume_versions')).rowCount).toBe(0);
      await client.query('rollback');

      await migrationPool.query(
        `update ${qualified('resumes')} set deleted_at = now() where user_id = $1`,
        [userA],
      );
      await client.query('begin');
      await client.query(`set local search_path to "${schema}", public`);
      await client.query("select set_config('app.user_id', $1, true)", [userA]);
      expect((await client.query('select id from resumes')).rowCount).toBe(0);
      expect((await client.query('select id from resume_versions')).rowCount).toBe(0);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('keeps runtime roles non-owner without RLS bypass and separates auth from business data', async () => {
    const roles = await migrationPool.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `select rolname, rolsuper, rolbypassrls
         from pg_catalog.pg_roles
        where rolname in ('resume_opt_app', 'resume_opt_auth', 'resume_opt_privacy')
        order by rolname`,
    );
    expect(roles.rows).toEqual([
      { rolname: 'resume_opt_app', rolsuper: false, rolbypassrls: false },
      { rolname: 'resume_opt_auth', rolsuper: false, rolbypassrls: false },
      { rolname: 'resume_opt_privacy', rolsuper: false, rolbypassrls: false },
    ]);

    const owners = await migrationPool.query<{ tableowner: string }>(
      `select distinct tableowner from pg_catalog.pg_tables where schemaname = $1`,
      [schema],
    );
    expect(owners.rows.map((row) => row.tableowner)).not.toContain('resume_opt_app');
    expect(owners.rows.map((row) => row.tableowner)).not.toContain('resume_opt_auth');
    expect(owners.rows.map((row) => row.tableowner)).not.toContain('resume_opt_privacy');

    const appClient = await applicationPool.connect();
    const authClient = await authPool.connect();
    try {
      await appClient.query('begin');
      await appClient.query(`set local search_path to "${schema}", public`);
      await expect(appClient.query('select token from auth_sessions')).rejects.toThrow();
      await appClient.query('rollback');

      await appClient.query('begin');
      await appClient.query(`set local search_path to "${schema}", public`);
      await expect(appClient.query('select * from deletion_events')).rejects.toThrow();
      await appClient.query('rollback');

      await authClient.query('begin');
      await authClient.query(`set local search_path to "${schema}", public`);
      await expect(authClient.query('select document from resumes')).rejects.toThrow();
      await authClient.query('rollback');

      await authClient.query('begin');
      await authClient.query(`set local search_path to "${schema}", public`);
      await expect(
        authClient.query('select * from list_deleted_resumes(1, null, null)'),
      ).rejects.toThrow();
      await authClient.query('rollback');
    } finally {
      appClient.release();
      authClient.release();
    }
  });
});
