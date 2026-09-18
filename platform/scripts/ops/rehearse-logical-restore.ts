import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { createInitialResumeDocument } from '@resume/domain/resume';
import { runMigrations } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';

type DatabasePool = ReturnType<typeof createPostgresPool>;

const schemaPattern = /^(?:restore_(?:source|target)|native_restore)_[a-f0-9]{32}$/u;
const tables = [
  { name: 'schema_migrations', orderBy: 'name', restore: false },
  { name: 'templates', orderBy: 'template_id, version', restore: true },
  { name: 'users', orderBy: 'id', restore: true },
  { name: 'resumes', orderBy: 'id', restore: true },
  { name: 'resume_versions', orderBy: 'id', restore: true },
  {
    name: 'idempotency_requests',
    orderBy: 'user_id, operation, key',
    restore: true,
  },
  { name: 'audit_events', orderBy: 'id', restore: true },
] as const;

type TableName = (typeof tables)[number]['name'];
type Snapshot = Record<TableName, Array<Record<string, unknown>>>;

export function quoteIdentifier(identifier: string): string {
  if (!schemaPattern.test(identifier) && !/^[a-z_]+$/u.test(identifier)) {
    throw new Error(`不安全的数据库标识符：${identifier}`);
  }
  return `"${identifier}"`;
}

function qualified(schema: string, table: TableName): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export function assertRestoreEnvironment(environment: string, connectionString: string): void {
  const url = new URL(connectionString);
  const database = url.pathname.slice(1);
  if (environment === 'production' || database !== 'resume_opt_test') {
    throw new Error('恢复演练只允许连接 resume_opt_test，禁止 production 或其他数据库');
  }
  if (environment !== 'test')
    throw new Error(`恢复演练 environment 必须为 test，收到 ${environment}`);
}

