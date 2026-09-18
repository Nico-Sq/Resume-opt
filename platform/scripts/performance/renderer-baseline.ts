import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, arch, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  applyResumeEditCommand,
  createInitialResumeDocument,
  ResumeDocumentV1Schema,
  type ContentSection,
  type ResumeDocumentV1,
} from '@resume/domain/resume';
import {
  ATS_BASIC_TEMPLATE_MANIFEST,
  createRenderFlow,
  createResumeRenderModel,
  DEFAULT_FONT_MANIFEST,
  getA4PageMetrics,
  paginateRenderFlow,
  RENDER_POLICY_V1,
  type RenderFlowBlock,
} from '@resume/resume-renderer';
import { z } from 'zod';

const MetricBudgetSchema = z.strictObject({
  unit: z.literal('ms'),
  minimumSamples: z.number().int().positive(),
  p95Max: z.number().positive(),
  p99Max: z.number().positive().optional(),
  unexpectedFailureRateMax: z.number().min(0).max(1).optional(),
  requires: z.string().optional(),
});

export const PerformanceBudgetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  productVersion: z.literal('V0.1'),
  status: z.literal('engineering-baseline'),
  description: z.string().min(1),
  metrics: z.strictObject({
    rendererProjection: MetricBudgetSchema,
    pagination: MetricBudgetSchema,
    fieldToPreview: MetricBudgetSchema,
    localDraftCommit: MetricBudgetSchema,
    saveApi: MetricBudgetSchema,
    inputToCloudAck: MetricBudgetSchema,
  }),
});

export type PerformanceBudget = z.infer<typeof PerformanceBudgetSchema>;

