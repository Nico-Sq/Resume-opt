// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthPage } from '../../apps/web/src/client/auth/auth-page';
import { safeReturnTo } from '../../apps/web/src/client/auth/auth-request';

const navigate = vi.fn();

afterEach(() => {
  cleanup();
  navigate.mockReset();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('authentication pages', () => {
  it('only accepts approved same-site return locations', () => {
    expect(safeReturnTo('/')).toBe('/');
    expect(safeReturnTo('/resumes/123?tab=edit')).toBe('/resumes/123?tab=edit');
    expect(safeReturnTo('/account')).toBe('/account');
    for (const unsafe of [
      'https://example.invalid/steal',
      '//example.invalid/steal',
      'javascript:alert(1)',
      '/api/auth/get-session',
      '/login',
    ]) {
      expect(safeReturnTo(unsafe)).toBe('/resumes');
    }
  });

  it('uses native login semantics and never exposes the server error', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({ message: 'database user alice@example.cn failed' }, { status: 401 }),
        ),
      ),
    );
    render(<AuthPage mode="login" navigate={navigate} returnTo="/resumes" />);
    const email = screen.getByRole<HTMLInputElement>('textbox', { name: '邮箱' });
    const password = screen.getByLabelText<HTMLInputElement>('密码');

    expect(email.autocomplete).toBe('username');
    expect(password.autocomplete).toBe('current-password');
    await user.type(email, 'alice@example.cn');
    await user.type(password, 'Strong-password-123{Enter}');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('邮箱或密码不正确。');
    expect(document.body.textContent).not.toContain('database user');
    expect(password.value).toBe('Strong-password-123');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows a real pending state, clears the password and rejects an external returnTo', async () => {
    const user = userEvent.setup();
    let finish: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    render(<AuthPage mode="login" navigate={navigate} returnTo="https://example.invalid/steal" />);
    await user.type(screen.getByRole('textbox', { name: '邮箱' }), 'alice@example.cn');
    const password = screen.getByLabelText<HTMLInputElement>('密码');
    await user.type(password, 'Strong-password-123{Enter}');

    expect(screen.getByRole('button', { name: '登录中…' }).hasAttribute('disabled')).toBe(true);
    finish?.(new Response(null, { status: 200 }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/resumes');
    });
    expect(password.value).toBe('');
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });

  it('registers with password-manager attributes and keeps only the email for safe resend', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))),
    );
    render(<AuthPage mode="register" />);
    const name = screen.getByRole<HTMLInputElement>('textbox', { name: '姓名' });
    const email = screen.getByRole<HTMLInputElement>('textbox', { name: '邮箱' });
    const password = screen.getByLabelText<HTMLInputElement>('密码');

    expect(name.autocomplete).toBe('name');
    expect(email.autocomplete).toBe('email');
    expect(password.autocomplete).toBe('new-password');
    await user.type(name, '测试用户');
    await user.type(email, 'new@example.cn');
    await user.type(password, 'Strong-password-123{Enter}');

    expect((await screen.findByRole('status')).textContent).toContain('请检查邮箱');
    expect(password.value).toBe('');
    expect(email.value).toBe('new@example.cn');
  });

  it('uses the same visible acceptance result for password recovery', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))),
    );
    render(<AuthPage mode="forgot-password" />);
    await user.type(screen.getByRole('textbox', { name: '邮箱' }), 'unknown@example.cn{Enter}');

    expect((await screen.findByRole('status')).textContent).toContain(
      '如果该邮箱已注册，重置链接将发送到该邮箱。',
    );
  });
});
