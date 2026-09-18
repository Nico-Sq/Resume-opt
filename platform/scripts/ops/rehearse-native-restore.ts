import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';

import { runMigrations } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';

import {
  captureSnapshot,
  quoteIdentifier,
  seedSyntheticBackupFixture,
  snapshotSummary,
  verifyTarget,
} from './rehearse-logical-restore';

type NativeRestoreMode = 'docker' | 'local';
type DatabasePool = ReturnType<typeof createPostgresPool>;

const execFileAsync = promisify(execFile);
const schemaPattern = /^native_restore_[a-f0-9]{32}$/u;
const archivePattern = /^resume-opt-native-restore-[a-f0-9]{32}\.dump$/u;

export function assertNativeRestoreEnvironment(options: {
  environment: string;
  connectionString: string;
  mode: string;
  containerId?: string;
}): asserts options is {
  environment: 'test';
  connectionString: string;
  mode: NativeRestoreMode;
  containerId?: string;
} {
  const url = new URL(options.connectionString);
  if (options.environment === 'production' || url.pathname.slice(1) !== 'resume_opt_test') {
    throw new Error('原生恢复演练只允许连接 resume_opt_test，禁止 production 或其他数据库');
  }
  if (options.environment !== 'test') {
    throw new Error(`原生恢复演练 environment 必须为 test，收到 ${options.environment}`);
  }
  if (options.mode !== 'local' && options.mode !== 'docker') {
    throw new Error(`原生恢复演练 mode 必须为 local 或 docker，收到 ${options.mode}`);
  }
  if (options.mode === 'docker' && !/^[a-f0-9]{12,64}$/u.test(options.containerId ?? '')) {
    throw new Error('docker 模式必须提供 12—64 位十六进制容器 ID');
  }
}

export function buildNativeToolCommand(options: {
  mode: NativeRestoreMode;
  containerId?: string;
  tool: 'pg_dump' | 'pg_restore' | 'sha256sum' | 'stat' | 'rm';
  args: readonly string[];
  localBinary?: string;
}): { command: string; args: string[] } {
  if (options.mode === 'docker') {
    if (!/^[a-f0-9]{12,64}$/u.test(options.containerId ?? '')) {
      throw new Error('不安全的 PostgreSQL 容器 ID');
    }
    return {
      command: 'docker',
      args: ['exec', options.containerId ?? '', options.tool, ...options.args],
    };
  }
  if (!options.localBinary) throw new Error(`local 模式缺少 ${options.tool} 可执行文件`);
  return { command: options.localBinary, args: [...options.args] };
}

async function execute(command: string, args: readonly string[], environment = process.env) {
  try {
    const result = await execFileAsync(command, [...args], {
      encoding: 'utf8',
      env: environment,
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`原生 PostgreSQL 工具执行失败：${command} ${args[0] ?? ''}；${String(error)}`);
  }
}

async function runTool(
  mode: NativeRestoreMode,
  containerId: string | undefined,
  tool: 'pg_dump' | 'pg_restore' | 'sha256sum' | 'stat' | 'rm',
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
) {
  const binaryByTool: Record<typeof tool, string> = {
    pg_dump: process.env.PG_DUMP_BIN ?? 'pg_dump',
    pg_restore: process.env.PG_RESTORE_BIN ?? 'pg_restore',
    sha256sum: 'sha256sum',
    stat: 'stat',
    rm: 'rm',
  };
  const invocation = buildNativeToolCommand({
    mode,
    ...(containerId ? { containerId } : {}),
    tool,
    args,
    localBinary: binaryByTool[tool],
  });
  return execute(invocation.command, invocation.args, environment);
}

async function countApplicationGrants(pool: DatabasePool, schema: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `select count(*)::integer as count
       from information_schema.role_table_grants
      where table_schema = $1 and grantee = 'resume_opt_app'`,
    [schema],
  );
  return result.rows[0]?.count ?? 0;
}

function localConnectionArguments(url: URL): string[] {
  return [
    '--host',
    url.hostname,
    '--port',
    url.port || '5432',
    '--username',
    decodeURIComponent(url.username),
    '--dbname',
    url.pathname.slice(1),
  ];
}

