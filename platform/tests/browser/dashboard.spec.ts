import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, test } from '@playwright/test';

test('工作台空状态严格保留 V0.2 范围', async ({ page }, testInfo) => {
  await page.route('**/api/v1/resumes?**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        body: JSON.stringify({ data: { items: [], nextCursor: null } }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    await route.continue();
  });

  await page.goto('/resumes');
  await expect(page.getByRole('heading', { name: '创建你的第一份简历' })).toBeVisible();
  await expect(page.getByText(/AI|会员|支付|导出 PDF|模板市场/u)).toHaveCount(0);
  await page.screenshot({ fullPage: true, path: testInfo.outputPath('dashboard-empty.png') });
});

test('账户页只呈现退出与注销所需的最小范围', async ({ page }, testInfo) => {
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: '账户与数据' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '永久注销账户' })).toBeVisible();
  await expect(page.getByText('固定开发身份不能执行账户注销。')).toBeVisible();
  await expect(page.getByText(/会员|支付|设备管理|头像上传|邮箱修改/u)).toHaveCount(0);
  await page.screenshot({ fullPage: true, path: testInfo.outputPath('account-minimal.png') });
});

test('创建、最近编辑、复制、重命名和删除形成最小闭环', async ({ page }, testInfo) => {
  const suffix = String(Date.now());
  const title = `工作台验收-${suffix}`;
  const renamedTitle = `工作台验收已改名-${suffix}`;
  const copiedTitle = `${title} 副本`;

  await page.goto('/resumes/new');
  await expect(page.getByRole('heading', { name: '创建简历' })).toBeVisible();
  await page.screenshot({ fullPage: true, path: testInfo.outputPath('create-resume.png') });
  await page.getByRole('textbox', { name: '简历名称' }).fill(title);
  await page.getByRole('radio', { name: /基础模板/u }).check();
  await page.getByRole('radio', { name: '待业' }).check();
  await page.getByRole('button', { name: /创建并进入编辑器/u }).click();
  await expect(page).toHaveURL(/\/resumes\/[0-9a-f-]+\/edit$/u);

  await page.goto('/resumes');
  const originalCard = page
    .locator('article')
    .filter({ has: page.getByRole('link', { exact: true, name: title }) });
  await expect(originalCard).toBeVisible();
  await expect(originalCard).toContainText('待业');
  await page.screenshot({ fullPage: true, path: testInfo.outputPath('dashboard-list.png') });

  await originalCard.getByRole('button', { name: '复制' }).click();
  const copiedCard = page
    .locator('article')
    .filter({ has: page.getByRole('link', { exact: true, name: copiedTitle }) });
  await expect(copiedCard).toBeVisible();

  await originalCard.getByRole('button', { name: '重命名' }).click();
  const renameDialog = page.getByRole('dialog', { name: '重命名简历' });
  await renameDialog.getByRole('textbox', { name: '简历名称' }).fill(renamedTitle);
  await renameDialog.getByRole('button', { name: '保存名称' }).click();
  await expect(
    page
      .locator('article')
      .filter({ has: page.getByRole('link', { exact: true, name: renamedTitle }) }),
  ).toBeVisible();

  for (const cardTitle of [copiedTitle, renamedTitle]) {
    const card = page
      .locator('article')
      .filter({ has: page.getByRole('link', { exact: true, name: cardTitle }) });
    await card.getByRole('button', { name: '删除' }).click();
    const deleteDialog = page.getByRole('dialog', { name: `删除“${cardTitle}”？` });
    await expect(deleteDialog).toContainText('7 天内');
    await deleteDialog.getByRole('button', { name: '确认删除' }).click();
    await expect(card).toHaveCount(0);
  }

  const evidencePath = testInfo.outputPath('dashboard-task-summary.json');
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        scope: 'V02-022',
        routes: ['/resumes', '/resumes/new', '/resumes/:id/edit'],
        actions: ['create', 'list', 'copy', 'rename', 'delete-confirm'],
        excluded: ['search', 'AI', 'membership', 'payment', 'PDF'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});
