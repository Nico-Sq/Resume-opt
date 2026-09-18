import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { IdempotencyKeyReusedError, RevisionConflictError } from '@resume/application';
import { createInitialResumeDocument } from '@resume/domain/resume';
import { respondToSaveResume } from '../../apps/web/src/server/http/save-resume-response';

const resumeId = '60000000-0000-4000-8000-000000000001';

function request(
  body: unknown = { document: createInitialResumeDocument(), clientSeq: 18 },
  headers: Record<string, string> = {},
) {
  return new Request(`http://localhost/api/v1/resumes/${resumeId}/document`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      'if-match': '"1"',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const receipt = {
  resumeId,
  revision: '2',
  versionId: '60000000-0000-4000-8000-000000000002',
  acknowledgedSeq: 18,
  savedAt: '2026-09-18T00:00:00.000Z',
  contentHash: 'a'.repeat(64),
};

describe('save resume HTTP boundary', () => {
  it('returns the save receipt, strong ETag and replay marker', async () => {
    const execute = vi.fn(() => Promise.resolve({ receipt, replayed: true }));
    const response = await respondToSaveResume(request(), resumeId, { execute });

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"2"');
    expect(response.headers.get('idempotency-replayed')).toBe('true');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ data: receipt });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ resumeId, baseRevision: '1', clientSeq: 18 }),
    );
  });

  it('requires a UUID idempotency key and a single strong If-Match ETag', async () => {
    const execute = vi.fn();
    const missingKeyRequest = request();
    missingKeyRequest.headers.delete('idempotency-key');
    const missingKey = await respondToSaveResume(missingKeyRequest, resumeId, { execute });
    const missingMatchRequest = request();
    missingMatchRequest.headers.delete('if-match');
    const missingMatch = await respondToSaveResume(missingMatchRequest, resumeId, { execute });
    const weakMatch = await respondToSaveResume(
      request(undefined, { 'if-match': 'W/"1"' }),
      resumeId,
      { execute },
    );

    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect(missingMatch.status).toBe(428);
    expect(await missingMatch.json()).toMatchObject({ code: 'IF_MATCH_REQUIRED' });
    expect(weakMatch.status).toBe(400);
    expect(await weakMatch.json()).toMatchObject({ code: 'INVALID_IF_MATCH' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects unknown fields and oversized bodies without invoking the application service', async () => {
    const execute = vi.fn();
    const invalid = await respondToSaveResume(
      request({ document: createInitialResumeDocument(), clientSeq: 1, ownerId: randomUUID() }),
      resumeId,
      { execute },
    );
    const tooLarge = await respondToSaveResume(
      request(undefined, { 'content-length': '1048577' }),
      resumeId,
      { execute },
    );

    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ code: 'INVALID_SCHEMA' });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps revision conflicts and idempotency misuse without marking them retryable', async () => {
    const conflict = await respondToSaveResume(request(), resumeId, {
      execute: () => Promise.reject(new RevisionConflictError('9')),
    });
    const reused = await respondToSaveResume(request(), resumeId, {
      execute: () => Promise.reject(new IdempotencyKeyReusedError()),
    });

    expect(conflict.status).toBe(412);
    expect(await conflict.json()).toMatchObject({
      code: 'REVISION_CONFLICT',
      retryable: false,
      details: { currentRevision: '9' },
    });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      retryable: false,
    });
  });
});
