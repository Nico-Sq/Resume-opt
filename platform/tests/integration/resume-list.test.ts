import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InvalidResumeCursorError, ListResumes, type ResumeMetaDto } from '@resume/application';
import { parseDatabaseToolConfig, parseServerRuntimeConfig } from '@resume/config/server';
import { createInitialResumeDocument } from '@resume/domain/resume';
import { FixedIdentityProvider } from '@resume/infrastructure/fixed-identity';
import { runMigrations } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import { PostgresUserTransactionManager } from '@resume/infrastructure/resume-transactions';

const config = parseServerRuntimeConfig({ ...process.env, APP_ENV: 'test' });
const migration = parseDatabaseToolConfig({ ...process.env, APP_ENV: 'test' }, 'migration');
const schema = `list_${randomUUID().replaceAll('-', '')}`;
const migrationsDirectory = resolve(import.meta.dirname, '../../database/migrations');
const migrationPool = createPostgresPool({
  connectionString: migration.connectionString,
  max: 1,
  applicationName: 'resume-opt-list-migration-test',
});
const applicationPool = createPostgresPool({
  connectionString: config.PG_DEV_URL,
  max: 4,
  applicationName: 'resume-opt-list-app-test',
});
let schemaCreated = false;

beforeAll(async () => {
  await migrationPool.query(`create schema "${schema}" authorization resume_opt_migrator`);
  schemaCreated = true;
  await migrationPool.query(`grant usage on schema "${schema}" to resume_opt_app`);
  await runMigrations(migrationPool, migrationsDirectory, schema);
  await migrationPool.query(
    `insert into "${schema}".templates
      (template_id, version, renderer_version, manifest, asset_hash, status)
     values ('ats-basic', '1.0.0', '1.0.0', '{}'::jsonb, 'list-fixture', 'published')`,
  );
});

afterAll(async () => {
  if (schemaCreated && /^list_[a-f0-9]{32}$/u.test(schema)) {
    await migrationPool.query(`drop schema "${schema}" cascade`);
  }
  await Promise.all([migrationPool.end(), applicationPool.end()]);
});

async function addUser() {
  const userId = randomUUID();
  await migrationPool.query(
    `insert into "${schema}".users(id, status, display_name) values ($1, 'active', '列表测试用户')`,
    [userId],
  );
  return userId;
}

async function addResumes(userId: string, count: number, updatedAt = new Date()) {
  const ids = Array.from({ length: count }, () => randomUUID());
  const titles = ids.map((_, index) => `简历 ${String(index + 1)}`);
  await migrationPool.query(
    `insert into "${schema}".resumes
      (id, user_id, title, document, revision, schema_version, template_id, template_version,
       created_at, updated_at)
     select seeded.id, $1, seeded.title, $4::jsonb, 1, 1, 'ats-basic', '1.0.0', $5, seeded.updated_at
       from unnest($2::uuid[], $3::text[], $6::timestamptz[])
         as seeded(id, title, updated_at)`,
    [
      userId,
      ids,
      titles,
      JSON.stringify(createInitialResumeDocument()),
      new Date('2026-09-01T00:00:00.000Z'),
      ids.map((_, index) => new Date(updatedAt.getTime() - index * 1_000)),
    ],
  );
  return ids;
}

function listFor(userId: string) {
  return new ListResumes(
    new FixedIdentityProvider({ appEnvironment: 'test', userId }),
    new PostgresUserTransactionManager(applicationPool, schema),
  );
}

async function readAll(userId: string, limit = 20) {
  const items: ResumeMetaDto[] = [];
  let cursor: string | undefined;
  do {
    const page = await listFor(userId).execute({ limit, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

describe('PostgreSQL resume metadata pagination', () => {
  it('handles empty, exactly 20 and 21-record datasets', async () => {
    const emptyUser = await addUser();
    const twentyUser = await addUser();
    const twentyOneUser = await addUser();
    await addResumes(twentyUser, 20);
    await addResumes(twentyOneUser, 21);

    await expect(listFor(emptyUser).execute()).resolves.toEqual({ items: [], nextCursor: null });
    const twenty = await listFor(twentyUser).execute();
    const twentyOne = await listFor(twentyOneUser).execute();
    expect(twenty.nextCursor).toBeNull();
    expect(twenty.items).toHaveLength(20);
    expect(twentyOne.items).toHaveLength(20);
    expect(twentyOne.nextCursor).toBeTypeOf('string');
    expect(await readAll(twentyOneUser)).toHaveLength(21);
  });

  it('pages 100 records without gaps or duplicates and uses id as a same-time tie-breaker', async () => {
    const hundredUser = await addUser();
    await addResumes(hundredUser, 100);
    const all = await readAll(hundredUser);
    expect(all).toHaveLength(100);
    expect(new Set(all.map((item) => item.id)).size).toBe(100);

    const tiedUser = await addUser();
    const tiedAt = new Date('2026-09-21T12:00:00.000Z');
    await addResumes(tiedUser, 3, tiedAt);
    await migrationPool.query(`update "${schema}".resumes set updated_at = $1 where user_id = $2`, [
      tiedAt,
      tiedUser,
    ]);
    const tied = await readAll(tiedUser, 1);
    expect(tied.map((item) => item.id)).toEqual(
      tied
        .map((item) => item.id)
        .sort()
        .reverse(),
    );
  });

  it('filters deleted and other-account records and rejects another account cursor', async () => {
    const owner = await addUser();
    const other = await addUser();
    const ids = await addResumes(owner, 3);
    await migrationPool.query(`update "${schema}".resumes set deleted_at = now() where id = $1`, [
      ids[1],
    ]);

    const ownerPage = await listFor(owner).execute({ limit: 1 });
    expect(await readAll(owner)).toHaveLength(2);
    await expect(listFor(other).execute()).resolves.toEqual({ items: [], nextCursor: null });
    if (!ownerPage.nextCursor) throw new Error('未生成跨账户测试游标');
    await expect(listFor(other).execute({ cursor: ownerPage.nextCursor })).rejects.toBeInstanceOf(
      InvalidResumeCursorError,
    );
  });

  it('uses the owner/updatedAt/id index for the synthetic list query', async () => {
    const userId = await addUser();
    await addResumes(userId, 100);
    const client = await applicationPool.connect();
    try {
      await client.query('begin');
      await client.query(`set local search_path to "${schema}", public`);
      await client.query("select set_config('app.user_id', $1, true)", [userId]);
      const explained = await client.query(
        `explain (format json, costs false)
         select id, title, document ->> 'locale', document ->> 'stage', revision,
                template_id, template_version, created_at, updated_at
           from resumes
          where user_id = $1 and deleted_at is null
          order by updated_at desc, id desc
          limit 21`,
        [userId],
      );
      expect(JSON.stringify(explained.rows)).toContain('resumes_user_updated_id_idx');
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
