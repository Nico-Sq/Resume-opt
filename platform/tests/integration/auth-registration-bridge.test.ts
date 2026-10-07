import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseToolConfig } from '@resume/config/server';
import { runMigrations, type MigrationResult } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';

const migration = parseDatabaseToolConfig({ ...process.env, APP_ENV: 'test' }, 'migration');
const authConnectionString = process.env.PG_AUTH_URL;
if (!authConnectionString) throw new Error('真实 Auth 迁移测试缺少 PG_AUTH_URL');
const appConnectionString = process.env.PG_DEV_URL;
if (!appConnectionString) throw new Error('真实 Auth 迁移测试缺少 PG_DEV_URL');

const schema = `auth_bridge_${randomUUID().replaceAll('-', '')}`;
const migrationsDirectory = resolve(import.meta.dirname, '../../database/migrations');
const initialMigrationPath = resolve(migrationsDirectory, '0001_initial.up.sql');
const authDownMigrationPath = resolve(migrationsDirectory, '0002_auth_identity.down.sql');
const authRateLimitDownMigrationPath = resolve(
  migrationsDirectory,
  '0003_auth_rate_limit.down.sql',
);
const businessRlsDownMigrationPath = resolve(
  migrationsDirectory,
  '0004_active_business_rls.down.sql',
);
const migrationPool = createPostgresPool({
  connectionString: migration.connectionString,
  max: 1,
  applicationName: 'resume-opt-auth-migration-test',
});
const authPool = createPostgresPool({
  connectionString: authConnectionString,
  max: 1,
  applicationName: 'resume-opt-auth-role-test',
});
const applicationPool = createPostgresPool({
  connectionString: appConnectionString,
  max: 1,
  applicationName: 'resume-opt-auth-boundary-test',
});

const fixedUserId = '00000000-0000-4000-8000-000000000001';
let legacySnapshot: Record<string, unknown>;
let migrationResult: MigrationResult;

function qualified(table: string): string {
  if (!/^[a-z_]+$/u.test(table)) throw new Error('测试表名不安全');
  return `"${schema}"."${table}"`;
}