function deterministicIds() {
  let counter = 1;
  return () => `10000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
}

function sectionByKind<K extends ContentSection['kind']>(document: ResumeDocumentV1, kind: K) {
  const sectionValue = Object.values(document.sectionsById).find(
    (candidate): candidate is Extract<ContentSection, { kind: K }> => candidate.kind === kind,
  );
  if (!sectionValue) throw new Error(`合成文档缺少 ${kind} 模块`);
  return sectionValue;
}

export function createSyntheticBoundaryDocument(): ResumeDocumentV1 {
  const nextId = deterministicIds();
  let document = createInitialResumeDocument(nextId);
  for (let index = document.moduleOrder.length; index < 20; index += 1) {
    document = applyResumeEditCommand(
      document,
      { type: 'add-custom-section', title: `合成模块 ${String(index + 1)}` },
      { idFactory: nextId },
    );
  }

  const basicEntry = sectionByKind(document, 'basic').entries[0];
  if (!basicEntry) throw new Error('合成文档缺少基本信息条目');
  basicEntry.name = '性能测试候选人🧪';
  basicEntry.city = { value: '上海', visible: true };

  const education = sectionByKind(document, 'education');
  for (let index = 0; index < 100; index += 1) {
    education.entries.push({
      id: nextId(),
      school: `示例大学 ${String(index + 1)}`,
      major: `计算机科学与技术 e\u0301 ${String(index + 1)}`,
      degree: '本科',
      city: index % 2 === 0 ? '上海' : '北京',
      courses: ['数据结构', '操作系统', '分布式系统'],
      grade: null,
      period: { start: '2020-09', end: '2024-06', current: false },
      bullets: [
        {
          id: nextId(),
          text: `负责合成项目 ${String(index + 1)}：覆盖中文标点、emoji 🚀 与长段落；结果只用于性能测量，不包含真实用户数据。`,
        },
      ],
    });
  }
  return ResumeDocumentV1Schema.parse(document);
}

function estimateHeight(block: RenderFlowBlock): number {
  switch (block.kind) {
    case 'header':
      return 72;
    case 'section-heading':
      return 34;
    case 'entry-heading':
      return 38;
    case 'paragraph':
    case 'bullet':
      return Math.max(24, Math.ceil(block.text.length / 42) * 24);
    case 'links':
      return 24;
  }
}

export function percentile(samples: readonly number[], quantile: number): number {
  if (samples.length === 0) throw new Error('百分位计算至少需要一个样本');
  if (quantile <= 0 || quantile > 1) throw new Error('quantile 必须位于 (0, 1]');
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1] ?? sorted[sorted.length - 1] ?? 0;
}

function summarize(samples: readonly number[]) {
  return {
    samples: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    max: Math.max(...samples),
  };
}

export function assertPerfEnvironment(environment: string): void {
  if (environment === 'production') {
    throw new Error('性能基准禁止指向 production');
  }
  if (!['local', 'ci'].includes(environment)) {
    throw new Error(`renderer 基准仅允许 local 或 ci，收到 ${environment}`);
  }
}

export function runRendererBaseline(budget: PerformanceBudget, sampleCount = 100) {
  const minimumSamples = Math.max(
    budget.metrics.rendererProjection.minimumSamples,
    budget.metrics.pagination.minimumSamples,
  );
  if (sampleCount < minimumSamples) {
    throw new Error(`样本数 ${String(sampleCount)} 低于预算要求 ${String(minimumSamples)}`);
  }
  const document = createSyntheticBoundaryDocument();
  const input = {
    document,
    templateManifest: ATS_BASIC_TEMPLATE_MANIFEST,
    fontManifest: DEFAULT_FONT_MANIFEST,
    renderPolicy: RENDER_POLICY_V1,
  };
  const projectionSamples: number[] = [];
  const paginationSamples: number[] = [];
  let finalPageCount = 0;
  let finalBlockCount = 0;

  for (let index = 0; index < sampleCount + 10; index += 1) {
    const projectionStarted = performance.now();
    const model = createResumeRenderModel(input);
    const flow = createRenderFlow(model);
    const projectionElapsed = performance.now() - projectionStarted;
    const measurements = Object.fromEntries(
      flow.map((block) => [block.key, { heightPx: estimateHeight(block) }]),
    );
    const paginationStarted = performance.now();
    const pagination = paginateRenderFlow(
      flow,
      measurements,
      getA4PageMetrics(model.page).contentHeightPx,
    );
    const paginationElapsed = performance.now() - paginationStarted;
    if (!pagination.ready || pagination.issues.length > 0) {
      throw new Error(`合成文档分页失败：${JSON.stringify(pagination.issues)}`);
    }
    finalPageCount = pagination.pages.length;
    finalBlockCount = flow.length;
    if (index >= 10) {
      projectionSamples.push(projectionElapsed);
      paginationSamples.push(paginationElapsed);
    }
  }

  const rendererProjection = summarize(projectionSamples);
  const pagination = summarize(paginationSamples);
  const checks = {
    rendererProjection: rendererProjection.p95 <= budget.metrics.rendererProjection.p95Max,
    pagination: pagination.p95 <= budget.metrics.pagination.p95Max,
  };
  return {
    schemaVersion: 1,
    scope: 'renderer-and-pagination-only',
    fixture: {
      id: 'renderer-standard-v1',
      moduleCount: document.moduleOrder.length,
      entryCount: sectionByKind(document, 'education').entries.length,
      blockCount: finalBlockCount,
      pageCount: finalPageCount,
    },
    metrics: { rendererProjection, pagination },
    budgets: {
      rendererProjectionP95Max: budget.metrics.rendererProjection.p95Max,
      paginationP95Max: budget.metrics.pagination.p95Max,
    },
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const environment = argument('environment', 'local') ?? 'local';
  assertPerfEnvironment(environment);
  const budgetPath = resolve(argument('budget', 'performance-budget.json') ?? '');
  const budget = PerformanceBudgetSchema.parse(JSON.parse(await readFile(budgetPath, 'utf8')));
  const sampleCount = Number(argument('samples', '100'));
  if (!Number.isInteger(sampleCount) || sampleCount <= 0) throw new Error('samples 必须是正整数');
  const result = runRendererBaseline(budget, sampleCount);
  const timestamp = new Date().toISOString();
  const outputPath = resolve(
    argument(
      'output',
      `artifacts/local/performance/${timestamp.replaceAll(':', '-')}/renderer-baseline.json`,
    ) ?? '',
  );
  const report = {
    ...result,
    productVersion: budget.productVersion,
    environment,
    measuredAt: timestamp,
    runtime: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ outputPath, ...report }, null, 2));
  if (!result.passed) process.exitCode = 1;
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) await main();
