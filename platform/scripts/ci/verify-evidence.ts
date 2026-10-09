import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const requiredReportPaths = [
  'provisioning.json',
  'performance.json',
  'restore.json',
  'native-restore.json',
  'browser-indexeddb.json',
  'real-auth-browser-matrix.json',
  'real-session-performance.json',
  'playwright-fixed.json',
  'playwright-auth.json',
  'auth-pages/keyboard.json',
  'auth-pages/short-viewport.json',
  'accessibility/axe.json',
  'accessibility/zoom-200.json',
  'accessibility/keyboard-real-auth.json',
  'editor-layout/geometry.json',
  'editor-rails/geometry.json',
  'editor-pagination/pagination.json',
] as const;

const trackedEvidencePaths = [
  'docs/evidence/v0.2-accessibility-acceptance.md',
  'docs/evidence/v0.2-security-acceptance.md',
  'docs/runbooks/v0.2-operational-security.md',
] as const;

const phaseNames = ['quality', 'fixture', 'fixedBrowser', 'authBrowser', 'nativeRestore'] as const;

type PhaseName = (typeof phaseNames)[number];
type PhaseOutcomes = Record<PhaseName, string>;
type EvidenceReports = Partial<Record<(typeof requiredReportPaths)[number], unknown>>;

const phaseEnvironmentNames: Record<PhaseName, string> = {
  quality: 'EVIDENCE_QUALITY_OUTCOME',
  fixture: 'EVIDENCE_FIXTURE_OUTCOME',
  fixedBrowser: 'EVIDENCE_FIXED_BROWSER_OUTCOME',
  authBrowser: 'EVIDENCE_AUTH_BROWSER_OUTCOME',
  nativeRestore: 'EVIDENCE_NATIVE_RESTORE_OUTCOME',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePlaywrightReport(
  report: unknown,
  path: 'playwright-fixed.json' | 'playwright-auth.json',
  expectedScope: string,
  expectedProject: string,
): string[] {
  if (!isRecord(report)) return [`${path} 不是有效对象`];
  const errors: string[] = [];
  const counts = report.counts;
  const tests = report.tests;
  if (report.scope !== expectedScope) errors.push(`${path} scope 不匹配`);
  if (report.passed !== true) errors.push(`${path} 未通过`);
  if (!isRecord(counts)) {
    errors.push(`${path} 缺少 counts`);
  } else {
    const expected = counts.expected;
    if (typeof expected !== 'number' || expected <= 0) errors.push(`${path} 没有测试项目`);
    if (counts.completed !== expected) errors.push(`${path} 存在未执行项目`);
    if (counts.passed !== expected) errors.push(`${path} 存在未通过项目`);
    for (const name of ['failed', 'timedOut', 'skipped', 'interrupted', 'notRun', 'retried']) {
      if (counts[name] !== 0) errors.push(`${path} ${name} 必须为 0`);
    }
  }
  if (!Array.isArray(tests)) {
    errors.push(`${path} 缺少测试明细`);
  } else {
    if (isRecord(counts) && tests.length !== counts.expected) {
      errors.push(`${path} 测试明细不完整`);
    }
    if (
      tests.some(
        (test) =>
          !isRecord(test) ||
          test.project !== expectedProject ||
          !Array.isArray(test.attempts) ||
          test.attempts.length !== 1 ||
          !isRecord(test.attempts[0]) ||
          test.attempts[0].status !== 'passed',
      )
    ) {
      errors.push(`${path} 项目身份、尝试次数或最终状态不完整`);
    }
  }
  return errors;
}

export function validateVerificationEvidence(input: {
  phaseOutcomes: PhaseOutcomes;
  reports: EvidenceReports;
}): string[] {
  const errors: string[] = [];

  for (const phase of phaseNames) {
    if (input.phaseOutcomes[phase] !== 'success') {
      errors.push(`CI 阶段 ${phase} 结果为 ${input.phaseOutcomes[phase] || 'missing'}`);
    }
  }
  for (const path of requiredReportPaths) {
    if (!(path in input.reports)) {
      errors.push(`缺少必需报告 ${path}`);
      continue;
    }
    const report = input.reports[path];
    if (!isRecord(report) || report.passed !== true) errors.push(`${path} 未通过`);
  }

  const matrixReport = input.reports['real-auth-browser-matrix.json'];
  if (isRecord(matrixReport) && isRecord(matrixReport.matrix)) {
    const matrix = matrixReport.matrix;
    const expectedIds = Array.from(
      { length: 12 },
      (_value, index) => `T${String(index + 1).padStart(2, '0')}`,
    );
    if (
      Object.keys(matrix).sort().join(',') !== expectedIds.join(',') ||
      expectedIds.some((id) => !isRecord(matrix[id]) || matrix[id].status !== 'passed')
    ) {
      errors.push('real-auth-browser-matrix.json 的 T01—T12 不完整');
    }
  } else if (matrixReport !== undefined) {
    errors.push('real-auth-browser-matrix.json 缺少矩阵');
  }

  const performanceReport = input.reports['real-session-performance.json'];
  if (
    isRecord(performanceReport) &&
    (!isRecord(performanceReport.failures) || performanceReport.failures.skipped !== 0)
  ) {
    errors.push('real-session-performance.json 存在跳过或缺少跳过计数');
  }

  errors.push(
    ...validatePlaywrightReport(
      input.reports['playwright-fixed.json'],
      'playwright-fixed.json',
      'V02-032-fixed-chrome',
      'fixed-chrome',
    ),
    ...validatePlaywrightReport(
      input.reports['playwright-auth.json'],
      'playwright-auth.json',
      'V02-032-real-auth-chrome',
      'real-auth-chrome',
    ),
  );
  return [...new Set(errors)];
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    }),
  );
  return files.flat();
}