function deterministicIds() {
  let counter = 1;
  return () => `20000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
}

export async function seedSyntheticBackupFixture(
  pool: DatabasePool,
  schema: string,
): Promise<void> {
  const nextId = deterministicIds();
  const userId = nextId();
  const resumeId = nextId();
  const versionId = nextId();
  const operationKey = nextId();
  const auditId = nextId();
  const traceId = nextId();
  const document = createInitialResumeDocument(nextId);
  const contentHash = createHash('sha256').update(JSON.stringify(document)).digest('hex');

  await pool.query(
    `insert into ${qualified(schema, 'templates')}
      (template_id, version, renderer_version, manifest, asset_hash, status)
     values ('ats-basic', '1.0.0', '1.0.0', $1::jsonb, 'synthetic-fixture', 'published')`,
    [JSON.stringify({ fixture: true })],
  );
  await pool.query(
    `insert into ${qualified(schema, 'users')}(id, status, display_name)
     values ($1, 'active', '恢复演练合成用户')`,
    [userId],
  );
  await pool.query(
    `insert into ${qualified(schema, 'resumes')}
      (id, user_id, title, document, revision, schema_version, template_id, template_version)
     values ($1, $2, '恢复演练合成简历', $3::jsonb, 1, 1, 'ats-basic', '1.0.0')`,
    [resumeId, userId, JSON.stringify(document)],
  );
  await pool.query(
    `insert into ${qualified(schema, 'resume_versions')}
      (id, resume_id, user_id, revision, title_snapshot, schema_version, template_id,
       template_version, renderer_version, snapshot, content_hash, reason)
     values ($1, $2, $3, 1, '恢复演练合成简历', 1, 'ats-basic', '1.0.0', '1.0.0',
       $4::jsonb, $5, 'initial')`,
    [versionId, resumeId, userId, JSON.stringify(document), contentHash],
  );
  await pool.query(
    `insert into ${qualified(schema, 'idempotency_requests')}
      (user_id, operation, key, request_hash, status, response_body, expires_at)
     values ($1, 'save_resume', $2, $3, 'completed', $4::jsonb, now() + interval '7 days')`,
    [userId, operationKey, contentHash, JSON.stringify({ revision: '1', versionId })],
  );
  await pool.query(
    `insert into ${qualified(schema, 'audit_events')}
      (id, actor_user_id, action, resource_type, resource_id, trace_id, result_code, metadata)
     values ($1, $2, 'resume.initialized', 'resume', $3, $4, 'ok', $5::jsonb)`,
    [auditId, userId, resumeId, traceId, JSON.stringify({ synthetic: true })],
  );
}

export async function captureSnapshot(pool: DatabasePool, schema: string): Promise<Snapshot> {
  const entries = await Promise.all(
    tables.map(async (table) => {
      const rowExpression =
        table.name === 'schema_migrations'
          ? "jsonb_build_object('name', name, 'checksum', checksum)"
          : 'to_jsonb(t)';
      const result = await pool.query<{ row: Record<string, unknown> }>(
        `select ${rowExpression} as row from ${qualified(schema, table.name)} t order by ${table.orderBy}`,
      );
      return [table.name, result.rows.map((item) => item.row)] as const;
    }),
  );
  return Object.fromEntries(entries) as Snapshot;
}

export function snapshotSummary(snapshot: Snapshot) {
  return Object.fromEntries(
    tables.map((table) => {
      const rows = snapshot[table.name];
      return [
        table.name,
        {
          rowCount: rows.length,
          sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        },
      ];
    }),
  );
}

async function restoreSnapshot(
  pool: DatabasePool,
  schema: string,
  snapshot: Snapshot,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const table of tables) {
      if (!table.restore || snapshot[table.name].length === 0) continue;
      const tableName = qualified(schema, table.name);
      await client.query(
        `insert into ${tableName}
         select * from jsonb_populate_recordset(null::${tableName}, $1::jsonb)`,
        [JSON.stringify(snapshot[table.name])],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyTarget(
  pool: DatabasePool,
  schema: string,
): Promise<{
  policyCount: number;
  duplicateRevisionRejected: boolean;
}> {
  const policyResult = await pool.query<{ count: number }>(
    'select count(*)::integer as count from pg_policies where schemaname = $1',
    [schema],
  );
  let duplicateRevisionRejected = false;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const version = await client.query<{ row: Record<string, unknown> }>(
      `select to_jsonb(t) as row from ${qualified(schema, 'resume_versions')} t limit 1`,
    );
    const duplicate = { ...version.rows[0]?.row, id: randomUUID() };
    const tableName = qualified(schema, 'resume_versions');
    await client.query(
      `insert into ${tableName}
       select * from jsonb_populate_record(null::${tableName}, $1::jsonb)`,
      [JSON.stringify(duplicate)],
    );
  } catch (error) {
    duplicateRevisionRejected =
      error !== null && typeof error === 'object' && 'code' in error && error.code === '23505';
  } finally {
    await client.query('rollback');
    client.release();
  }
  return { policyCount: policyResult.rows[0]?.count ?? 0, duplicateRevisionRejected };
}

export async function rehearseLogicalRestore(options: {
  connectionString: string;
  environment: string;
  migrationsDirectory: string;
}) {
  assertRestoreEnvironment(options.environment, options.connectionString);
  const runId = randomUUID().replaceAll('-', '');
  const sourceSchema = `restore_source_${runId}`;
  const targetSchema = `restore_target_${runId}`;
  const startedAt = new Date();
  const startedPerformance = performance.now();
  const pool = createPostgresPool({
    connectionString: options.connectionString,
    max: 2,
    applicationName: `resume-opt-restore-rehearsal-${runId.slice(0, 8)}`,
  });

  try {
    const databaseResult = await pool.query<{ database: string }>(
      'select current_database() as database',
    );
    if (databaseResult.rows[0]?.database !== 'resume_opt_test') {
      throw new Error('数据库运行时校验失败：目标不是 resume_opt_test');
    }
    await pool.query(`create schema ${quoteIdentifier(sourceSchema)}`);
    await pool.query(`create schema ${quoteIdentifier(targetSchema)}`);
    const sourceMigration = await runMigrations(pool, options.migrationsDirectory, sourceSchema);
    await seedSyntheticBackupFixture(pool, sourceSchema);
    const snapshot = await captureSnapshot(pool, sourceSchema);
    const sourceSummary = snapshotSummary(snapshot);

    const targetMigration = await runMigrations(pool, options.migrationsDirectory, targetSchema);
    await restoreSnapshot(pool, targetSchema, snapshot);
    const restoredSnapshot = await captureSnapshot(pool, targetSchema);
    const targetSummary = snapshotSummary(restoredSnapshot);
    const verification = await verifyTarget(pool, targetSchema);
    const hashesMatch = tables.every(
      (table) => sourceSummary[table.name]?.sha256 === targetSummary[table.name]?.sha256,
    );
    const rowCountsMatch = tables.every(
      (table) => sourceSummary[table.name]?.rowCount === targetSummary[table.name]?.rowCount,
    );
    const checks = {
      sourceMigrated: sourceMigration.applied.length > 0,
      targetMigrated: targetMigration.applied.length > 0,
      rowCountsMatch,
      hashesMatch,
      expectedRlsPolicies: verification.policyCount === 5,
      uniqueConstraintEnforced: verification.duplicateRevisionRejected,
    };
    return {
      schemaVersion: 1,
      runId,
      environment: options.environment,
      database: 'resume_opt_test',
      mode: 'synthetic-application-logical-snapshot',
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      actualRtoMs: performance.now() - startedPerformance,
      actualRpoSeconds: null,
      source: sourceSummary,
      target: targetSummary,
      checks,
      passed: Object.values(checks).every(Boolean),
      limitations: [
        '仅使用合成数据和随机隔离 schema',
        '未覆盖 pg_dump/pg_restore、自定义格式归档或大对象',
        '未覆盖 WAL 连续性、PITR、真实备份加密与跨主机恢复',
        '不得据此宣称生产 RPO/RTO 达标',
      ],
    };
  } finally {
    if (schemaPattern.test(sourceSchema)) {
      await pool.query(`drop schema if exists ${quoteIdentifier(sourceSchema)} cascade`);
    }
    if (schemaPattern.test(targetSchema)) {
      await pool.query(`drop schema if exists ${quoteIdentifier(targetSchema)} cascade`);
    }
    await pool.end();
  }
}

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const environment = argument('environment', 'test') ?? 'test';
  const connectionString = process.env.PG_TEST_URL;
  if (!connectionString) throw new Error('缺少 PG_TEST_URL');
  const report = await rehearseLogicalRestore({
    connectionString,
    environment,
    migrationsDirectory: resolve(import.meta.dirname, '../../database/migrations'),
  });
  const outputPath = resolve(
    argument('output', `artifacts/test/restore/${report.runId}/logical-restore-report.json`) ?? '',
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        outputPath,
        runId: report.runId,
        mode: report.mode,
        actualRtoMs: report.actualRtoMs,
        checks: report.checks,
        passed: report.passed,
        limitations: report.limitations,
      },
      null,
      2,
    ),
  );
  if (!report.passed) process.exitCode = 1;
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) await main();
