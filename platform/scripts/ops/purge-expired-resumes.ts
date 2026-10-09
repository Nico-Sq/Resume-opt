import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDatabaseToolConfig } from '@resume/config/server';
import { PostgresExpiredResumeCleaner } from '@resume/infrastructure/privacy-cleanup';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import { runWithOperationalAlert } from '@resume/infrastructure/operational-alert';

export interface CleanupOptions {
  environment: string;
  limit: number;
  dryRun: boolean;
  output?: string;
}

export function parseCleanupOptions(arguments_: string[]): CleanupOptions {
  const environment = arguments_.find((value) => value.startsWith('--environment='))?.split('=')[1];
  const limitValue =
    arguments_.find((value) => value.startsWith('--limit='))?.split('=')[1] ?? '50';
  const output = arguments_
    .find((value) => value.startsWith('--output='))
    ?.slice('--output='.length);
  const limit = Number(limitValue);
  if (environment !== 'test') {
    throw new Error('独立删除清单通道验收前，清理 CLI 只允许 --environment=test');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('--limit 必须是 1 到 100 的整数');
  }
  return {
    environment,
    limit,
    dryRun: arguments_.includes('--dry-run'),
    ...(output ? { output } : {}),
  };
}

export async function runCleanup(options: CleanupOptions) {
  const config = parseDatabaseToolConfig(
    { ...process.env, APP_ENV: options.environment },
    'privacy',
  );
  const pool = createPostgresPool({
    connectionString: config.connectionString,
    max: 1,
    applicationName: 'resume-opt-expired-resume-cleanup',
  });
  try {
    const cleaner = new PostgresExpiredResumeCleaner(pool);
    const report = {
      schemaVersion: 1,
      scope: 'expired-resume-cleanup',
      environment: options.environment,
      dryRun: options.dryRun,
      limit: options.limit,
      generatedAt: new Date().toISOString(),
      ...(await cleaner.run({ limit: options.limit, dryRun: options.dryRun, runId: randomUUID() })),
    };
    if (options.output) {
      const outputPath = resolve(options.output);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    return report;
  } finally {
    await pool.end();
  }
}

async function main() {
  const report = await runWithOperationalAlert({
    type: 'privacy-cleanup-failed',
    context: {
      environment: 'test',
      release: process.env.APP_RELEASE ?? 'local',
      recipient: 'invoking-operator-stderr',
    },
    operation: () => runCleanup(parseCleanupOptions(process.argv.slice(2))),
  });
  console.log(JSON.stringify(report));
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
