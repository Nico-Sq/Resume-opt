import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  AuthenticationRequiredError,
  IdempotencyKeyReusedError,
  InvalidRenameResumeRequestError,
  RevisionConflictError,
} from '@resume/application';
import { respondToRenameResume } from '../../apps/web/src/server/http/rename-resume-response';

const resumeId = '73000000-0000-4000-8000-000000000001';
const result = {
  resume: {
    id: resumeId,
    title: '新名称',
    locale: 'zh-CN',
    stage: 'student' as const,
    revision: '8',
    templateId: 'ats-basic',
    templateVersion: '1.0.0',
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T01:00:00.000Z',
  },
  versionId: '73000000-0000-4000-8000-000000000002',
  replayed: false,
};

function request(body: unknown = { title: '新名称' }) {
  return new Request(`http://localhost/api/v1/resumes/${resumeId}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      'if-match': '"7"',
    },
    body: JSON.stringify(body),
  });
}

describe('rename resume HTTP boundary', () => {
  it('returns metadata, a new ETag and replay marker without public caching', async () => {
    const execute = vi.fn(() => Promise.resolve({ ...result, replayed: true }));
    const response = await respondToRenameResume(request(), resumeId, { execute });

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"8"');
    expect(response.headers.get('idempotency-replayed')).toBe('true');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({
      data: { resume: result.resume, versionId: result.versionId },
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ resumeId, title: '新名称', baseRevision: '7' }),
    );
  });

  it('requires UUID idempotency, strong If-Match and a strict title body', async () => {
    const execute = vi.fn();
    const missingKeyRequest = request();
    missingKeyRequest.headers.delete('idempotency-key');
    const missingMatchRequest = request();
    missingMatchRequest.headers.delete('if-match');
    const weakMatchRequest = request();
    weakMatchRequest.headers.set('if-match', 'W/"7"');

    const missingKey = await respondToRenameResume(missingKeyRequest, resumeId, { execute });
    const missingMatch = await respondToRenameResume(missingMatchRequest, resumeId, { execute });
    const weakMatch = await respondToRenameResume(weakMatchRequest, resumeId, { execute });
    const extraField = await respondToRenameResume(
      request({ title: '新名称', ownerId: randomUUID() }),
      resumeId,
      { execute },
    );

    expect(missingKey.status).toBe(400);
    expect(missingMatch.status).toBe(428);
    expect(weakMatch.status).toBe(400);
    expect(extraField.status).toBe(422);
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps authentication, validation, CAS and idempotency failures', async () => {
    const unauthenticated = await respondToRenameResume(request(), resumeId, {
      execute: () => Promise.reject(new AuthenticationRequiredError()),
    });
    const invalid = await respondToRenameResume(request(), resumeId, {
      execute: () =>
        Promise.reject(
          new InvalidRenameResumeRequestError([
            { path: 'title', code: 'custom', message: '名称无效' },
          ]),
        ),
    });
    const conflict = await respondToRenameResume(request(), resumeId, {
      execute: () => Promise.reject(new RevisionConflictError('9')),
    });
    const reused = await respondToRenameResume(request(), resumeId, {
      execute: () => Promise.reject(new IdempotencyKeyReusedError()),
    });

    expect(unauthenticated.status).toBe(401);
    expect(invalid.status).toBe(422);
    expect(conflict.status).toBe(412);
    expect(await conflict.json()).toMatchObject({
      code: 'REVISION_CONFLICT',
      details: { currentRevision: '9' },
    });
    expect(reused.status).toBe(409);
  });

  it('returns a private retryable failure for unexpected errors', async () => {
    const response = await respondToRenameResume(request(), resumeId, {
      execute: () => Promise.reject(new Error('database unavailable')),
    });
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ code: 'INTERNAL_ERROR', retryable: true });
  });
});
