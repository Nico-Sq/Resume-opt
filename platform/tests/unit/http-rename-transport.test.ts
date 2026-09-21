import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  HttpRenameTransport,
  SaveTransportError,
  type FetchImplementation,
  type RenameResumeRequest,
} from '../../apps/web/src/client/editor/saving';

function request(): RenameResumeRequest {
  return {
    resumeId: randomUUID(),
    title: '新简历名称',
    baseRevision: '7',
    idempotencyKey: randomUUID(),
  };
}

function receipt(input: RenameResumeRequest) {
  return {
    resume: {
      id: input.resumeId,
      title: input.title,
      locale: 'zh-CN',
      stage: 'employed' as const,
      revision: '8',
      templateId: 'standard',
      templateVersion: '1.0.0',
      createdAt: '2026-09-18T08:00:00.000Z',
      updatedAt: '2026-09-18T08:00:01.000Z',
    },
    versionId: randomUUID(),
  };
}

function jsonResponse(body: unknown, init: ResponseInit): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}

describe('HttpRenameTransport', () => {
  it('sends PATCH with the shared CAS revision and validates its receipt', async () => {
    const input = request();
    const output = receipt(input);
    let capturedUrl: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImplementation: FetchImplementation = (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(
        jsonResponse(
          { data: output, traceId: randomUUID() },
          { status: 200, headers: { ETag: '"8"' } },
        ),
      );
    };

    await expect(
      new HttpRenameTransport(fetchImplementation, 'csrf-token').rename(input),
    ).resolves.toEqual(output);
    expect(capturedUrl).toBe(`/api/v1/resumes/${input.resumeId}`);
    expect(capturedInit).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ title: input.title }),
      cache: 'no-store',
    });
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('Idempotency-Key')).toBe(input.idempotencyKey);
    expect(headers.get('If-Match')).toBe('"7"');
    expect(headers.get('X-CSRF-Token')).toBe('csrf-token');
  });

  it('classifies a stale revision and exposes the current revision', async () => {
    const transport = new HttpRenameTransport(() =>
      Promise.resolve(
        jsonResponse(
          {
            code: 'REVISION_CONFLICT',
            message: '版本冲突',
            traceId: randomUUID(),
            retryable: false,
            details: { currentRevision: '9' },
          },
          { status: 412 },
        ),
      ),
    );

    const error = await transport.rename(request()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SaveTransportError);
    expect(error).toMatchObject({ kind: 'conflict', options: { currentRevision: '9' } });
  });

  it('treats a lost response as a retryable network failure', async () => {
    const transport = new HttpRenameTransport(() => Promise.reject(new TypeError('offline')));
    const error = await transport.rename(request()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SaveTransportError);
    expect(error).toMatchObject({ kind: 'network' });
  });

  it('keeps an aborted request distinct from a network failure', async () => {
    const transport = new HttpRenameTransport(() =>
      Promise.reject(new DOMException('请求已取消', 'AbortError')),
    );
    const error = await transport.rename(request()).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ kind: 'aborted' });
  });
});