async function hashFile(path: string): Promise<string> {
  return sha256(await readFile(path));
}

export function inventoryDigest(entries: Array<{ path: string; sha256: string }>): string {
  return sha256(
    [...entries]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => `${entry.path}:${entry.sha256}`)
      .join('\n'),
  );
}

async function main(): Promise<void> {
  const evidenceDirectory = resolve('artifacts/ci');
  const manifestPath = resolve(evidenceDirectory, 'verification-manifest.json');
  const reports: EvidenceReports = {};
  const parsingErrors: string[] = [];

  for (const path of requiredReportPaths) {
    try {
      reports[path] = JSON.parse(
        await readFile(resolve(evidenceDirectory, path), 'utf8'),
      ) as unknown;
    } catch (error) {
      if (await stat(resolve(evidenceDirectory, path)).catch(() => null)) {
        parsingErrors.push(
          `${path} 无法解析：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const phaseOutcomes = Object.fromEntries(
    phaseNames.map((phase) => [phase, process.env[phaseEnvironmentNames[phase]] ?? '']),
  ) as PhaseOutcomes;
  const errors = [...validateVerificationEvidence({ phaseOutcomes, reports }), ...parsingErrors];
  const artifactFiles = (await filesBelow(evidenceDirectory)).filter(
    (path) => resolve(path) !== manifestPath,
  );
  const inventory = await Promise.all(
    artifactFiles.map(async (path) => ({
      path: relative(evidenceDirectory, path).replaceAll('\\', '/'),
      bytes: (await stat(path)).size,
      sha256: await hashFile(path),
    })),
  );
  inventory.sort((left, right) => left.path.localeCompare(right.path));

  const trackedEvidence = await Promise.all(
    trackedEvidencePaths.map(async (path) => ({ path, sha256: await hashFile(resolve(path)) })),
  );
  const migrationFiles = (await readdir(resolve('database/migrations')))
    .filter((path) => path.endsWith('.sql'))
    .sort();
  const migrationInventory = await Promise.all(
    migrationFiles.map(async (path) => ({
      path,
      sha256: await hashFile(resolve('database/migrations', path)),
    })),
  );
  const buildIdPath = resolve('apps/web/.next/BUILD_ID');
  const buildId = await readFile(buildIdPath, 'utf8').catch(() => '');
  if (!buildId) errors.push('缺少生产构建 BUILD_ID');
  const authPackage = JSON.parse(
    await readFile(resolve('packages/infrastructure/package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  const commitSha = process.env.GITHUB_SHA ?? '';
  const runId = process.env.GITHUB_RUN_ID ?? '';
  if (!/^[a-f0-9]{40}$/u.test(commitSha)) errors.push('缺少有效 GITHUB_SHA');
  if (!runId) errors.push('缺少 GITHUB_RUN_ID');

  const manifest = {
    schemaVersion: 1,
    scope: 'V02-032',
    generatedAt: new Date().toISOString(),
    commitSha,
    runId,
    executor: process.env.GITHUB_ACTOR ? `github-actions/${process.env.GITHUB_ACTOR}` : 'unknown',
    retentionDays: 30,
    phaseOutcomes,
    versions: {
      build: { id: buildId.trim(), sha256: buildId ? sha256(buildId) : '' },
      migrations: {
        latest: migrationFiles.at(-1) ?? '',
        sha256: inventoryDigest(migrationInventory),
      },
      auth: authPackage.dependencies?.['better-auth'] ?? 'missing',
    },
    trackedEvidence,
    inventory,
    inventorySha256: inventoryDigest(inventory),
    errors,
    passed: errors.length === 0,
  };

  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify({
      manifestPath,
      reportCount: inventory.length,
      errors,
      passed: manifest.passed,
    }),
  );
  if (!manifest.passed) process.exitCode = 1;
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) await main();
