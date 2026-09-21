// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EditorEntry } from '../../apps/web/src/client/editor/editor-entry';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('dynamic editor entry', () => {
  it('checks the real session before requesting a private resume or opening a draft', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json(
          { data: null, traceId: randomUUID() },
          { headers: { 'Cache-Control': 'private, no-store' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<EditorEntry csrfRequired resumeId={randomUUID()} />);

    expect(await screen.findByText('请先登录并完成邮箱验证')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/session', expect.any(Object));
  });

  it('shows one non-enumerating error for an unavailable dynamic resume', async () => {
    const resumeId = randomUUID();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: { userId: randomUUID(), displayName: '测试用户', emailVerified: true },
          traceId: randomUUID(),
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            code: 'RESOURCE_NOT_FOUND',
            message: '资源不存在',
            traceId: randomUUID(),
            retryable: false,
          },
          { status: 404 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<EditorEntry csrfRequired resumeId={resumeId} />);

    expect(await screen.findByText('简历不存在或无权访问')).toBeTruthy();
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/session', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/v1/resumes/${resumeId}`, expect.any(Object));
  });

  it('stops before draft access when the session expires during authorization', async () => {
    const resumeId = randomUUID();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: { userId: randomUUID(), displayName: '测试用户', emailVerified: true },
          traceId: randomUUID(),
        }),
      )
      .mockResolvedValueOnce(Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<EditorEntry csrfRequired resumeId={resumeId} />);

    expect(await screen.findByText('登录已失效，请重新登录')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not expose corrupted stored content to the editor', async () => {
    const resumeId = randomUUID();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: { userId: randomUUID(), displayName: '测试用户', emailVerified: true },
          traceId: randomUUID(),
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            code: 'STORED_RESUME_INVALID',
            message: '已保存的数据不符合简历契约',
            traceId: randomUUID(),
            retryable: false,
          },
          { status: 500 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<EditorEntry csrfRequired resumeId={resumeId} />);

    expect(await screen.findByText('已保存的简历内容损坏')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
