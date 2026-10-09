import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SanitizedPlaywrightReporter } from '../../scripts/ci/sanitized-playwright-reporter';

function testCase(project: string) {
  return {
    id: 'synthetic-test',
    parent: { project: () => ({ name: project }) },
    location: { file: join(process.cwd(), 'tests/browser/synthetic.spec.ts') },
    titlePath: () => ['', 'synthetic flow'],
    expectedStatus: 'passed',
  };
}

describe('sanitized Playwright reporter', () => {
  it('records attempts without serializing errors, output or attachments', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resume-opt-reporter-'));
    const outputPath = join(directory, 'report.json');
    const test = testCase('real-auth-chrome');
    const reporter = new SanitizedPlaywrightReporter({
      outputPath,
      scope: 'V02-032-real-auth-chrome',
    });

    try {
      reporter.onBegin({} as never, { allTests: () => [test] } as never);
      reporter.onTestEnd(
        test as never,
        {
          retry: 0,
          status: 'passed',
          duration: 25,
          errors: [{ message: 'secret-canary' }],
          stdout: ['secret-canary'],
          attachments: [{ body: Buffer.from('secret-canary') }],
        } as never,
      );
      await expect(reporter.onEnd({ status: 'passed' } as never)).resolves.toEqual({});

      const serialized = await readFile(outputPath, 'utf8');
      const report = JSON.parse(serialized) as { passed: boolean; counts: { passed: number } };
      expect(report.passed).toBe(true);
      expect(report.counts.passed).toBe(1);
      expect(serialized).not.toContain('secret-canary');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('turns a retry into a failed overall result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resume-opt-reporter-'));
    const test = testCase('fixed-chrome');
    const reporter = new SanitizedPlaywrightReporter({
      outputPath: join(directory, 'report.json'),
      scope: 'V02-032-fixed-chrome',
    });

    try {
      reporter.onBegin({} as never, { allTests: () => [test] } as never);
      reporter.onTestEnd(
        test as never,
        { retry: 0, status: 'failed', duration: 10, errors: [{}] } as never,
      );
      reporter.onTestEnd(
        test as never,
        { retry: 1, status: 'passed', duration: 10, errors: [] } as never,
      );

      await expect(reporter.onEnd({ status: 'passed' } as never)).resolves.toEqual({
        status: 'failed',
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
