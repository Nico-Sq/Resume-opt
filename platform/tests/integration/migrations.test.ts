import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseServerRuntimeConfig } from '@resume/config/server';
import { runMigrations, type MigrationResult } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';

const config = parseServerRuntimeConfig({
  ...process.env,
  APP_ENV: 'test',
  AUTH_MODE: 'better-auth',
});
const schema = `migration_${randomUUID().replaceAll('-', '')}`;
const migrationsDirectory = resolve(import.meta.dirname, '../../database/migrations');
const migrationPool = createPostgresPool({
  connectionString: config.PG_MIGRATION_URL,
  max: 1,
  applicationName: 'resume-opt-migration-test',
});
const applicationPool = createPostgresPool({
  connectionString: config.PG_DEV_URL,
  max: 1,
  applicationName: 'resume-opt-migration-rls-test',
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
  await Promise.all([migrationPool.end(), applicationPool.end()]);
});

describe('initial database migration', () => {
  it('migrates an empty schema and is idempotent on the second run', () => {
    expect(firstRun.applied).toEqual(['0001_initial.up.sql']);
    expect(secondRun.alreadyApplied).toEqual(['0001_initial.up.sql']);
  });

  it('creates the required V0.1 tables and constraints', async () => {
    const tables = await migrationPool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = $1 order by table_name`,
      [schema],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'audit_events',
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

    const client = await applicationPool.connect();
    try {
      await client.query('begin');
      await client.query(`set local search_path to "${schema}", public`);
      const anonymousRows = await client.query('select id from resumes');
      expect(anonymousRows.rowCount).toBe(0);

      await client.query("select set_config('app.user_id', $1, true)", [userA]);
      const ownedRows = await client.query<{ user_id: string }>('select user_id from resumes');
      expect(ownedRows.rows).toEqual([{ user_id: userA }]);
      await expect(
        client.query(
          `insert into resumes
            (id, user_id, title, document, schema_version, template_id, template_version)
           values ('20000000-0000-4000-8000-000000000003', $1, '越权', '{}', 1, 'ats-basic', '1.0.0')`,
          [userB],
        ),
      ).rejects.toThrow();
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});
