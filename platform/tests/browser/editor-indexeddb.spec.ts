import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

const DATABASE_NAME = 'resume-opt-local-drafts-v1';
const SAMPLE_COUNT = 50;

interface BrowserSample {
  fieldToPreviewMs: number;
  localDraftCommitMs: number;
  localSeq: number;
  ackedSeq: number;
}

interface DraftSummary {
  name: string;
  summary: string;
  localSeq: number;
  ackedSeq: number;
  pending: boolean;
}

function percentile95(samples: number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

async function readDraft(page: Page): Promise<DraftSummary | null> {
  return page.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
      const request = indexedDB.open(databaseName);
      request.onerror = () => {
        reject(request.error ?? new Error('IndexedDB 打开失败'));
      };
      request.onsuccess = () => {
        resolveDatabase(request.result);
      };
    });
    try {
      const records = await new Promise<unknown[]>((resolveRecords, reject) => {
        const transaction = database.transaction('drafts', 'readonly');
        const request = transaction.objectStore('drafts').getAll();
        request.onerror = () => {
          reject(request.error ?? new Error('IndexedDB 读取失败'));
        };
        request.onsuccess = () => {
          resolveRecords(request.result as unknown[]);
        };
      });
      const record = records[0] as
        | {
            localSeq: number;
            ackedSeq: number;
            pendingEnvelope: unknown;
            workingSnapshot: {
              sectionsById: Record<
                string,
                {
                  kind: string;
                  entries: Array<{ name?: string; blocks?: Array<{ text?: string }> }>;
                }
              >;
            };
          }
        | undefined;
      if (!record) return null;
      const basic = Object.values(record.workingSnapshot.sectionsById).find(
        (section) => section.kind === 'basic',
      );
      const summary = Object.values(record.workingSnapshot.sectionsById).find(
        (section) => section.kind === 'summary',
      );
      return {
        name: basic?.entries[0]?.name ?? '',
        summary: summary?.entries[0]?.blocks?.[0]?.text ?? '',
        localSeq: record.localSeq,
        ackedSeq: record.ackedSeq,
        pending: record.pendingEnvelope !== null,
      };
    } finally {
      database.close();
    }
  }, DATABASE_NAME);
}

async function updateNameAndMeasure(nameInput: Locator, name: string): Promise<BrowserSample> {
  const page = nameInput.page();
  const previewName = page
    .getByRole('region', { name: 'A4 简历预览' })
    .getByRole('heading', { level: 1 });
  const startedAt = performance.now();
  await nameInput.fill(name);
  await expect(previewName).toHaveText(name);
  const fieldToPreviewMs = performance.now() - startedAt;
  await expect.poll(async () => (await readDraft(page))?.name, { intervals: [25] }).toBe(name);
  const draft = await readDraft(page);
  if (!draft) throw new Error('IndexedDB 草稿记录不存在');
  return {
    fieldToPreviewMs,
    localDraftCommitMs: performance.now() - startedAt,
    localSeq: draft.localSeq,
    ackedSeq: draft.ackedSeq,
  };
}

test('全屏编辑器无页面级滚动、图标组居中且长内容自动分页', async ({ page }) => {
  for (const viewport of [
    { width: 1080, height: 1920 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByRole('textbox', { name: '姓名', exact: true })).toBeVisible();

    const layout = await page.evaluate(() => {
      const railMetrics = (selector: string) => {
        const rail = document.querySelector<HTMLElement>(selector);
        if (!rail) throw new Error(`缺少侧栏：${selector}`);
        const buttons = [...rail.querySelectorAll<HTMLElement>('button')].filter(
          (button) => !button.hasAttribute('aria-expanded'),
        );
        const first = buttons[0]?.getBoundingClientRect();
        const last = buttons.at(-1)?.getBoundingClientRect();
        const railRect = rail.getBoundingClientRect();
        if (!first || !last) throw new Error(`侧栏没有图标：${selector}`);
        return {
          centerOffset: (first.top + last.bottom) / 2 - (railRect.top + railRect.bottom) / 2,
          clientWidth: rail.clientWidth,
          scrollWidth: rail.scrollWidth,
        };
      };

      return {
        viewportHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
        bodyHeight: document.body.scrollHeight,
        left: railMetrics('nav[aria-label="简历模块"]'),
        right: railMetrics('nav[aria-label="编辑器工具"]'),
      };
    });

    expect(layout.documentHeight).toBe(layout.viewportHeight);
    expect(layout.bodyHeight).toBe(layout.viewportHeight);
    expect(layout.left.scrollWidth).toBeLessThanOrEqual(layout.left.clientWidth);
    expect(layout.right.scrollWidth).toBeLessThanOrEqual(layout.right.clientWidth);
    expect(Math.abs(layout.left.centerOffset)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.right.centerOffset)).toBeLessThanOrEqual(1);
  }

  const summaryInput = page.getByRole('textbox', { name: '个人简介', exact: true });
  const originalSummary = await summaryInput.inputValue();
  await expect.poll(() => page.locator('.resume-page').count()).toBeGreaterThan(0);
  const originalPageCount = await page.locator('.resume-page').count();
  const longSummary = `分页起点${'负责复杂业务系统设计、交付与持续优化，确保关键结果可验证。'.repeat(100)}分页终点`;
  try {
    await summaryInput.fill(longSummary);
    await expect
      .poll(() => page.locator('.resume-page').count())
      .toBeGreaterThan(originalPageCount);
    await expect(page.getByRole('region', { name: 'A4 简历预览' })).toContainText('分页起点');
    await expect(page.getByRole('region', { name: 'A4 简历预览' })).toContainText('分页终点');
    await expect(page.getByText(/简历排版未完成/u)).toHaveCount(0);
  } finally {
    await summaryInput.fill(originalSummary);
    await summaryInput.press('Tab');
    await expect.poll(() => page.locator('.resume-page').count()).toBe(originalPageCount);
    await expect
      .poll(async () => {
        const draft = await readDraft(page);
        return (
          draft?.summary === originalSummary && draft.localSeq === draft.ackedSeq && !draft.pending
        );
      })
      .toBe(true);
  }
});

