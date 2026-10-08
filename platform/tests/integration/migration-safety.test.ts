import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { parseDatabaseToolConfig } from '@resume/config/server';
import { runMigrations } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';

const testDatabase = parseDatabaseToolConfig({ ...process.env, APP_ENV: 'test' }, 'test');
const migrationsDirectory = resolve(import.meta.dirname, '../../database/migrations');
const pool = createPostgresPool({
  connectionString: testDatabase.connectionString,
  max: 2,
  applicationName: 'resume-opt-migration-safety-test',
});
const schemas: string[] = [];

async function isolatedSchema(prefix: string): Promise<string> {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  schemas.push(schema);
  await pool.query(`create schema "${schema}" authorization resume_opt_test`);
  return schema;
}

afterAll(async () => {
  for (const schema of schemas) {
    if (/^(?:checksum|interruption)_[a-f0-9]{32}$/u.test(schema)) {
      await pool.query(`drop schema if exists "${schema}" cascade`);
    }
  }
  await pool.end();
});

describe('migration failure safety', () => {
  it('rejects a changed checksum without applying later work', async () => {
    const schema = await isolatedSchema('checksum');
    await runMigrations(pool, migrationsDirectory, schema);
    await pool.query(
      `update "${schema}".schema_migrations set checksum = repeat('0', 64)
        where name = '0009_deletion_manifest_replay.up.sql'`,
    );

    await expect(runMigrations(pool, migrationsDirectory, schema)).rejects.toThrow(
      '已执行迁移的校验和发生变化',
    );
    const count = await pool.query<{ count: number }>(
      `select count(*)::int as count from "${schema}".schema_migrations`,
    );
    expect(count.rows[0]?.count).toBe(9);
  });

  it('rolls back an interrupted migration and permits a corrected retry', async () => {
    const schema = await isolatedSchema('interruption');
    await runMigrations(pool, migrationsDirectory, schema);
    const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'resume-opt-migrations-'));
    const injectedPath = resolve(temporaryDirectory, '0010_injected_failure.up.sql');
    try {
      const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.up.sql'));
      await Promise.all(
        files.map((file) =>
          copyFile(resolve(migrationsDirectory, file), resolve(temporaryDirectory, basename(file))),
        ),
      );
      await writeFile(
        injectedPath,
        'create table interrupted_marker(id integer); select missing_injected_function();\n',
        'utf8',
      );

      await expect(runMigrations(pool, temporaryDirectory, schema)).rejects.toThrow();
      const interrupted = await pool.query<{ table_name: string | null; migration_count: number }>(
        `select to_regclass($1)::text table_name,
                (select count(*)::int from "${schema}".schema_migrations
                  where name = '0010_injected_failure.up.sql') migration_count`,
        [`${schema}.interrupted_marker`],
      );
      expect(interrupted.rows[0]).toEqual({ table_name: null, migration_count: 0 });

      await writeFile(injectedPath, 'create table recovered_marker(id integer);\n', 'utf8');
      await expect(runMigrations(pool, temporaryDirectory, schema)).resolves.toMatchObject({
        applied: ['0010_injected_failure.up.sql'],
      });
      const recovered = await pool.query<{ table_name: string | null }>(
        'select to_regclass($1)::text table_name',
        [`${schema}.recovered_marker`],
      );
      expect(recovered.rows[0]?.table_name).toBe(`${schema}.recovered_marker`);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
