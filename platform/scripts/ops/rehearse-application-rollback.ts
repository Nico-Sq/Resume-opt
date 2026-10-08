import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { GetResumeForEditor, RevisionConflictError, SaveResumeDocument } from '@resume/application';
import type { ResumeDocumentV1 } from '@resume/domain/resume';
import { FixedIdentityProvider } from '@resume/infrastructure/fixed-identity';
import { runMigrations } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import { seedFixedResume } from '@resume/infrastructure/resume-seed';
import { PostgresUserTransactionManager } from '@resume/infrastructure/resume-transactions';

const rollbackSchemaPattern = /^rollback_[a-f0-9]{32}$/u;

export function assertApplicationRollbackEnvironment(
  environment: string,
  migrationUrl: string,
  applicationUrl: string,
): void {
  const migration = new URL(migrationUrl);
  const application = new URL(applicationUrl);
  if (environment === 'production') throw new Error('兼容回滚演练禁止 production');
  if (!['local', 'test'].includes(environment)) throw new Error('兼容回滚演练只允许 local/test');
  if (
    migration.hostname !== application.hostname ||
    (migration.port || '5432') !== (application.port || '5432') ||
    migration.pathname !== application.pathname
  ) {
    throw new Error('迁移与应用角色必须连接同一数据库');
  }
  if (
    decodeURIComponent(migration.username) !== 'resume_opt_migrator' ||
    decodeURIComponent(application.username) !== 'resume_opt_app'
  ) {
    throw new Error('兼容回滚演练必须使用分离的迁移与应用角色');
  }
  if (migration.pathname.slice(1) !== 'resume_opt_dev') {
    throw new Error('兼容回滚演练只允许 resume_opt_dev 的随机隔离 schema');
  }
}

function quoteSchema(schema: string): string {
  if (!rollbackSchemaPattern.test(schema)) throw new Error('不安全的兼容回滚 schema');
  return `"${schema}"`;
}

function namedDocument(document: ResumeDocumentV1, name: string): ResumeDocumentV1 {
  const next = structuredClone(document);
  const basic = Object.values(next.sectionsById).find((section) => section.kind === 'basic');
  const entry = basic?.entries[0];
  if (!entry) throw new Error('兼容回滚夹具缺少基本信息');
  entry.name = name;
  return next;
}

