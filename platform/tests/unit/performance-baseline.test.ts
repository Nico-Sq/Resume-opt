import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertPerfEnvironment,
  createSyntheticBoundaryDocument,
  percentile,
  PerformanceBudgetSchema,
  runRendererBaseline,
  summarizePerformanceSamples,
} from '../../scripts/performance/renderer-baseline';

async function readBudget() {
  return PerformanceBudgetSchema.parse(
    JSON.parse(await readFile(resolve('performance-budget.json'), 'utf8')),
  );
}

describe('V0.2 performance budget baseline', () => {
  it('generates the declared 20-module and 100-entry synthetic fixture', () => {
    const document = createSyntheticBoundaryDocument();

    expect(document.moduleOrder).toHaveLength(20);
    const education = Object.values(document.sectionsById).find(
      (sectionValue) => sectionValue.kind === 'education',
    );
    expect(education?.entries).toHaveLength(100);
  });

  it('calculates stable nearest-rank percentiles', () => {
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(percentile([5, 1, 4, 2, 3], 0.95)).toBe(5);
    expect(() => percentile([], 0.95)).toThrow('至少需要一个样本');
    expect(summarizePerformanceSamples([5, 1, 4, 2, 3])).toEqual({
      samples: 5,
      p50: 3,
      p95: 5,
      p99: 5,
      max: 5,
    });
  });

  it('keeps every V0.1 budget and adds the approved V0.2 real-session budgets', async () => {
    const budget = await readBudget();

    expect(budget.productVersion).toBe('V0.2');
    expect(budget.metrics.saveApi).toMatchObject({
      minimumSamples: 300,
      p95Max: 500,
      p99Max: 1000,
      unexpectedFailureRateMax: 0.001,
    });
    expect(budget.metrics.inputToCloudAck).toMatchObject({ minimumSamples: 50, p95Max: 2000 });
    expect(budget.metrics.resumeListApi).toMatchObject({ minimumSamples: 300, p95Max: 300 });
    expect(budget.metrics.resumeCrudApi).toMatchObject({ minimumSamples: 300, p95Max: 500 });
    expect(budget.metrics.dashboardFirstRender).toMatchObject({
      minimumSamples: 50,
      p95Max: 1500,
    });
  });

  it('accepts isolated local/CI runs and rejects production or unknown environments', () => {
    expect(() => {
      assertPerfEnvironment('production');
    }).toThrow('禁止指向 production');
    expect(() => {
      assertPerfEnvironment('staging');
    }).toThrow('仅允许 local 或 ci');
    expect(() => {
      assertPerfEnvironment('local');
    }).not.toThrow();
    expect(() => {
      assertPerfEnvironment('ci');
    }).not.toThrow();
  });

  it('fails closed when a metric exceeds its machine-readable budget', async () => {
    const budget = await readBudget();
    const impossibleBudget = {
      ...budget,
      metrics: {
        ...budget.metrics,
        rendererProjection: { ...budget.metrics.rendererProjection, p95Max: Number.MIN_VALUE },
      },
    };

    const result = runRendererBaseline(impossibleBudget, 50);

    expect(result.checks.rendererProjection).toBe(false);
    expect(result.passed).toBe(false);
  });
});
