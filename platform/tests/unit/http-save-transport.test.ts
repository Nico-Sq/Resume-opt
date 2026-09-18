import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { createInitialResumeDocument } from '@resume/domain/resume';
import type { PendingSaveEnvelope } from '../../apps/web/src/client/editor/persistence';
import {
  HttpSaveTransport,
  SaveTransportError,
  type FetchImplementation,
} from '../../apps/web/src/client/editor/saving';

function envelope(): PendingSaveEnvelope {
  return {
    idempotencyKey: randomUUID(),
    resumeId: randomUUID(),
    baseRevision: '7',
    clientSeq: 12,
    document: createInitialResumeDocument(),
    createdAt: '2026-09-18T08:00:00.000Z',
  };
}

function jsonResponse(body: unknown, init: ResponseInit): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

describe('HttpSaveTransport', () => {
  it('invokes the default browser fetch with the global receiver', async () => {
    const requestEnvelope = envelope();
    const receipt = {
      resumeId: requestEnvelope.resumeId,
      revision: '8',
      versionId: randomUUID(),
      acknowledgedSeq: requestEnvelope.clientSeq,
      savedAt: '2026-09-18T08:00:01.000Z',
      contentHash: 'b'.repeat(64),
    };
    let receiver: unknown;
    vi.stubGlobal('fetch', function (this: unknown) {
      receiver = this;
      return Promise.resolve(
        jsonResponse(
          { data: receipt, traceId: randomUUID() },
          { status: 200, headers: { ETag: '"8"' } },
        ),
      );
    });

    try {
      await expect(new HttpSaveTransport().save(requestEnvelope)).resolves.toEqual(receipt);
      expect(receiver).toBe(globalThis);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends a frozen snapshot with CAS and idempotency headers and validates the receipt', async () => {
    const requestEnvelope = envelope();
    const receipt = {
      resumeId: requestEnvelope.resumeId,
      revision: '8',
      versionId: randomUUID(),
      acknowledgedSeq: requestEnvelope.clientSeq,
      savedAt: '2026-09-18T08:00:01.000Z',
      contentHash: 'b'.repeat(64),
    };
    let capturedUrl: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImplementation: FetchImplementation = (input, init) => {
      capturedUrl = input;
      capturedInit = init;
      return Promise.resolve(
        jsonResponse(
          { data: receipt, traceId: randomUUID() },
          { status: 200, headers: { ETag: '"8"' } },
        ),
      );
    };
    const transport = new HttpSaveTransport(fetchImplementation);

    await expect(transport.save(requestEnvelope)).resolves.toEqual(receipt);
    expect(capturedUrl).toBe(`/api/v1/resumes/${requestEnvelope.resumeId}/document`);
    expect(capturedInit?.method).toBe('PUT');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('Idempotency-Key')).toBe(requestEnvelope.idempotencyKey);
    expect(headers.get('If-Match')).toBe('"7"');
    expect(capturedInit?.body).toBe(
      JSON.stringify({
        document: requestEnvelope.document,
        clientSeq: requestEnvelope.clientSeq,
      }),
    );
  });

  it.each([
    [401, 'auth'],
    [412, 'conflict'],
    [422, 'validation'],
    [500, 'retryable'],
  ] as const)('classifies HTTP %i as %s', async (status, kind) => {
    const fetchImplementation: FetchImplementation = () =>
      Promise.resolve(
        jsonResponse(
          {
            code: status === 412 ? 'REVISION_CONFLICT' : 'TEST_ERROR',
            message: '保存失败',
            traceId: randomUUID(),
            retryable: status >= 500,
            ...(status === 412 ? { details: { currentRevision: '9' } } : {}),
          },
          { status },
        ),
      );
    const transport = new HttpSaveTransport(fetchImplementation);

    const error = await transport.save(envelope()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SaveTransportError);
    expect((error as SaveTransportError).kind).toBe(kind);
    if (status === 412) {
      expect((error as SaveTransportError).options.currentRevision).toBe('9');
    }
  });

  it('classifies a thrown fetch as a retryable network failure', async () => {
    const transport = new HttpSaveTransport(() => Promise.reject(new TypeError('offline')));
    const error = await transport.save(envelope()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SaveTransportError);
    expect((error as SaveTransportError).kind).toBe('network');
  });
});