function documentHash(document: unknown): string {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

export async function rehearseApplicationRollback(options: {
  environment: string;
  migrationUrl: string;
  applicationUrl: string;
  migrationsDirectory: string;
}) {
  assertApplicationRollbackEnvironment(
    options.environment,
    options.migrationUrl,
    options.applicationUrl,
  );
  const runId = randomUUID().replaceAll('-', '');
  const schema = `rollback_${runId}`;
  const quotedSchema = quoteSchema(schema);
  const userId = randomUUID();
  const resumeId = randomUUID();
  const migrationPool = createPostgresPool({
    connectionString: options.migrationUrl,
    max: 1,
    applicationName: `resume-opt-rollback-migration-${runId.slice(0, 8)}`,
  });
  const applicationPool = createPostgresPool({
    connectionString: options.applicationUrl,
    max: 2,
    applicationName: `resume-opt-rollback-app-${runId.slice(0, 8)}`,
  });
  const started = performance.now();

  try {
    await migrationPool.query(`create schema ${quotedSchema} authorization resume_opt_migrator`);
    await migrationPool.query(`grant usage on schema ${quotedSchema} to resume_opt_app`);
    const initialSql = await readFile(
      resolve(options.migrationsDirectory, '0001_initial.up.sql'),
      'utf8',
    );
    const initialChecksum = createHash('sha256').update(initialSql).digest('hex');
    const client = await migrationPool.connect();
    try {
      await client.query('begin');
      await client.query(`set local search_path to ${quotedSchema}, public`);
      await client.query(initialSql);
      await client.query(`create table schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`);
      await client.query('insert into schema_migrations(name, checksum) values ($1, $2)', [
        '0001_initial.up.sql',
        initialChecksum,
      ]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    await seedFixedResume(migrationPool, {
      userId,
      resumeId,
      versionId: randomUUID(),
      schema,
    });
    const before = await migrationPool.query<{
      owner_id: string;
      revision: string;
      document: unknown;
      version_count: number;
    }>(
      `select r.user_id owner_id, r.revision::text, r.document,
              (select count(*)::int from ${quotedSchema}.resume_versions v
                where v.resume_id = r.id) version_count
         from ${quotedSchema}.resumes r where r.id = $1`,
      [resumeId],
    );
    const beforeRow = before.rows[0];
    if (!beforeRow) throw new Error('V0.1 兼容夹具创建失败');
    const beforeHash = documentHash(beforeRow.document);

    const migration = await runMigrations(migrationPool, options.migrationsDirectory, schema);
    const afterUpgrade = await migrationPool.query<{
      owner_id: string;
      revision: string;
      document: unknown;
      version_count: number;
    }>(
      `select r.user_id owner_id, r.revision::text, r.document,
              (select count(*)::int from ${quotedSchema}.resume_versions v
                where v.resume_id = r.id) version_count
         from ${quotedSchema}.resumes r where r.id = $1`,
      [resumeId],
    );
    const afterUpgradeRow = afterUpgrade.rows[0];
    if (!afterUpgradeRow) throw new Error('升级后旧简历不可读');

    const identity = new FixedIdentityProvider({ appEnvironment: 'test', userId });
    const transactions = new PostgresUserTransactionManager(applicationPool, schema);
    const readUseCase = new GetResumeForEditor(identity, transactions);
    const saveUseCase = new SaveResumeDocument(identity, transactions);
    const legacyRead = await readUseCase.execute(resumeId);
    const currentWrite = await saveUseCase.execute({
      resumeId,
      document: namedDocument(legacyRead.document, '当前版本写入'),
      baseRevision: legacyRead.revision,
      clientSeq: 1,
      idempotencyKey: randomUUID(),
      traceId: randomUUID(),
    });
    const compatibleRead = await readUseCase.execute(resumeId);
    const compatibleWrite = await saveUseCase.execute({
      resumeId,
      document: namedDocument(compatibleRead.document, '兼容回滚版本写入'),
      baseRevision: compatibleRead.revision,
      clientSeq: 2,
      idempotencyKey: randomUUID(),
      traceId: randomUUID(),
    });
    let staleCasRejected = false;
    try {
      await saveUseCase.execute({
        resumeId,
        document: namedDocument(compatibleRead.document, '过期写入'),
        baseRevision: compatibleRead.revision,
        clientSeq: 3,
        idempotencyKey: randomUUID(),
        traceId: randomUUID(),
      });
    } catch (error) {
      staleCasRejected = error instanceof RevisionConflictError && error.currentRevision === '3';
    }
    const finalRead = await readUseCase.execute(resumeId);
    const roles = await migrationPool.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `select rolname, rolsuper, rolbypassrls from pg_roles
        where rolname in ('resume_opt_app', 'resume_opt_auth', 'resume_opt_privacy')
        order by rolname`,
    );
    const tableOwners = await migrationPool.query<{ tableowner: string }>(
      'select distinct tableowner from pg_tables where schemaname = $1',
      [schema],
    );
    const checks = {
      legacyOwnerHashAndRevisionPreserved:
        afterUpgradeRow.owner_id === beforeRow.owner_id &&
        afterUpgradeRow.revision === beforeRow.revision &&
        documentHash(afterUpgradeRow.document) === beforeHash &&
        afterUpgradeRow.version_count === beforeRow.version_count,
      currentApplicationWriteSucceeded:
        currentWrite.receipt.revision === '2' && !currentWrite.replayed,
      compatibleRollbackReadSucceeded: compatibleRead.revision === '2',
      compatibleRollbackWriteSucceeded:
        compatibleWrite.receipt.revision === '3' &&
        !compatibleWrite.replayed &&
        finalRead.revision === '3',
      staleCasRejected,
      runtimeRolesRemainRestricted:
        roles.rows.length === 3 &&
        roles.rows.every((role) => !role.rolsuper && !role.rolbypassrls) &&
        tableOwners.rows.every(
          (owner) =>
            !['resume_opt_app', 'resume_opt_auth', 'resume_opt_privacy'].includes(owner.tableowner),
        ),
      destructiveDownNotExecuted: true,
    };
    return {
      schemaVersion: 1,
      runId,
      environment: options.environment,
      mode: 'isolated-compatible-application-rollback',
      schemaVersions: {
        before: ['0001_initial.up.sql'],
        afterCount: migration.applied.length + migration.alreadyApplied.length,
      },
      revisions: { before: '1', currentWrite: '2', compatibleRollbackWrite: '3' },
      actualDurationMs: performance.now() - started,
      checks,
      passed: Object.values(checks).every(Boolean),
      rollbackStrategy: 'compatible application rollback or forward-fix; never production down',
      limitations: [
        '仅在随机隔离 schema 使用合成 V0.1 数据',
        '兼容路径复用冻结的 V0.1 读取、完整快照保存、CAS 和幂等合同，不执行旧二进制部署',
        '首次真实 Auth 版本没有安全旧构建时必须关闭入口并 forward-fix',
      ],
    };
  } finally {
    if (rollbackSchemaPattern.test(schema)) {
      await migrationPool.query(`drop schema if exists ${quotedSchema} cascade`);
    }
    await Promise.all([migrationPool.end(), applicationPool.end()]);
  }
}

async function main() {
  const migrationUrl = process.env.PG_MIGRATION_URL;
  const applicationUrl = process.env.PG_DEV_URL;
  if (!migrationUrl || !applicationUrl) throw new Error('兼容回滚演练缺少数据库配置');
  const report = await rehearseApplicationRollback({
    environment:
      process.argv.find((value) => value.startsWith('--environment='))?.split('=')[1] ?? '',
    migrationUrl,
    applicationUrl,
    migrationsDirectory: resolve(import.meta.dirname, '../../database/migrations'),
  });
  const outputDirectory = resolve('artifacts/test/rollback');
  const outputPath = resolve(outputDirectory, `application-rollback-${report.runId}.json`);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify({
      outputPath,
      runId: report.runId,
      actualDurationMs: report.actualDurationMs,
      checks: report.checks,
      passed: report.passed,
      limitations: report.limitations,
    }),
  );
  if (!report.passed) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
