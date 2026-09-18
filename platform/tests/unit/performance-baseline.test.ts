import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertPerfEnvironment,
  createSyntheticBoundaryDocument,
  percentile,
  PerformanceBudgetSchema,
  runRendererBaseline,
} from '../../scripts/performance/renderer-baseline';

async function readBudget() {
  return PerformanceBudgetSchema.parse(
    JSON.parse(await readFile(resolve('performance-budget.json'), 'utf8')),
  );
}

describe('V0.1 renderer performance baseline', () => {
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
  });

  it('rejects production and unknown environments', () => {
    expect(() => {
      assertPerfEnvironment('production');
    }).toThrow('禁止指向 production');
    expect(() => {
      assertPerfEnvironment('staging');
    }).toThrow('仅允许 local');
    expect(() => {
      assertPerfEnvironment('local');
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
