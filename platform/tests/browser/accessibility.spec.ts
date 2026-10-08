import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';
import axe from 'axe-core';

const FIXED_RESUME_ID = '00000000-0000-4000-8000-000000000002';
const evidenceDirectory = resolve('artifacts/ci/accessibility');

interface AxeViolation {
  id: string;
  impact: string | null;
  targets: string[][];
}

async function auditPage(page: Page, name: string): Promise<AxeViolation[]> {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const axeRuntime = (
      window as unknown as {
        axe: {
          run: (
            context: Document,
            options: Record<string, unknown>,
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ target: string[] }>;
            }>;
          }>;
        };
      }
    ).axe;
    const results = await axeRuntime.run(document, {
      resultTypes: ['violations'],
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      },
    });
    return results.violations
      .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.map((node) => node.target),
      }));
  });
  expect(violations, `${name} 存在 serious/critical axe 违规`).toEqual([]);
  return violations;
}

async function tabTo(page: Page, target: Locator, limit = 80) {
  for (let index = 0; index < limit; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) {
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab ${String(limit)} 次后仍未到达目标`);
}

test('认证、工作台错误、编辑、回收站和账户页无严重自动无障碍违规', async ({ page }) => {
  await mkdir(evidenceDirectory, { recursive: true });
  const pages: Array<{ name: string; path: string }> = [
    { name: 'login', path: '/login' },
    { name: 'editor', path: `/resumes/${FIXED_RESUME_ID}/edit` },
    { name: 'trash', path: '/resumes/trash' },
    { name: 'account', path: '/account' },
  ];
  const results: Record<string, AxeViolation[]> = {};

  for (const target of pages) {
    await page.goto(target.path);
    await expect(page.locator('main')).toBeVisible();
    results[target.name] = await auditPage(page, target.name);
  }

  await page.route('**/api/v1/resumes?**', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'synthetic failure' } }),
      contentType: 'application/json',
      status: 503,
    });
  });
  await page.goto('/resumes');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('暂时无法加载简历');
  results.dashboardError = await auditPage(page, 'dashboard-error');

  await writeFile(
    resolve(evidenceDirectory, 'axe.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        scope: 'V02-029-axe',
        standard: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
        blockingImpacts: ['serious', 'critical'],
        pages: results,
        passed: Object.values(results).every((violations) => violations.length === 0),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});

test('390×844 页面在 200% 缩放下可滚动且关键控件可由键盘到达', async ({ context, page }) => {
  await mkdir(evidenceDirectory, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const session = await context.newCDPSession(page);
  const setZoom = () => session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });

  await page.goto('/login');
  await setZoom();
  await expect.poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(2);
  const email = page.getByRole('textbox', { name: '邮箱' });
  await tabTo(page, email);
  await expect(email).toBeFocused();
  const focusStyle = await email.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focusStyle.outlineStyle).not.toBe('none');
  expect(focusStyle.outlineWidth).not.toBe('0px');
  await page.screenshot({ path: resolve(evidenceDirectory, 'login-390x844-zoom-200.png') });

  await page.goto('/resumes');
  await setZoom();
  const create = page.getByRole('link', { name: '新建简历' });
  await tabTo(page, create);
  await create.scrollIntoViewIfNeeded();
  await expect(create).toBeVisible();
  const dashboardGeometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
    scale: window.visualViewport?.scale ?? 1,
  }));
  expect(dashboardGeometry.scrollWidth).toBe(dashboardGeometry.clientWidth);
  await page.screenshot({ path: resolve(evidenceDirectory, 'dashboard-390x844-zoom-200.png') });

  await page.goto(`/resumes/${FIXED_RESUME_ID}/edit`);
  await setZoom();
  const preview = page.getByRole('region', { name: 'A4 简历预览' });
  await expect(preview).toBeVisible();
  const contentToggle = page.getByRole('button', { name: '基本信息', exact: true });
  await tabTo(page, contentToggle);
  await page.keyboard.press('Enter');
  const nameField = page.getByRole('textbox', { name: '姓名', exact: true });
  await nameField.scrollIntoViewIfNeeded();
  await expect(nameField).toBeVisible();
  await page.screenshot({ path: resolve(evidenceDirectory, 'editor-390x844-zoom-200.png') });

  await writeFile(
    resolve(evidenceDirectory, 'zoom-200.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        scope: 'V02-029-zoom-200',
        viewport: { width: 390, height: 844 },
        pageScaleFactor: 2,
        dashboardGeometry,
        checks: {
          visibleKeyboardFocus: true,
          dashboardCreateReachable: true,
          editorPanelKeyboardReachable: true,
          editorFieldReachable: true,
        },
        passed: true,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});
