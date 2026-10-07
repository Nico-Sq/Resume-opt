import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const evidenceDirectory = resolve('artifacts/ci/auth-pages');

async function mockAuth(page: Page, signInStatus = 200) {
  await page.route('**/api/auth/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/sign-in/email')) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
      await route.fulfill({
        status: signInStatus,
        contentType: 'application/json',
        body: signInStatus === 200 ? '{}' : '{"message":"sensitive server detail"}',
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test('登录表单支持键盘、真实等待态和通用失败反馈', async ({ page }) => {
  await mkdir(evidenceDirectory, { recursive: true });
  await mockAuth(page, 401);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login?returnTo=%2Fresumes');

  const email = page.getByRole('textbox', { name: '邮箱' });
  const password = page.getByLabel('密码');
  await email.focus();
  await page.keyboard.press('Tab');
  expect(await password.evaluate((element) => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Tab');
  expect(
    await page
      .getByRole('checkbox', { name: '记住登录状态' })
      .evaluate((element) => element === document.activeElement),
  ).toBe(true);

  await email.fill('user@example.cn');
  await password.fill('Strong-password-123');
  await password.press('Enter');
  await expect(page.getByRole('button', { name: '登录中…' })).toBeDisabled();
  await expect(page.locator('p[role="alert"]')).toHaveText('邮箱或密码不正确。');
  await expect(page.getByText('sensitive server detail')).toHaveCount(0);
  await expect(password).toHaveValue('Strong-password-123');
  await page.screenshot({ path: resolve(evidenceDirectory, 'login-error-1440x900.png') });

  await writeFile(
    resolve(evidenceDirectory, 'keyboard.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        scope: 'v0.2-auth-keyboard',
        checks: {
          emailToPasswordTab: true,
          passwordToRememberMeTab: true,
          enterSubmits: true,
          pendingDisabled: true,
          genericError: true,
        },
        passed: true,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});

test('注册、验证、找回和重置在短视口保持可达', async ({ page }) => {
  await mkdir(evidenceDirectory, { recursive: true });
  await mockAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/register');

  await page.getByRole('textbox', { name: '姓名' }).fill('浏览器测试用户');
  await page.getByRole('textbox', { name: '邮箱' }).fill('browser@example.cn');
  const registerPassword = page.getByLabel('密码');
  await registerPassword.fill('Strong-password-123');
  await registerPassword.press('Enter');
  await expect(page.getByRole('status')).toContainText('请检查邮箱');
  await expect(registerPassword).toHaveValue('');
  await expect(page.getByRole('button', { name: '重新发送验证邮件' })).toBeVisible();
  const geometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
    localStorageKeys: Object.keys(localStorage),
    sessionStorageKeys: Object.keys(sessionStorage),
  }));
  expect(geometry.scrollWidth).toBe(geometry.clientWidth);
  expect(geometry.localStorageKeys).toEqual([]);
  expect(geometry.sessionStorageKeys).toEqual([]);
  await page.getByRole('button', { name: '创建账号' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '创建账号' })).toBeVisible();
  await page.screenshot({ path: resolve(evidenceDirectory, 'register-390x844.png') });

  await page.goto('/verify-email?error=TOKEN_EXPIRED');
  await expect(page.locator('p[role="alert"]')).toHaveText('验证链接无效、已过期或已使用。');

  await page.goto('/forgot-password');
  await page.getByRole('textbox', { name: '邮箱' }).fill('unknown@example.cn');
  await page.getByRole('button', { name: '发送重置链接' }).click();
  await expect(page.getByRole('status')).toHaveText('如果该邮箱已注册，重置链接将发送到该邮箱。');

  await page.goto('/reset-password?token=test-token');
  await page.getByLabel('新密码', { exact: true }).fill('New-strong-password-456');
  await page.getByLabel('确认新密码').fill('New-strong-password-456');
  await page.getByRole('button', { name: '重置密码' }).click();
  await expect(page.getByRole('status')).toHaveText('密码已重置，请使用新密码登录。');

  await page.goto('/reset-password?error=INVALID_TOKEN');
  await expect(page.locator('p[role="alert"]')).toHaveText('重置链接无效或已过期，请重新申请。');

  await writeFile(
    resolve(evidenceDirectory, 'short-viewport.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        scope: 'v0.2-auth-short-viewport',
        viewport: { width: 390, height: 844 },
        geometry,
        checks: {
          registration: true,
          expiredVerification: true,
          genericRecovery: true,
          resetSuccess: true,
          expiredReset: true,
          passwordStorageEmpty: true,
        },
        passed: true,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});

test('外站 returnTo 只能回到站内默认位置', async ({ page }, testInfo) => {
  await mockAuth(page);
  await page.goto('/login?returnTo=https%3A%2F%2Fexample.invalid%2Fsteal');
  await page.getByRole('textbox', { name: '邮箱' }).fill('user@example.cn');
  await page.getByLabel('密码').fill('Strong-password-123');
  await page.getByRole('button', { name: '登录' }).click();

  await expect(page).toHaveURL('/resumes');
  expect(new URL(page.url()).origin).toBe(new URL(String(testInfo.project.use.baseURL)).origin);
});
