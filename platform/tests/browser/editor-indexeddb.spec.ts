import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

const DATABASE_NAME = 'resume-opt-local-drafts-v1';
const SAMPLE_COUNT = 50;
const FIXED_RESUME_ID = '00000000-0000-4000-8000-000000000002';
const SECOND_RESUME_ID = randomUUID();

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
  const inputId = await nameInput.getAttribute('id');
  if (!inputId) throw new Error('姓名输入框缺少 id');
  await previewName.evaluate(
    (element, expected) => {
      const input = document.getElementById(expected.inputId);
      if (!(input instanceof HTMLInputElement) || !(element instanceof HTMLElement)) {
        throw new Error('性能采样目标不存在');
      }
      input.addEventListener(
        'input',
        () => {
          const startedAt = performance.now();
          const observer = new MutationObserver(() => {
            if (element.textContent !== expected.name) return;
            element.dataset.fieldToPreviewMs = String(performance.now() - startedAt);
            observer.disconnect();
          });
          observer.observe(element, { childList: true, characterData: true, subtree: true });
        },
        { once: true },
      );
    },
    { inputId, name },
  );
  const startedAt = performance.now();
  await nameInput.fill(name);
  await expect(previewName).toHaveText(name);
  const fieldToPreviewMs = Number(await previewName.getAttribute('data-field-to-preview-ms'));
  if (!Number.isFinite(fieldToPreviewMs)) throw new Error('预览性能采样失败');
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

