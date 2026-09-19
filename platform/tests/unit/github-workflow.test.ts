import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const workflowPath = resolve(import.meta.dirname, '../../../.github/workflows/verify.yml');
const packagePath = resolve(import.meta.dirname, '../../package.json');

describe('GitHub verification workflow', () => {
  it('uses least privilege, immutable actions and an isolated PostgreSQL service', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const actionReferences = [...workflow.matchAll(/uses:\s*([^\s]+)/gu)].map(
      (match) => match[1] ?? '',
    );

    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toContain('192.168.19.200');
    expect(workflow).toContain('runs-on: ubuntu-24.04');
    expect(workflow).not.toContain('ubuntu-latest');
    expect(workflow).toContain('image: postgres:16.15-bookworm');
    expect(workflow).toContain(
      'PG_ADMIN_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres',
    );
    expect(actionReferences.length).toBeGreaterThanOrEqual(3);
    expect(actionReferences.every((reference) => /@[a-f0-9]{40}$/u.test(reference))).toBe(true);
  });

  it('provisions the database before the complete gate and preserves evidence on failure', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const provisionIndex = workflow.indexOf('pnpm ci:provision');
    const fullGateIndex = workflow.indexOf('pnpm ci:full');

    expect(provisionIndex).toBeGreaterThan(0);
    expect(fullGateIndex).toBeGreaterThan(provisionIndex);
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('path: platform/artifacts/ci');
    expect(workflow).toContain('pnpm ops:restore:native');
    expect(workflow).toContain('PG_NATIVE_RESTORE_MODE: docker');
    expect(workflow).toContain('${{ job.services.postgres.id }}');
    expect(workflow).toContain('pnpm db:seed:dev');
    expect(workflow).toContain('pnpm test:browser');
    expect(workflow).toContain('PLAYWRIGHT_CHANNEL: chrome');
  });

  it('runs every full-gate phase and labels CI performance evidence correctly', async () => {
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      scripts: Record<string, string>;
    };
    const fullGate = packageJson.scripts['ci:full'] ?? '';

    expect(packageJson.scripts['perf:baseline']).not.toContain('--environment local');
    expect(fullGate).toContain('pnpm ci:fast');
    expect(packageJson.scripts['ci:fast']).toContain('pnpm typegen');
    expect(fullGate).toContain('pnpm test:integration');
    expect(fullGate).toContain('pnpm test:save');
    expect(fullGate).toContain('--environment ci');
    expect(fullGate).toContain('pnpm ops:restore:rehearse');
    expect(fullGate).toContain('pnpm build');
    expect(packageJson.scripts['test:browser']).toContain('playwright test');
  });
});
