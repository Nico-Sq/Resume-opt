import { afterAll, describe, expect, it } from 'vitest';

import { parseServerRuntimeConfig } from '@resume/config/server';
import { checkDatabaseReadiness, createPostgresPool } from '@resume/infrastructure/postgres';

const config = parseServerRuntimeConfig({
  ...process.env,
  APP_ENV: 'test',
  AUTH_MODE: 'better-auth',
});
const applicationPool = createPostgresPool({
  connectionString: config.PG_DEV_URL,
  max: 1,
  applicationName: 'resume-opt-integration-test',
});
const migrationPool = createPostgresPool({
  connectionString: config.PG_MIGRATION_URL,
  max: 1,
  applicationName: 'resume-opt-migration-test',
});
const testPool = createPostgresPool({
  connectionString: config.PG_TEST_URL,
  max: 1,
  applicationName: 'resume-opt-test-role-test',
});

afterAll(async () => {
  await Promise.all([applicationPool.end(), migrationPool.end(), testPool.end()]);
});

describe('database runtime roles', () => {
  it('connects each role to its assigned database', async () => {
    const [application, migration, test] = await Promise.all([
      applicationPool.query<{ database: string; role: string }>(
        'select current_database() as database, current_user as role',
      ),
      migrationPool.query<{ database: string; role: string }>(
        'select current_database() as database, current_user as role',
      ),
      testPool.query<{ database: string; role: string }>(
        'select current_database() as database, current_user as role',
      ),
    ]);

    expect(application.rows[0]).toEqual({ database: 'resume_opt_dev', role: 'resume_opt_app' });
    expect(migration.rows[0]).toEqual({
      database: 'resume_opt_dev',
      role: 'resume_opt_migrator',
    });
    expect(test.rows[0]).toEqual({ database: 'resume_opt_test', role: 'resume_opt_test' });
  });

  it('reports readiness without leaking connection details', async () => {
    await expect(checkDatabaseReadiness(applicationPool)).resolves.toBe(true);
  });

  it('does not allow the application role to create schema objects', async () => {
    await expect(
      applicationPool.query('create table forbidden_by_app(id integer)'),
    ).rejects.toThrow();
  });
});
