import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDatabaseToolConfig } from '@resume/config/server';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import { acknowledgeDeletionManifest, readDeletionManifest } from './deletion-manifest';

export function assertManifestExportEnvironment(
  environment: string,
): asserts environment is 'test' {
  if (environment !== 'test') {
    throw new Error('生产独立加密通道验收前，删除清单导出只允许 test 环境');
  }
}

export async function exportDeletionManifest(environment: string) {
  assertManifestExportEnvironment(environment);
  const config = parseDatabaseToolConfig({ ...process.env, APP_ENV: environment }, 'privacy');
  const pool = createPostgresPool({
    connectionString: config.connectionString,
    max: 1,
    applicationName: 'resume-opt-deletion-manifest-export',
  });
  try {
    const manifest = await readDeletionManifest(pool, 'public', {
      manifestId: randomUUID(),
      generatedAt: new Date().toISOString(),
    });
    const outputDirectory = resolve('artifacts/test/deletion-manifests');
    const outputPath = resolve(outputDirectory, `deletion-manifest-${manifest.manifestId}.json`);
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    const newlyMarkedCount = await acknowledgeDeletionManifest(pool, 'public', manifest);
    return {
      schemaVersion: 1,
      scope: 'synthetic-deletion-manifest-export',
      environment,
      outputPath,
      manifestId: manifest.manifestId,
      eventCount: manifest.eventCount,
      newlyMarkedCount,
      throughSequence: manifest.throughSequence,
      payloadSha256: manifest.payloadSha256,
      generatedAt: manifest.generatedAt,
      limitation: '仅限合成测试库；生产加密独立持久通道尚未验收',
    };
  } finally {
    await pool.end();
  }
}

async function main() {
  const environment =
    process.argv.find((value) => value.startsWith('--environment='))?.split('=')[1] ?? '';
  console.log(JSON.stringify(await exportDeletionManifest(environment)));
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
