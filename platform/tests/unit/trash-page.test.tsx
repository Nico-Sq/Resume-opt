// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TrashPage } from '../../apps/web/src/client/dashboard/trash-page';

const activeItem = {
  id: '31111111-1111-4111-8111-111111111111',
  title: '可恢复简历',
  locale: 'zh-CN',
  stage: 'employed',
  revision: '4',
  templateId: 'ats-basic',
  templateVersion: '1.0.0',
  createdAt: '2026-09-20T01:00:00.000Z',
  updatedAt: '2026-09-21T01:00:00.000Z',
  deletedAt: '2026-09-22T01:00:00.000Z',
  restoreUntil: '2099-09-29T01:00:00.000Z',
} as const;

const expiredItem = {
  ...activeItem,
  id: '32222222-2222-4222-8222-222222222222',
  title: '已过期简历',
  restoreUntil: '2020-09-22T01:00:00.000Z',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('recently deleted resumes', () => {
  it('shows a metadata-only empty state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ data: { items: [], nextCursor: null } }))),
    );

    render(<TrashPage csrfRequired={false} displayName="开发用户" userId="dev-user" />);
    expect(await screen.findByRole('heading', { name: '最近删除为空' })).toBeTruthy();
    expect(document.body.textContent).toContain('这里不会展示简历正文');
    expect(document.body.textContent).not.toMatch(/预览|永久删除/u);
  });

  it('disables expired restores and retains the card and key across a failed retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ data: { items: [activeItem, expiredItem], nextCursor: null } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(
        Response.json({ data: { resume: { id: activeItem.id, revision: '5' } } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<TrashPage csrfRequired={false} displayName="开发用户" userId="dev-user" />);
    expect(await screen.findByText(activeItem.title)).toBeTruthy();
    const expiredButton = screen.getByRole<HTMLButtonElement>('button', { name: '已过期' });
    expect(expiredButton.disabled).toBe(true);
    expect(screen.getByText(/恢复期限已过/u)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '恢复' }));
    expect((await screen.findByRole('status')).textContent).toContain('恢复失败');
    expect(screen.getByText(activeItem.title)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() => {
      expect(screen.queryByText(activeItem.title)).toBeNull();
    });
    expect(screen.getByRole('status').textContent).toContain('已恢复到我的简历');

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const firstHeaders = new Headers(calls[1]?.[1]?.headers);
    const retryHeaders = new Headers(calls[2]?.[1]?.headers);
    expect(firstHeaders.get('Idempotency-Key')).toBe(retryHeaders.get('Idempotency-Key'));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '最近删除' }));
  });

  it('keeps the success feedback visible after restoring the final item', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ data: { items: [activeItem], nextCursor: null } }))
        .mockResolvedValueOnce(
          Response.json({ data: { resume: { id: activeItem.id, revision: '5' } } }),
        ),
    );
    const user = userEvent.setup();

    render(<TrashPage csrfRequired={false} displayName="开发用户" userId="dev-user" />);
    await user.click(await screen.findByRole('button', { name: '恢复' }));

    expect(await screen.findByRole('heading', { name: '最近删除为空' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('已恢复到我的简历');
  });
});
