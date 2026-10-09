import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

interface ReporterOptions {
  outputPath: string;
  scope: string;
}

interface SanitizedTestResult {
  id: string;
  project: string;
  file: string;
  title: string;
  expectedStatus: string;
  attempts: Array<{
    attempt: number;
    status: string;
    durationMs: number;
    errorCount: number;
  }>;
}

export class SanitizedPlaywrightReporter implements Reporter {
  private readonly tests = new Map<string, SanitizedTestResult>();

  public constructor(private readonly options: ReporterOptions) {}

  public onBegin(_config: FullConfig, suite: Suite): void {
    for (const test of suite.allTests()) {
      this.tests.set(test.id, this.testSummary(test));
    }
  }

  public onTestEnd(test: TestCase, result: TestResult): void {
    const summary = this.tests.get(test.id) ?? this.testSummary(test);
    summary.attempts.push({
      attempt: result.retry + 1,
      status: result.status,
      durationMs: result.duration,
      errorCount: result.errors.length,
    });
    this.tests.set(test.id, summary);
  }

  public async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] }> {
    const tests = [...this.tests.values()].sort((left, right) => left.id.localeCompare(right.id));
    const finalStatuses = tests.map((test) => test.attempts.at(-1)?.status ?? 'not-run');
    const counts = {
      expected: tests.length,
      completed: tests.filter((test) => test.attempts.length > 0).length,
      passed: finalStatuses.filter((status) => status === 'passed').length,
      failed: finalStatuses.filter((status) => status === 'failed').length,
      timedOut: finalStatuses.filter((status) => status === 'timedOut').length,
      skipped: finalStatuses.filter((status) => status === 'skipped').length,
      interrupted: finalStatuses.filter((status) => status === 'interrupted').length,
      notRun: finalStatuses.filter((status) => status === 'not-run').length,
      retried: tests.filter((test) => test.attempts.length > 1).length,
    };
    const passed =
      result.status === 'passed' &&
      counts.expected > 0 &&
      counts.completed === counts.expected &&
      counts.passed === counts.expected &&
      counts.retried === 0;
    const outputPath = resolve(this.options.outputPath);

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          scope: this.options.scope,
          generatedAt: new Date().toISOString(),
          runnerStatus: result.status,
          counts,
          tests,
          excludes: ['stdout', 'stderr', 'attachments', 'errors', 'request data', 'credentials'],
          passed,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    return passed ? {} : { status: 'failed' };
  }

  private testSummary(test: TestCase): SanitizedTestResult {
    return {
      id: test.id,
      project: test.parent.project()?.name ?? 'unknown',
      file: relative(process.cwd(), test.location.file).replaceAll('\\', '/'),
      title: test.titlePath().slice(1).join(' > '),
      expectedStatus: test.expectedStatus,
      attempts: [],
    };
  }
}

export default SanitizedPlaywrightReporter;
