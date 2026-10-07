// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CreateResumePage, ResumeDashboard } from '../../apps/web/src/client/dashboard/dashboard';
import { AccountPage } from '../../apps/web/src/client/account/account-page';

const firstResume = {
  id: '11111111-1111-4111-8111-111111111111',
  title: '前端工程师简历',
  locale: 'zh-CN',
  stage: 'employed',
  revision: '1',
  templateId: 'ats-basic',
  templateVersion: '1.0.0',
  createdAt: '2026-09-22T01:00:00.000Z',
  updatedAt: '2026-09-22T02:00:00.000Z',
} as const;

const secondResume = {
  ...firstResume,
  id: '22222222-2222-4222-8222-222222222222',
  title: '前端工程师简历 副本',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('resume dashboard', () => {
  it('shows loading and the scoped empty state without future features', async () => {
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

    render(<ResumeDashboard csrfRequired={false} displayName="开发用户" userId="dev-user" />);
    expect(screen.getByRole('region', { name: '正在加载简历' }).getAttribute('aria-busy')).toBe(
      'true',
    );
    finish?.(Response.json({ data: { items: [], nextCursor: null } }));

    expect(await screen.findByRole('heading', { name: '创建你的第一份简历' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/AI|会员|支付|导出 PDF|模板市场/);
  });

  it('keeps existing cards when loading the next page fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ data: { items: [firstResume], nextCursor: 'next-page' } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<ResumeDashboard csrfRequired={false} displayName="开发用户" userId="dev-user" />);
    expect(await screen.findByText(firstResume.title)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '加载更多' }));

    expect((await screen.findByRole('alert')).textContent).toContain('暂时无法加载简历列表');
    expect(screen.getByText(firstResume.title)).toBeTruthy();
    expect(fetchMock.mock.calls[1]?.[0]).toContain('cursor=next-page');
  });

  it('copies, renames and deletes through the existing versioned endpoints', async () => {
    const renamed = { ...firstResume, title: '高级前端工程师', revision: '2' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: { items: [firstResume], nextCursor: null } }))
      .mockResolvedValueOnce(Response.json({ data: { id: secondResume.id } }))
      .mockResolvedValueOnce(
        Response.json({ data: { items: [secondResume, firstResume], nextCursor: null } }),
      )
      .mockResolvedValueOnce(Response.json({ data: { resume: renamed } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<ResumeDashboard csrfRequired={false} displayName="开发用户" userId="dev-user" />);
    expect(await screen.findByText(firstResume.title)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '复制' }));
    expect(await screen.findByText(secondResume.title)).toBeTruthy();

    const originalCard = document.querySelector(`[data-resume-id="${firstResume.id}"]`);
    expect(originalCard).toBeTruthy();
    await user.click(withinElement(originalCard).getByRole('button', { name: '重命名' }));
    const title = screen.getByRole<HTMLInputElement>('textbox', { name: '简历名称' });
    await user.clear(title);
    await user.type(title, '高级前端工程师');
    await user.click(screen.getByRole('button', { name: '保存名称' }));
    expect(await screen.findByText('高级前端工程师')).toBeTruthy();

    const renamedCard = document.querySelector(`[data-resume-id="${firstResume.id}"]`);
    await user.click(withinElement(renamedCard).getByRole('button', { name: '删除' }));
    expect(screen.getByText('删除后会从工作台消失，并可在 7 天内从最近删除中恢复。')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => {
      expect(screen.queryByText('高级前端工程师')).toBeNull();
    });

    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('retains the card and rename input when card actions fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ data: { items: [firstResume], nextCursor: null } }))
        .mockResolvedValue(new Response(null, { status: 500 })),
    );
    const user = userEvent.setup();

    render(<ResumeDashboard csrfRequired={false} displayName="开发用户" userId="dev-user" />);
    expect(await screen.findByText(firstResume.title)).toBeTruthy();
    const card = () => document.querySelector(`[data-resume-id="${firstResume.id}"]`);

    await user.click(withinElement(card()).getByRole('button', { name: '复制' }));
    expect((await screen.findByRole('alert')).textContent).toContain('复制失败');
    expect(card()).toBeTruthy();

    await user.click(withinElement(card()).getByRole('button', { name: '重命名' }));
    const title = screen.getByRole<HTMLInputElement>('textbox', { name: '简历名称' });
    await user.clear(title);
    await user.type(title, '失败后保留的名称');
    await user.click(screen.getByRole('button', { name: '保存名称' }));
    expect((await screen.findByRole('alert')).textContent).toContain('重命名失败');
    expect(title.value).toBe('失败后保留的名称');
    expect(card()).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '取消' }));

    await user.click(withinElement(card()).getByRole('button', { name: '删除' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect((await screen.findByRole('alert')).textContent).toContain('删除失败');
    expect(card()).toBeTruthy();
  });
});

describe('create resume page', () => {
  it('retains fields and reuses the idempotency key until creation succeeds', async () => {
    const navigate = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ data: firstResume }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <CreateResumePage
        csrfRequired={false}
        displayName="开发用户"
        navigate={navigate}
        userId="dev-user"
      />,
    );
    const title = screen.getByRole<HTMLInputElement>('textbox', { name: '简历名称' });
    await user.clear(title);
    await user.type(title, '我的测试简历');
    await user.click(screen.getByRole('button', { name: /创建并进入编辑器/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('创建失败');
    expect(title.value).toBe('我的测试简历');
    await user.click(screen.getByRole('button', { name: /创建并进入编辑器/ }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(`/resumes/${firstResume.id}/edit`);
    });

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const firstHeaders = new Headers(calls[0]?.[1]?.headers);
    const retryHeaders = new Headers(calls[1]?.[1]?.headers);
    expect(firstHeaders.get('Idempotency-Key')).toBe(retryHeaders.get('Idempotency-Key'));
  });
});

describe('account page', () => {
  it('requires password and an irreversible confirmation without future account features', async () => {
    const user = userEvent.setup();
    render(
      <AccountPage
        csrfRequired
        displayName="测试用户"
        userId="11111111-1111-4111-8111-111111111111"
      />,
    );

    const submit = screen.getByRole<HTMLButtonElement>('button', { name: '永久注销账户' });
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByLabelText('当前密码'), 'Strong-password-123');
    await user.click(screen.getByRole('checkbox', { name: /我确认永久注销/u }));
    expect(submit.disabled).toBe(false);
    expect(document.body.textContent).not.toMatch(/会员|支付|设备管理|头像上传|邮箱修改/u);
  });
});

function withinElement(element: Element | null) {
  if (!(element instanceof HTMLElement)) throw new Error('未找到简历卡片');
  return {
    getByRole: (role: 'button', options: { name: string }) => {
      const match = Array.from(element.querySelectorAll('button')).find(
        (button) => button.textContent.trim() === options.name,
      );
      if (!match) throw new Error(`未找到${role}：${options.name}`);
      return match;
    },
  };
}