async function queryAs(
  pool: ReturnType<typeof createPostgresPool>,
  sql: string,
  values: unknown[] = [],
  commit = false,
) {
  const client = await pool.connect();
  let completed = false;
  try {
    await client.query('begin');
    await client.query(`set local search_path to "${schema}", public`);
    const result = await client.query(sql, values);
    await client.query(commit ? 'commit' : 'rollback');
    completed = true;
    return result;
  } finally {
    if (!completed) await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

async function legacyState(): Promise<Record<string, unknown>> {
  const result = await migrationPool.query<Record<string, unknown>>(`
    select
      (select count(*)::int from ${qualified('users')}) as user_count,
      (select count(*)::int from ${qualified('resumes')}) as resume_count,
      (select count(*)::int from ${qualified('resume_versions')}) as version_count,
      (select user_id from ${qualified('resumes')} limit 1) as owner_id,
      (select revision::text from ${qualified('resumes')} limit 1) as revision,
      (select md5(document::text) from ${qualified('resumes')} limit 1) as document_hash,
      (select md5(snapshot::text) from ${qualified('resume_versions')} limit 1) as snapshot_hash
  `);
  return result.rows[0] ?? {};
}

beforeAll(async () => {
  const initialSql = await readFile(initialMigrationPath, 'utf8');
  const initialChecksum = createHash('sha256').update(initialSql).digest('hex');
  await migrationPool.query(`create schema "${schema}" authorization resume_opt_migrator`);
  await migrationPool.query(`grant usage on schema "${schema}" to resume_opt_app, resume_opt_auth`);

  const client = await migrationPool.connect();
  try {
    await client.query('begin');
    await client.query(`set local search_path to "${schema}", public`);
    await client.query(initialSql);
    await client.query(`
      create table schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);
    await client.query('insert into schema_migrations(name, checksum) values ($1, $2)', [
      '0001_initial.up.sql',
      initialChecksum,
    ]);
    await client.query(`
      insert into templates
        (template_id, version, renderer_version, manifest, asset_hash, status)
      values ('ats-basic', '1.0.0', '1.0.0', '{}', 'legacy', 'published');
      insert into users(id, status, display_name)
      values ('${fixedUserId}', 'active', '旧固定用户');
      insert into resumes
        (id, user_id, title, document, revision, schema_version, template_id, template_version)
      values (
        '00000000-0000-4000-8000-000000000002',
        '${fixedUserId}',
        '旧简历',
        '{"schemaVersion":1,"marker":"legacy"}',
        1,
        1,
        'ats-basic',
        '1.0.0'
      );
      insert into resume_versions
        (id, resume_id, user_id, revision, title_snapshot, schema_version, template_id,
         template_version, renderer_version, snapshot, content_hash, reason)
      values (
        '00000000-0000-4000-8000-000000000003',
        '00000000-0000-4000-8000-000000000002',
        '${fixedUserId}',
        1,
        '旧简历',
        1,
        'ats-basic',
        '1.0.0',
        '1.0.0',
        '{"schemaVersion":1,"marker":"legacy"}',
        'legacy-hash',
        'initial'
      );
    `);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  legacySnapshot = await legacyState();
  migrationResult = await runMigrations(migrationPool, migrationsDirectory, schema);
});

afterAll(async () => {
  if (/^auth_bridge_[a-f0-9]{32}$/u.test(schema)) {
    await migrationPool.query(`drop schema "${schema}" cascade`);
  }
  await Promise.all([migrationPool.end(), authPool.end(), applicationPool.end()]);
});

describe('Better Auth shared UUID migration', () => {
  it('upgrades a populated V0.1 schema without changing legacy owners or content hashes', async () => {
    expect(migrationResult).toEqual({
      applied: [
        '0002_auth_identity.up.sql',
        '0003_auth_rate_limit.up.sql',
        '0004_active_business_rls.up.sql',
        '0005_resume_list_index.up.sql',
        '0006_resume_lifecycle.up.sql',
        '0007_expired_resume_cleanup.up.sql',
        '0008_account_deletion.up.sql',
        '0009_deletion_manifest_replay.up.sql',
      ],
      alreadyApplied: ['0001_initial.up.sql'],
    });
    expect(await legacyState()).toEqual(legacySnapshot);
    const authRows = await migrationPool.query(
      `select id from ${qualified('auth_users')} where id = $1`,
      [fixedUserId],
    );
    expect(authRows.rowCount).toBe(0);
  });

  it('creates one business user with the exact registered Auth UUID', async () => {
    const userId = randomUUID();
    await queryAs(
      authPool,
      'insert into auth_users(id, name, email) values ($1, $2, $3)',
      [userId, '共享身份用户', `${userId}@example.cn`],
      true,
    );

    const result = await migrationPool.query<{ id: string; display_name: string; status: string }>(
      `select id, display_name, status from ${qualified('users')} where id = $1`,
      [userId],
    );
    expect(result.rows).toEqual([{ id: userId, display_name: '共享身份用户', status: 'active' }]);
  });

  it('rolls back the bridge when the business user insert fails', async () => {
    const userId = randomUUID();
    await expect(
      queryAs(authPool, 'insert into auth_users(id, name, email) values ($1, $2, $3)', [
        userId,
        '超'.repeat(101),
        `${userId}@example.cn`,
      ]),
    ).rejects.toThrow();

    const result = await migrationPool.query(
      `select id from ${qualified('users')} where id = $1
       union all
       select id from ${qualified('auth_users')} where id = $1`,
      [userId],
    );
    expect(result.rowCount).toBe(0);
  });

  it('rejects duplicate normalized email and rolls back the second business user', async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    const email = `${firstId}@example.cn`;
    await queryAs(
      authPool,
      'insert into auth_users(id, name, email) values ($1, $2, $3)',
      [firstId, '首个用户', email],
      true,
    );
    await expect(
      queryAs(authPool, 'insert into auth_users(id, name, email) values ($1, $2, $3)', [
        secondId,
        '重复邮箱用户',
        email,
      ]),
    ).rejects.toThrow();

    const result = await migrationPool.query(`select id from ${qualified('users')} where id = $1`, [
      secondId,
    ]);
    expect(result.rowCount).toBe(0);
  });

  it('cannot claim a fixed user or change a registered Auth UUID', async () => {
    await expect(
      queryAs(authPool, 'insert into auth_users(id, name, email) values ($1, $2, $3)', [
        fixedUserId,
        '试图认领',
        'claim@example.cn',
      ]),
    ).rejects.toThrow();

    const userId = randomUUID();
    const replacementId = randomUUID();
    await queryAs(
      authPool,
      'insert into auth_users(id, name, email) values ($1, $2, $3)',
      [userId, '不可改 ID', `${userId}@example.cn`],
      true,
    );
    await expect(
      queryAs(authPool, 'update auth_users set id = $1 where id = $2', [replacementId, userId]),
    ).rejects.toThrow('auth user id is immutable');

    const rows = await migrationPool.query<{ id: string }>(
      `select id from ${qualified('auth_users')} where id in ($1, $2) order by id`,
      [userId, replacementId],
    );
    expect(rows.rows).toEqual([{ id: userId }]);
  });

  it('keeps Auth and business table privileges separated', async () => {
    await expect(queryAs(authPool, 'select id from auth_users limit 1')).resolves.toBeDefined();
    await expect(queryAs(authPool, 'select document from resumes limit 1')).rejects.toThrow(
      /permission denied/iu,
    );
    await expect(queryAs(applicationPool, 'select email from auth_users limit 1')).rejects.toThrow(
      /permission denied/iu,
    );
    await expect(
      queryAs(authPool, 'insert into users(id, status, display_name) values ($1, $2, $3)', [
        randomUUID(),
        'active',
        '越权用户',
      ]),
    ).rejects.toThrow(/permission denied/iu);
  });

  it('limits the registration bridge to its fixed definer boundary', async () => {
    const result = await migrationPool.query<{
      app_execute: boolean;
      auth_execute: boolean;
      security_definer: boolean;
      settings: string[];
    }>(
      `select
         p.prosecdef as security_definer,
         p.proconfig as settings,
         has_function_privilege('resume_opt_app', p.oid, 'execute') as app_execute,
         has_function_privilege('resume_opt_auth', p.oid, 'execute') as auth_execute
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = $1 and p.proname = 'bridge_auth_user'`,
      [schema],
    );
    expect(result.rows).toEqual([
      {
        app_execute: false,
        auth_execute: false,
        security_definer: true,
        settings: ['search_path=pg_catalog'],
      },
    ]);
  });

  it('can remove empty Auth tables without touching V0.1 business tables', async () => {
    const downSchema = `auth_bridge_${randomUUID().replaceAll('-', '')}`;
    try {
      await migrationPool.query(`create schema "${downSchema}" authorization resume_opt_migrator`);
      await migrationPool.query(
        `grant usage on schema "${downSchema}" to resume_opt_app, resume_opt_auth`,
      );
      await runMigrations(migrationPool, migrationsDirectory, downSchema);
      const downSql = await readFile(authDownMigrationPath, 'utf8');
      const rateLimitDownSql = await readFile(authRateLimitDownMigrationPath, 'utf8');
      const businessRlsDownSql = await readFile(businessRlsDownMigrationPath, 'utf8');
      const client = await migrationPool.connect();
      try {
        await client.query('begin');
        await client.query(`set local search_path to "${downSchema}", public`);
        await client.query(businessRlsDownSql);
        await client.query(rateLimitDownSql);
        await client.query(downSql);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }

      const tables = await migrationPool.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = $1 and table_name like 'auth_%'`,
        [downSchema],
      );
      const businessTable = await migrationPool.query(
        `select id from "${downSchema}".users limit 1`,
      );
      expect(tables.rowCount).toBe(0);
      expect(businessTable.rowCount).toBe(0);
    } finally {
      if (/^auth_bridge_[a-f0-9]{32}$/u.test(downSchema)) {
        await migrationPool.query(`drop schema if exists "${downSchema}" cascade`);
      }
    }
  });
});
