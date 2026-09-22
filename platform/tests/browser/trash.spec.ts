import { expect, test } from '@playwright/test';

test('最近删除空状态不提供正文预览或永久删除', async ({ page }, testInfo) => {
  await page.route('**/api/v1/resumes/trash?**', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ data: { items: [], nextCursor: null } }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.goto('/resumes/trash');

  await expect(page.getByRole('heading', { name: '最近删除为空' })).toBeVisible();
  await expect(page.getByText(/永久删除|正文预览/u)).toHaveCount(0);
  await page.screenshot({ fullPage: true, path: testInfo.outputPath('trash-empty.png') });
});

test('另一标签页删除后停止旧 pending，恢复后手动重试进入基线冲突', async ({
  context,
  page,
}, testInfo) => {
  const suffix = String(Date.now());
  const title = `删除恢复验收-${suffix}`;
  const localName = `未同步修改-${suffix}`;

  await page.goto('/resumes/new');
  await page.getByRole('textbox', { name: '简历名称' }).fill(title);
  await page.getByRole('button', { name: /创建并进入编辑器/u }).click();
  await expect(page).toHaveURL(/\/resumes\/[0-9a-f-]+\/edit$/u);
  const resumeId = new URL(page.url()).pathname.split('/')[2];
  if (!resumeId) throw new Error('创建后缺少简历 ID');

  let saveCount = 0;
  let releaseFirstSave: (() => void) | undefined;
  let notifyFirstSave: (() => void) | undefined;
  const firstSaveStarted = new Promise<void>((resolve) => {
    notifyFirstSave = resolve;
  });
  const firstSaveReleased = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  await page.route(`**/api/v1/resumes/${resumeId}/document`, async (route) => {
    saveCount += 1;
    if (saveCount === 1) {
      notifyFirstSave?.();
      await firstSaveReleased;
      await route.abort().catch(() => undefined);
      return;
    }
    await route.continue();
  });

  const workbench = await context.newPage();
  await workbench.goto('/resumes');
  const card = workbench
    .locator('article')
    .filter({ has: workbench.getByRole('link', { exact: true, name: title }) });
  await expect(card).toBeVisible();

  await page.getByRole('textbox', { exact: true, name: '姓名' }).fill(localName);
  await firstSaveStarted;
  await card.getByRole('button', { name: '删除' }).click();
  await workbench.getByRole('button', { name: '确认删除' }).click();
  await expect(card).toHaveCount(0);
  releaseFirstSave?.();

  const deletedNotice = page.getByRole('alert', { name: '简历删除通知' });
  await expect(deletedNotice).toContainText('已停止上传');
  await expect(deletedNotice.getByRole('button', { name: '导出救援副本' })).toBeVisible();
  const countAfterDelete = saveCount;

  await workbench.goto('/resumes/trash');
  const trashCard = workbench.locator('article').filter({ hasText: title });
  await expect(trashCard).toBeVisible();
  const trashResponse = await workbench.request.get('/api/v1/resumes/trash?limit=20');
  const trashPayload = (await trashResponse.json()) as {
    data: { items: Array<Record<string, unknown>> };
  };
  const deletedMeta = trashPayload.data.items.find((item) => item.id === resumeId);
  expect(deletedMeta).toBeTruthy();
  expect(deletedMeta).not.toHaveProperty('document');
  await workbench.screenshot({ fullPage: true, path: testInfo.outputPath('trash-list.png') });

  await trashCard.getByRole('button', { name: '恢复' }).click();
  await expect(trashCard).toHaveCount(0);
  await workbench.waitForTimeout(1_000);
  expect(saveCount).toBe(countAfterDelete);

  await deletedNotice.getByRole('button', { name: '恢复后重新检查' }).click();
  await expect(page.getByRole('heading', { name: '检测到服务器版本冲突' })).toBeVisible();
  expect(saveCount).toBe(countAfterDelete + 1);

  await workbench.goto('/resumes');
  const restoredCard = workbench
    .locator('article')
    .filter({ has: workbench.getByRole('link', { exact: true, name: title }) });
  await restoredCard.getByRole('button', { name: '删除' }).click();
  await workbench.getByRole('button', { name: '确认删除' }).click();
  await expect(restoredCard).toHaveCount(0);
});
