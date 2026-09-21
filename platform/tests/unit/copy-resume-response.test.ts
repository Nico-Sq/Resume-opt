import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  AuthenticationRequiredError,
  IdempotencyKeyReusedError,
  InvalidCopyResumeRequestError,
  ResourceNotFoundError,
  RevisionConflictError,
} from '@resume/application';
import { createInitialResumeDocument } from '@resume/domain/resume';
import { respondToCopyResume } from '../../apps/web/src/server/http/copy-resume-response';

const sourceResumeId = '62000000-0000-4000-8000-000000000001';
const copiedResumeId = '62000000-0000-4000-8000-000000000002';
const resume = {
  id: copiedResumeId,
  title: '岗位定制副本',
  document: createInitialResumeDocument(),
  revision: '1',
  schemaVersion: 1 as const,
  templateId: 'ats-basic',
  templateVersion: '1.0.0',
  updatedAt: '2026-09-21T00:00:00.000Z',
};

function request(body: unknown = { sourceRevision: '7', title: resume.title }) {
  return new Request(`http://localhost/api/v1/resumes/${sourceResumeId}/copies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify(body),
  });
}

describe('copy resume HTTP boundary', () => {
  it('returns the independent DTO with creation headers and replay marker', async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ resume, versionId: randomUUID(), replayed: true }),
    );
    const response = await respondToCopyResume(request(), sourceResumeId, { execute });

    expect(response.status).toBe(201);
    expect(response.headers.get('etag')).toBe('"1"');
    expect(response.headers.get('location')).toBe(`/api/v1/resumes/${copiedResumeId}`);
    expect(response.headers.get('idempotency-replayed')).toBe('true');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ data: resume });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceResumeId,
        sourceRevision: '7',
        title: resume.title,
      }),
    );
  });

  it('requires valid resource/key/body and rejects client ownership fields', async () => {
    const execute = vi.fn();
    const missingKeyRequest = request();
    missingKeyRequest.headers.delete('idempotency-key');
    const responses = await Promise.all([
      respondToCopyResume(request(), 'bad-id', { execute }),
      respondToCopyResume(missingKeyRequest, sourceResumeId, { execute }),
      respondToCopyResume(
        request({ sourceRevision: '7', title: resume.title, ownerId: randomUUID() }),
        sourceResumeId,
        { execute },
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([400, 400, 422]);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [new AuthenticationRequiredError(), 401],
    [new ResourceNotFoundError(), 404],
    [new RevisionConflictError('8'), 412],
    [new IdempotencyKeyReusedError(), 409],
    [
      new InvalidCopyResumeRequestError([{ path: 'title', code: 'custom', message: '名称过长' }]),
      422,
    ],
  ] as const)('maps %s to HTTP %i', async (error, status) => {
    const response = await respondToCopyResume(request(), sourceResumeId, {
      execute: () => Promise.reject(error),
    });
    expect(response.status).toBe(status);
    if (status === 412) {
      expect(await response.json()).toMatchObject({
        code: 'REVISION_CONFLICT',
        details: { currentRevision: '8' },
      });
    }
  });
});