test('原生 Chromium 完成预览、IndexedDB、崩溃恢复与云端回读闭环', async ({ browser, page }) => {
  await page.goto('/');
  const nameInput = page.getByRole('textbox', { name: '姓名', exact: true });
  await expect(nameInput).toBeVisible();
  const originalName = await nameInput.inputValue();

  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await indexedDB.databases()).map((database) => database.name ?? ''),
      ),
    )
    .toContain(DATABASE_NAME);
  await expect.poll(async () => (await readDraft(page))?.name).toBe(originalName);

  const samples: BrowserSample[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    samples.push(
      await updateNameAndMeasure(nameInput, `浏览器验收-${String(index + 1).padStart(2, '0')}`),
    );
  }

  const fieldToPreviewP95 = percentile95(samples.map((sample) => sample.fieldToPreviewMs));
  const localDraftCommitP95 = percentile95(samples.map((sample) => sample.localDraftCommitMs));
  expect(fieldToPreviewP95).toBeLessThanOrEqual(100);
  expect(localDraftCommitP95).toBeLessThanOrEqual(400);

  await expect(page.getByText('已保存', { exact: true })).toBeVisible({ timeout: 15_000 });

  const recoveryName = `崩溃恢复-${String(Date.now())}`;
  const recoverySample = await updateNameAndMeasure(nameInput, recoveryName);
  expect(recoverySample.localSeq).toBeGreaterThan(recoverySample.ackedSeq);
  await page.reload();

  const recoveredInput = page.getByRole('textbox', { name: '姓名', exact: true });
  await expect(recoveredInput).toHaveValue(recoveryName);
  await expect(
    page.getByRole('region', { name: 'A4 简历预览' }).getByRole('heading', {
      name: recoveryName,
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.getByText('已保存', { exact: true })).toBeVisible({ timeout: 15_000 });

  await updateNameAndMeasure(recoveredInput, originalName);
  await expect(page.getByText('已保存', { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByRole('textbox', { name: '姓名', exact: true })).toHaveValue(originalName);
  const finalDraft = await readDraft(page);
  expect(finalDraft?.name).toBe(originalName);
  expect(finalDraft?.localSeq).toBe(finalDraft?.ackedSeq);
  expect(finalDraft?.pending).toBe(false);

  const evidence = {
    schemaVersion: 1,
    scope: 'v0.1-native-chromium-indexeddb',
    generatedAt: new Date().toISOString(),
    browser: {
      engine: 'chromium',
      version: browser.version(),
      channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
      headless: true,
    },
    samples: SAMPLE_COUNT,
    metrics: {
      fieldToPreview: { p95Ms: Number(fieldToPreviewP95.toFixed(2)), budgetMs: 100 },
      localDraftCommit: { p95Ms: Number(localDraftCommitP95.toFixed(2)), budgetMs: 400 },
    },
    checks: {
      nativeIndexedDbCreated: true,
      unsyncedDraftRecoveredAfterReload: true,
      recoveredDraftReachedCloudAck: true,
      finalServerReloadMatched: true,
      testDataRestored: true,
    },
    passed: true,
  };
  const evidenceDirectory = resolve('artifacts/ci');
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    resolve(evidenceDirectory, 'browser-indexeddb.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
    'utf8',
  );
});