test('动态编辑路由支持两份本人简历、刷新和后退且私有响应不缓存', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`/resumes/${FIXED_RESUME_ID}/edit$`, 'u'));
  await expect(page.getByText('张三的简历', { exact: true })).toBeVisible();

  const firstApi = await page.request.get(`/api/v1/resumes/${FIXED_RESUME_ID}`);
  expect(firstApi.status()).toBe(200);
  expect(firstApi.headers()['cache-control']).toContain('no-store');
  const secondPayload = (await firstApi.json()) as {
    data: { id: string; title: string; revision: string };
    traceId: string;
  };
  secondPayload.data.id = SECOND_RESUME_ID;
  secondPayload.data.title = '第二份测试简历';
  await page.route(`**/api/v1/resumes/${SECOND_RESUME_ID}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify(secondPayload),
      contentType: 'application/json',
      headers: { 'Cache-Control': 'private, no-store', ETag: `"${secondPayload.data.revision}"` },
      status: 200,
    });
  });

  await page.goto(`/resumes/${SECOND_RESUME_ID}/edit`);
  await expect(page.getByText('第二份测试简历', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('第二份测试简历', { exact: true })).toBeVisible();

  await page.goBack();
  await expect(page.getByText('张三的简历', { exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByText('第二份测试简历', { exact: true })).toBeVisible();

  const shell = await page.request.get(`/resumes/${SECOND_RESUME_ID}/edit`);
  expect(await shell.text()).not.toContain('第二份测试简历');
  const missingId = randomUUID();
  await page.goto(`/resumes/${missingId}/edit`);
  await expect(page.getByText('简历不存在或无权访问', { exact: true })).toBeVisible();
});

test('滚动只归属编辑器内部且普通长页面可以滚动', async ({ page }) => {
  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1280, height: 720 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
  ];
  const evidenceDirectory = resolve('artifacts/ci/editor-layout');
  const layoutEvidence: unknown[] = [];
  await mkdir(evidenceDirectory, { recursive: true });

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    if (viewport.width <= 800) {
      await expect(page.locator('aside[aria-label="内容编辑"]')).toBeHidden();
      await page.getByRole('button', { name: '基本信息', exact: true }).click();
    }

    const lastField = page.getByRole('textbox', { name: '个人简介', exact: true });
    await expect(lastField).toBeVisible();
    await lastField.scrollIntoViewIfNeeded();
    const geometry = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>('main');
      const panel = document.querySelector<HTMLElement>('aside[aria-label="内容编辑"]');
      const field = panel?.querySelector<HTMLElement>('textarea');
      if (!shell || !panel || !field) throw new Error('缺少编辑器滚动几何节点');
      const panelRect = panel.getBoundingClientRect();
      const fieldRect = field.getBoundingClientRect();
      const result = {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        document: {
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          clientHeight: document.documentElement.clientHeight,
          scrollHeight: document.documentElement.scrollHeight,
        },
        body: {
          clientHeight: document.body.clientHeight,
          scrollHeight: document.body.scrollHeight,
        },
        shell: { clientWidth: shell.clientWidth, scrollWidth: shell.scrollWidth },
        panel: { top: panelRect.top, bottom: panelRect.bottom },
        lastField: { top: fieldRect.top, bottom: fieldRect.bottom },
      };
      return {
        ...result,
        rootScrollLock: {
          bodyOverflowY: getComputedStyle(document.body).overflowY,
          htmlOverflowY: getComputedStyle(document.documentElement).overflowY,
        },
      };
    });

    layoutEvidence.push(geometry);
    await page.screenshot({
      path: resolve(evidenceDirectory, `${String(viewport.width)}x${String(viewport.height)}.png`),
    });
    expect(geometry.document.scrollWidth).toBe(geometry.document.clientWidth);
    expect(geometry.rootScrollLock.bodyOverflowY).toBe('hidden');
    expect(geometry.rootScrollLock.htmlOverflowY).toBe('hidden');
    expect(geometry.shell.scrollWidth).toBeLessThanOrEqual(geometry.shell.clientWidth);
    expect(geometry.lastField.top).toBeGreaterThanOrEqual(geometry.panel.top);
    expect(geometry.lastField.bottom).toBeLessThanOrEqual(geometry.panel.bottom);
    await page.mouse.move(8, 8);
    await page.mouse.wheel(0, 1_000);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  }

  await page.evaluate(() => {
    document.body.innerHTML =
      '<main id="ordinary-long-page" style="height: 200vh">普通长页面</main>';
  });
  const ordinaryPage = await page.evaluate(async () => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise<void>((resolveFrame) =>
      requestAnimationFrame(() => {
        resolveFrame();
      }),
    );
    return {
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      htmlOverflowY: getComputedStyle(document.documentElement).overflowY,
      clientHeight: document.documentElement.clientHeight,
      scrollHeight: document.documentElement.scrollHeight,
      scrollY: window.scrollY,
    };
  });
  expect(ordinaryPage.bodyOverflowY).not.toBe('hidden');
  expect(ordinaryPage.htmlOverflowY).not.toBe('hidden');
  expect(ordinaryPage.scrollHeight).toBeGreaterThan(ordinaryPage.clientHeight);
  expect(ordinaryPage.scrollY).toBeGreaterThan(0);
  await writeFile(
    resolve(evidenceDirectory, 'geometry.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        scope: 'v0.2-editor-scroll-ownership',
        generatedAt: new Date().toISOString(),
        viewports: layoutEvidence,
        ordinaryPage,
        passed: true,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});

test('两侧工具组在高低视口等距且保持点击目标', async ({ page }) => {
  const evidenceDirectory = resolve('artifacts/ci/editor-rails');
  const layoutEvidence: unknown[] = [];
  await mkdir(evidenceDirectory, { recursive: true });

  for (const viewport of [
    { width: 1080, height: 1920 },
    { width: 1920, height: 1080 },
    { width: 1280, height: 480 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByRole('textbox', { name: '姓名', exact: true })).toBeVisible();

    const layout = await page.evaluate((viewportValue) => {
      const railMetrics = (selector: string) => {
        const rail = document.querySelector<HTMLElement>(selector);
        if (!rail) throw new Error(`缺少侧栏：${selector}`);
        const scrollContainer = rail.querySelector<HTMLElement>('div') ?? rail;
        const buttons = [...rail.querySelectorAll<HTMLElement>('button')].filter(
          (button) => !button.hasAttribute('aria-expanded'),
        );
        const rects = buttons.map((button) => button.getBoundingClientRect());
        const first = rects[0];
        const last = rects.at(-1);
        const containerRect = scrollContainer.getBoundingClientRect();
        if (!first || !last || rects.length < 2) throw new Error(`侧栏没有足够图标：${selector}`);
        return {
          centerOffset:
            (first.top + last.bottom) / 2 - (containerRect.top + containerRect.bottom) / 2,
          clientHeight: scrollContainer.clientHeight,
          scrollHeight: scrollContainer.scrollHeight,
          buttonHeights: rects.map((rect) => rect.height),
          gaps: rects.slice(1).map((rect, index) => rect.top - (rects[index]?.bottom ?? 0)),
        };
      };

      return {
        viewport: viewportValue,
        left: railMetrics('nav[aria-label="简历模块"]'),
        right: railMetrics('nav[aria-label="编辑器工具"]'),
      };
    }, viewport);

    for (const rail of [layout.left, layout.right]) {
      for (const height of rail.buttonHeights) expect(height).toBeGreaterThanOrEqual(44);
      for (const gap of rail.gaps) expect(Math.abs(gap - 8)).toBeLessThanOrEqual(1);
      if (rail.scrollHeight <= rail.clientHeight) {
        expect(Math.abs(rail.centerOffset)).toBeLessThanOrEqual(1);
      }
    }
    for (const label of ['简历模块', '编辑器工具']) {
      const buttons = page
        .getByRole('navigation', { name: label })
        .locator('button:not([aria-expanded])');
      for (const button of [buttons.last(), buttons.first()]) {
        await button.scrollIntoViewIfNeeded();
        await expect
          .poll(() =>
            button.evaluate((node) => {
              const rail = node.closest('nav');
              if (!rail) return false;
              const railRect = rail.getBoundingClientRect();
              const buttonRect = node.getBoundingClientRect();
              return buttonRect.top >= railRect.top && buttonRect.bottom <= railRect.bottom;
            }),
          )
          .toBe(true);
      }
    }
    layoutEvidence.push(layout);
    await page.screenshot({
      path: resolve(evidenceDirectory, `${String(viewport.width)}x${String(viewport.height)}.png`),
    });
  }

  await writeFile(
    resolve(evidenceDirectory, 'geometry.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        scope: 'v0.2-editor-rail-layout',
        generatedAt: new Date().toISOString(),
        viewports: layoutEvidence,
        passed: true,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});

test('长内容增加 A4 页数且不丢字', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  const summaryInput = page.getByRole('textbox', { name: '个人简介', exact: true });
  await expect(summaryInput).toBeVisible();
  const originalSummary = await summaryInput.inputValue();
  await expect.poll(() => page.locator('.resume-page').count()).toBeGreaterThan(0);
  const originalPageCount = await page.locator('.resume-page').count();
  const longSummary = `分页起点|${Array.from(
    { length: 160 },
    (_, index) => `片段${String(index).padStart(3, '0')}🙂é中文`,
  ).join('|')}|分页终点`;
  try {
    const startedAt = performance.now();
    await summaryInput.fill(longSummary);
    await expect
      .poll(() => page.locator('.resume-page').count())
      .toBeGreaterThan(originalPageCount);
    const paginationUpdateMs = performance.now() - startedAt;
    await expect(page.getByText(/简历排版未完成/u)).toHaveCount(0);
    const evidence = await page.evaluate((expectedText) => {
      const paragraphs = [
        ...document.querySelectorAll<HTMLElement>('.resume-page .resume-paragraph'),
      ];
      const combinedText = paragraphs.map((paragraph) => paragraph.textContent).join('');
      const start = combinedText.indexOf('分页起点');
      const end = combinedText.indexOf('分页终点', start) + '分页终点'.length;
      const measurement = [
        ...document.querySelectorAll<HTMLElement>('.resume-measurement-surface .resume-paragraph'),
      ].find((element) => element.textContent.includes('分页起点'));
      const rendered = paragraphs.find((element) => element.textContent.includes('分页起点'));
      if (!measurement || !rendered || start < 0 || end < '分页终点'.length) {
        throw new Error('缺少长文本分页测量或渲染节点');
      }
      const styles = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        return {
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          width: Number.parseFloat(style.width),
        };
      };
      return {
        pageCount: document.querySelectorAll('.resume-page').length,
        reconstructedText: combinedText.slice(start, end),
        startMarkerCount: combinedText.split('分页起点').length - 1,
        endMarkerCount: combinedText.split('分页终点').length - 1,
        expectedLength: expectedText.length,
        measurementStyle: styles(measurement),
        renderedStyle: styles(rendered),
        pages: [...document.querySelectorAll<HTMLElement>('.resume-page')].map((resumePage) => ({
          clientHeight: resumePage.clientHeight,
          scrollHeight: resumePage.scrollHeight,
        })),
      };
    }, longSummary);

    expect(evidence.reconstructedText).toBe(longSummary);
    expect(evidence.startMarkerCount).toBe(1);
    expect(evidence.endMarkerCount).toBe(1);
    expect(evidence.measurementStyle.fontFamily).toBe(evidence.renderedStyle.fontFamily);
    expect(evidence.measurementStyle.fontSize).toBe(evidence.renderedStyle.fontSize);
    expect(evidence.measurementStyle.lineHeight).toBe(evidence.renderedStyle.lineHeight);
    expect(
      Math.abs(evidence.measurementStyle.width - evidence.renderedStyle.width),
    ).toBeLessThanOrEqual(0.5);
    for (const pageGeometry of evidence.pages) {
      expect(pageGeometry.scrollHeight).toBeLessThanOrEqual(pageGeometry.clientHeight + 1);
    }
    const evidenceDirectory = resolve('artifacts/ci/editor-pagination');
    await mkdir(evidenceDirectory, { recursive: true });
    await page.screenshot({ path: resolve(evidenceDirectory, 'long-content.png') });
    await writeFile(
      resolve(evidenceDirectory, 'pagination.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          scope: 'v0.2-editor-dynamic-pagination',
          generatedAt: new Date().toISOString(),
          originalPageCount,
          paginationUpdateMs: Number(paginationUpdateMs.toFixed(2)),
          ...evidence,
          reconstructedText: {
            matches: evidence.reconstructedText === longSummary,
            length: evidence.reconstructedText.length,
          },
          passed: true,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
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
