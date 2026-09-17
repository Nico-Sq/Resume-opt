import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GetResumeForEditor,
  ResourceNotFoundError,
  StoredResumeInvalidError,
} from '@resume/application';
import { parseServerRuntimeConfig } from '@resume/config/server';
import { FixedIdentityProvider } from '@resume/infrastructure/fixed-identity';
import { runMigrations } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import { seedFixedResume } from '@resume/infrastructure/resume-seed';
import { PostgresUserTransactionManager } from '@resume/infrastructure/resume-transactions';

const config = parseServerRuntimeConfig({
  ...process.env,
  APP_ENV: 'test',
  AUTH_MODE: 'better-auth',
});
const schema = `bootstrap_${randomUUID().replaceAll('-', '')}`;
const migrationsDirectory = resolve(import.meta.dirname, '../../database/migrations');
const migrationPool = createPostgresPool({
  connectionString: config.PG_MIGRATION_URL,
  max: 1,
  applicationName: 'resume-opt-bootstrap-migration-test',
});
const applicationPool = createPostgresPool({
  connectionString: config.PG_DEV_URL,
  max: 2,
  applicationName: 'resume-opt-bootstrap-app-test',
});
const seed = {
  userId: '40000000-0000-4000-8000-000000000001',
  resumeId: '40000000-0000-4000-8000-000000000002',
  versionId: '40000000-0000-4000-8000-000000000003',
  schema,
};

beforeAll(async () => {
  await migrationPool.query(`create schema "${schema}" authorization resume_opt_migrator`);
  await migrationPool.query(`grant usage on schema "${schema}" to resume_opt_app`);
  await runMigrations(migrationPool, migrationsDirectory, schema);
});

afterAll(async () => {
  if (/^bootstrap_[a-f0-9]{32}$/u.test(schema)) {
    await migrationPool.query(`drop schema "${schema}" cascade`);
  }
  await Promise.all([migrationPool.end(), applicationPool.end()]);
});

function useCaseFor(userId: string) {
  return new GetResumeForEditor(
    new FixedIdentityProvider({ appEnvironment: 'test', userId }),
    new PostgresUserTransactionManager(applicationPool, schema),
  );
}

describe('fixed editor bootstrap', () => {
  it('creates the fixed resume once and preserves it on repeated seed', async () => {
    const first = await seedFixedResume(migrationPool, seed);
    const second = await seedFixedResume(migrationPool, seed);

    expect(first).toEqual({ created: true, revision: '1' });
    expect(second).toEqual({ created: false, revision: '1' });
  });

  it('reads the seeded resume through the application role and validated document contract', async () => {
    const result = await useCaseFor(seed.userId).execute(seed.resumeId);

    expect(result.id).toBe(seed.resumeId);
    expect(result.revision).toBe('1');
    expect(result.document.schemaVersion).toBe(1);
  });

  it('returns the same 404 class for another owner and a missing resource', async () => {
    const otherUser = '40000000-0000-4000-8000-000000000099';
    await migrationPool.query(
      `insert into "${schema}".users(id, status, display_name)
       values ($1, 'active', '其他用户')`,
      [otherUser],
    );

    await expect(useCaseFor(otherUser).execute(seed.resumeId)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
    await expect(useCaseFor(seed.userId).execute(randomUUID())).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it('rejects corrupted stored content without returning it to the editor', async () => {
    await migrationPool.query(
      `update "${schema}".resumes set document = '{"schemaVersion":99}'::jsonb where id = $1`,
      [seed.resumeId],
    );

    await expect(useCaseFor(seed.userId).execute(seed.resumeId)).rejects.toBeInstanceOf(
      StoredResumeInvalidError,
    );
  });
});
