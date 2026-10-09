import { describe, expect, it } from 'vitest';

import {
  inventoryDigest,
  requiredReportPaths,
  validateVerificationEvidence,
} from '../../scripts/ci/verify-evidence';

function playwrightReport(scope: string, project: string, count: number) {
  return {
    passed: true,
    scope,
    counts: {
      expected: count,
      completed: count,
      passed: count,
      failed: 0,
      timedOut: 0,
      skipped: 0,
      interrupted: 0,
      notRun: 0,
      retried: 0,
    },
    tests: Array.from({ length: count }, (_value, index) => ({
      project,
      attempts: [{ attempt: 1, status: 'passed' }],
      id: `${project}-${String(index)}`,
    })),
  };
}

function completeEvidence() {
  const reports: Record<string, unknown> = Object.fromEntries(
    requiredReportPaths.map((path) => [path, { passed: true }]),
  );
  reports['real-auth-browser-matrix.json'] = {
    passed: true,
    matrix: Object.fromEntries(
      Array.from({ length: 12 }, (_value, index) => [
        `T${String(index + 1).padStart(2, '0')}`,
        { status: 'passed' },
      ]),
    ),
  };
  reports['real-session-performance.json'] = { passed: true, failures: { skipped: 0 } };
  reports['playwright-fixed.json'] = playwrightReport('V02-032-fixed-chrome', 'fixed-chrome', 18);
  reports['playwright-auth.json'] = playwrightReport(
    'V02-032-real-auth-chrome',
    'real-auth-chrome',
    5,
  );
  return {
    phaseOutcomes: {
      quality: 'success',
      fixture: 'success',
      fixedBrowser: 'success',
      authBrowser: 'success',
      nativeRestore: 'success',
    },
    reports,
  };
}

describe('V0.2 verification evidence gate', () => {
  it('accepts only a complete successful matrix and produces a deterministic inventory hash', () => {
    expect(validateVerificationEvidence(completeEvidence())).toEqual([]);
    const entries = [
      { path: 'b.json', sha256: 'b' },
      { path: 'a.json', sha256: 'a' },
    ];
    expect(inventoryDigest(entries)).toBe(
      inventoryDigest([
        { path: 'a.json', sha256: 'a' },
        { path: 'b.json', sha256: 'b' },
      ]),
    );
  });

  it('rejects a missing required report', () => {
    const evidence = completeEvidence();
    delete evidence.reports['native-restore.json'];

    expect(validateVerificationEvidence(evidence)).toContain('缺少必需报告 native-restore.json');
  });

  it('rejects a failed CI phase', () => {
    const evidence = completeEvidence();
    evidence.phaseOutcomes.fixedBrowser = 'failure';

    expect(validateVerificationEvidence(evidence)).toContain('CI 阶段 fixedBrowser 结果为 failure');
  });

  it('rejects skipped or retried browser tests', () => {
    const evidence = completeEvidence();
    const report = evidence.reports['playwright-fixed.json'] as ReturnType<typeof playwrightReport>;
    report.counts.skipped = 1;
    report.counts.retried = 1;

    const errors = validateVerificationEvidence(evidence);
    expect(errors).toContain('playwright-fixed.json skipped 必须为 0');
    expect(errors).toContain('playwright-fixed.json retried 必须为 0');
  });

  it('rejects an incomplete real-auth project', () => {
    const evidence = completeEvidence();
    const report = evidence.reports['playwright-auth.json'] as ReturnType<typeof playwrightReport>;
    report.tests.pop();

    expect(validateVerificationEvidence(evidence)).toContain('playwright-auth.json 测试明细不完整');
  });
});