export async function rehearseNativeRestore(options: {
  connectionString: string;
  environment: string;
  mode: string;
  containerId?: string;
  migrationsDirectory: string;
}) {
  assertNativeRestoreEnvironment(options);
  const runId = randomUUID().replaceAll('-', '');
  const schema = `native_restore_${runId}`;
  const archiveName = `resume-opt-native-restore-${runId}.dump`;
  if (!schemaPattern.test(schema) || !archivePattern.test(archiveName)) {
    throw new Error('原生恢复演练生成了不安全的资源名');
  }

  const pool = createPostgresPool({
    connectionString: options.connectionString,
    max: 2,
    applicationName: `resume-opt-native-restore-${runId.slice(0, 8)}`,
  });
  const url = new URL(options.connectionString);
  const localDirectory =
    options.mode === 'local'
      ? await mkdtemp(resolve(tmpdir(), 'resume-opt-native-restore-'))
      : undefined;
  const archivePath =
    options.mode === 'docker' ? `/tmp/${archiveName}` : resolve(localDirectory ?? '', archiveName);
  let archiveCreated = false;

  try {
    await pool.query(`create schema ${quoteIdentifier(schema)} authorization resume_opt_test`);
    await runMigrations(pool, options.migrationsDirectory, schema);
    await seedSyntheticBackupFixture(pool, schema);
    const expectedSnapshot = await captureSnapshot(pool, schema);
    const expectedSummary = snapshotSummary(expectedSnapshot);
    const expectedGrantCount = await countApplicationGrants(pool, schema);

    const sharedArguments =
      options.mode === 'local'
        ? localConnectionArguments(url)
        : ['--username', decodeURIComponent(url.username), '--dbname', url.pathname.slice(1)];
    const toolEnvironment =
      options.mode === 'local'
        ? { ...process.env, PGPASSWORD: decodeURIComponent(url.password) }
        : process.env;
    const pgDumpVersion = await runTool(
      options.mode,
      options.containerId,
      'pg_dump',
      ['--version'],
      toolEnvironment,
    );
    const pgRestoreVersion = await runTool(
      options.mode,
      options.containerId,
      'pg_restore',
      ['--version'],
      toolEnvironment,
    );

    const backupStarted = performance.now();
    await runTool(
      options.mode,
      options.containerId,
      'pg_dump',
      [
        ...sharedArguments,
        '--format=custom',
        '--no-owner',
        `--schema=${schema}`,
        `--file=${archivePath}`,
      ],
      toolEnvironment,
    );
    const backupDurationMs = performance.now() - backupStarted;
    archiveCreated = true;

    let archiveSha256: string;
    let archiveSizeBytes: number;
    if (options.mode === 'docker') {
      const hashOutput = await runTool(options.mode, options.containerId, 'sha256sum', [
        archivePath,
      ]);
      archiveSha256 = hashOutput.split(/\s+/u)[0] ?? '';
      archiveSizeBytes = Number(
        await runTool(options.mode, options.containerId, 'stat', ['--format=%s', archivePath]),
      );
    } else {
      const archive = await readFile(archivePath);
      archiveSha256 = createHash('sha256').update(archive).digest('hex');
      archiveSizeBytes = (await stat(archivePath)).size;
    }
    if (!/^[a-f0-9]{64}$/u.test(archiveSha256) || !Number.isSafeInteger(archiveSizeBytes)) {
      throw new Error('无法生成有效的原生归档摘要');
    }

    const restoreStarted = performance.now();
    await pool.query(`drop schema ${quoteIdentifier(schema)} cascade`);
    await runTool(
      options.mode,
      options.containerId,
      'pg_restore',
      [...sharedArguments, '--exit-on-error', '--single-transaction', '--no-owner', archivePath],
      toolEnvironment,
    );
    const restoredSnapshot = await captureSnapshot(pool, schema);
    const restoredSummary = snapshotSummary(restoredSnapshot);
    const targetChecks = await verifyTarget(pool, schema);
    const restoredGrantCount = await countApplicationGrants(pool, schema);
    const actualRtoMs = performance.now() - restoreStarted;
    const summaryKeys = Object.keys(expectedSummary);
    const checks = {
      archiveCreated: archiveSizeBytes > 0,
      rowCountsMatch: summaryKeys.every(
        (key) => restoredSummary[key]?.rowCount === expectedSummary[key]?.rowCount,
      ),
      hashesMatch: summaryKeys.every(
        (key) => restoredSummary[key]?.sha256 === expectedSummary[key]?.sha256,
      ),
      expectedRlsPolicies: targetChecks.policyCount === 5,
      uniqueConstraintEnforced: targetChecks.duplicateRevisionRejected,
      applicationGrantsRestored:
        expectedGrantCount > 0 && restoredGrantCount === expectedGrantCount,
    };

    return {
      schemaVersion: 1,
      runId,
      mode: 'native-pg-custom-archive',
      environment: options.environment,
      archive: {
        format: 'custom',
        sha256: archiveSha256,
        sizeBytes: archiveSizeBytes,
        pgDumpVersion,
        pgRestoreVersion,
      },
      backupDurationMs,
      actualRtoMs,
      expectedSummary,
      restoredSummary,
      checks,
      passed: Object.values(checks).every(Boolean),
      limitations: [
        '仅使用合成数据和随机隔离 schema，不包含用户真实数据',
        '验证 pg_dump/pg_restore 自定义归档，不替代 WAL 连续性或托管 PITR',
        '未覆盖备份加密、跨主机恢复、对象存储、真实生产 RPO/RTO 或故障审批',
      ],
    };
  } finally {
    if (schemaPattern.test(schema)) {
      await pool.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
    }
    await pool.end();
    if (options.mode === 'docker') {
      if (archiveCreated) {
        await runTool(options.mode, options.containerId, 'rm', ['--', archivePath]);
      }
    } else if (localDirectory && basename(archivePath) === archiveName) {
      const { rm } = await import('node:fs/promises');
      await rm(localDirectory, { force: true, recursive: true });
    }
  }
}

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const connectionString = process.env.PG_TEST_URL;
  if (!connectionString) throw new Error('缺少 PG_TEST_URL');
  const report = await rehearseNativeRestore({
    connectionString,
    environment: argument('environment', 'test') ?? 'test',
    mode: process.env.PG_NATIVE_RESTORE_MODE ?? 'local',
    ...(process.env.PG_NATIVE_POSTGRES_CONTAINER
      ? { containerId: process.env.PG_NATIVE_POSTGRES_CONTAINER }
      : {}),
    migrationsDirectory: resolve(import.meta.dirname, '../../database/migrations'),
  });
  const outputPath = resolve(
    argument('output', `artifacts/test/restore/${report.runId}/native-restore-report.json`) ?? '',
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        outputPath,
        runId: report.runId,
        mode: report.mode,
        archive: report.archive,
        backupDurationMs: report.backupDurationMs,
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
