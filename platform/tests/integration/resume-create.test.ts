import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CreateResume,
  IdempotencyKeyReusedError,
  type CreateResumeInput,
} from '@resume/application';
import { parseDatabaseToolConfig, parseServerRuntimeConfig } from '@resume/config/server';
import { ResumeDocumentV1Schema, type ResumeDocumentV1 } from '@resume/domain/resume';
import { FixedIdentityProvider } from '@resume/infrastructure/fixed-identity';
import { runMigrations } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import { PostgresUserTransactionManager } from '@resume/infrastructure/resume-transactions';

const config = parseServerRuntimeConfig({ ...process.env, APP_ENV: 'test' });
const migration = parseDatabaseToolConfig({ ...process.env, APP_ENV: 'test' }, 'migration');
const schema = `create_${randomUUID().replaceAll('-', '')}`;
const migrationsDirectory = resolve(import.meta.dirname, '../../database/migrations');
const migrationPool = createPostgresPool({
  connectionString: migration.connectionString,
  max: 1,
  applicationName: 'resume-opt-create-migration-test',
});
const applicationPool = createPostgresPool({
  connectionString: config.PG_DEV_URL,
  max: 6,
  applicationName: 'resume-opt-create-app-test',
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
     values ('ats-basic', '1.0.0', '1.0.0', '{}'::jsonb, 'create-fixture', 'published')`,
  );
});

afterAll(async () => {
  if (schemaCreated && /^create_[a-f0-9]{32}$/u.test(schema)) {
    await migrationPool.query(`drop schema "${schema}" cascade`);
  }
  await Promise.all([migrationPool.end(), applicationPool.end()]);
});

async function addUser() {
  const userId = randomUUID();
  await migrationPool.query(
    `insert into "${schema}".users(id, status, display_name) values ($1, 'active', '创建测试用户')`,
    [userId],
  );
  return userId;
}

function useCase(userId: string) {
  return new CreateResume(
    new FixedIdentityProvider({ appEnvironment: 'test', userId }),
    new PostgresUserTransactionManager(applicationPool, schema),
  );
}

function input(overrides: Partial<CreateResumeInput> = {}): CreateResumeInput {
  return {
    idempotencyKey: randomUUID(),
    title: '  新建简历  ',
    stage: 'student',
    mode: 'blank',
    traceId: randomUUID(),
    ...overrides,
  };
}

describe('PostgreSQL resume creation transaction', () => {
  it.each([
    ['blank', 'student'],
    ['basic-template', 'employed'],
  ] as const)(
    'atomically creates one empty %s resume and its three supporting records',
    async (mode, stage) => {
      const userId = await addUser();
      const result = await useCase(userId).execute(input({ mode, stage }));
      const records = await migrationPool.query<{
        user_id: string;
        title: string;
        document: ResumeDocumentV1;
        revision: string;
        version_count: number;
        receipt_count: number;
        audit_count: number;
        initial_count: number;
      }>(
        `select r.user_id, r.title, r.document, r.revision::text,
              (select count(*)::int from "${schema}".resume_versions v where v.resume_id = r.id) as version_count,
              (select count(*)::int from "${schema}".idempotency_requests i where i.user_id = r.user_id and i.operation = 'resume.create') as receipt_count,
              (select count(*)::int from "${schema}".audit_events a where a.resource_id = r.id and a.action = 'resume.create') as audit_count,
              (select count(*)::int from "${schema}".resume_versions v where v.resume_id = r.id and v.reason = 'initial') as initial_count
         from "${schema}".resumes r where r.id = $1`,
        [result.resume.id],
      );
      const row = records.rows[0];
      expect(row).toMatchObject({
        user_id: userId,
        title: '新建简历',
        document: result.resume.document,
        revision: '1',
        version_count: 1,
        receipt_count: 1,
        audit_count: 1,
        initial_count: 1,
      });
      expect(ResumeDocumentV1Schema.safeParse(row?.document).success).toBe(true);
      expect(row?.document.stage).toBe(stage);
      expect(JSON.stringify(row?.document)).not.toMatch(/张三|示例大学|示例公司/u);
    },
  );

  it('serializes concurrent retries to one new UUID and rejects a changed body for the same key', async () => {
    const userId = await addUser();
    const command = input({ mode: 'basic-template', stage: 'transition' });
    const [first, second] = await Promise.all([
      useCase(userId).execute(command),
      useCase(userId).execute({ ...command, traceId: randomUUID() }),
    ]);

    expect(first.resume.id).toBe(second.resume.id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    await expect(
      useCase(userId).execute({ ...command, title: '不同请求', traceId: randomUUID() }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    const counts = await migrationPool.query<{ resumes: number; versions: number }>(
      `select count(*)::int as resumes,
              (select count(*)::int from "${schema}".resume_versions v where v.user_id = $1) as versions
         from "${schema}".resumes r where r.user_id = $1`,
      [userId],
    );
    expect(counts.rows[0]).toEqual({ resumes: 1, versions: 1 });
  });

  it('rolls back resume, version, receipt and audit together, then accepts the original key', async () => {
    const userId = await addUser();
    const command = input();
    await migrationPool.query(
      `create function "${schema}".reject_initial_version() returns trigger language plpgsql as $$
         begin
           if new.reason = 'initial' then raise exception 'injected initial version failure'; end if;
           return new;
         end $$;
       create trigger reject_initial_version before insert on "${schema}".resume_versions
       for each row execute function "${schema}".reject_initial_version()`,
    );
    try {
      await expect(useCase(userId).execute(command)).rejects.toThrow(
        'injected initial version failure',
      );
    } finally {
      await migrationPool.query(
        `drop trigger reject_initial_version on "${schema}".resume_versions`,
      );
      await migrationPool.query(`drop function "${schema}".reject_initial_version()`);
    }
    const rolledBack = await migrationPool.query<{
      resumes: number;
      versions: number;
      receipts: number;
      audits: number;
    }>(
      `select
         (select count(*)::int from "${schema}".resumes where user_id = $1) as resumes,
         (select count(*)::int from "${schema}".resume_versions where user_id = $1) as versions,
         (select count(*)::int from "${schema}".idempotency_requests where user_id = $1) as receipts,
         (select count(*)::int from "${schema}".audit_events where actor_user_id = $1) as audits`,
      [userId],
    );
    expect(rolledBack.rows[0]).toEqual({ resumes: 0, versions: 0, receipts: 0, audits: 0 });
    await expect(useCase(userId).execute(command)).resolves.toMatchObject({
      resume: { revision: '1' },
      replayed: false,
    });
  });
});
