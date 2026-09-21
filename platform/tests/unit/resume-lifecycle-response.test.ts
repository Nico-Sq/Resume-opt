import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { RestoreWindowExpiredError, RevisionConflictError } from '@resume/application';
import {
  respondToDeleteResume,
  respondToListDeletedResumes,
  respondToUndeleteResume,
} from '../../apps/web/src/server/http/resume-lifecycle-response';

const resumeId = '77000000-0000-4000-8000-000000000001';

function writeRequest(method: 'DELETE' | 'POST', body: unknown, revision = '1') {
  return new Request(`http://localhost/api/v1/resumes/${resumeId}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      'if-match': `"${revision}"`,
    },
    body: JSON.stringify(body),
  });
}

describe('resume lifecycle HTTP boundary', () => {
  it('returns delete and restore receipts with private ETags and replay markers', async () => {
    const deleted = {
      id: resumeId,
      revision: '2',
      deletedAt: '2026-09-22T00:00:00.000Z',
      restoreUntil: '2026-09-29T00:00:00.000Z',
      versionId: randomUUID(),
      replayed: true,
    };
    const deleteResponse = await respondToDeleteResume(
      writeRequest('DELETE', { confirm: true }),
      resumeId,
      { execute: vi.fn(() => Promise.resolve(deleted)) },
    );
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.headers.get('etag')).toBe('"2"');
    expect(deleteResponse.headers.get('idempotency-replayed')).toBe('true');
    expect(deleteResponse.headers.get('cache-control')).toBe('private, no-store');
    const deleteBody: unknown = await deleteResponse.json();
    expect(deleteBody).toMatchObject({
      data: {
        id: resumeId,
        revision: '2',
        deletedAt: deleted.deletedAt,
        restoreUntil: deleted.restoreUntil,
      },
    });
    expect(JSON.stringify(deleteBody)).not.toContain('versionId');

    const restored = {
      resume: {
        id: resumeId,
        title: '恢复的简历',
        locale: 'zh-CN',
        stage: 'student' as const,
        revision: '3',
        templateId: 'ats-basic',
        templateVersion: '1.0.0',
        createdAt: '2026-09-21T00:00:00.000Z',
        updatedAt: '2026-09-22T00:01:00.000Z',
      },
      versionId: randomUUID(),
      replayed: false,
    };
    const restoreResponse = await respondToUndeleteResume(writeRequest('POST', {}, '2'), resumeId, {
      execute: vi.fn(() => Promise.resolve(restored)),
    });
    expect(restoreResponse.status).toBe(200);
    expect(restoreResponse.headers.get('etag')).toBe('"3"');
    const restoreBody: unknown = await restoreResponse.json();
    expect(restoreBody).toMatchObject({
      data: { resume: restored.resume },
    });
    expect(JSON.stringify(restoreBody)).not.toContain('versionId');
  });

  it('requires confirmation, idempotency and strong If-Match', async () => {
    const execute = vi.fn();
    const invalidBody = await respondToDeleteResume(
      writeRequest('DELETE', { confirm: false }),
      resumeId,
      { execute },
    );
    const missingKeyRequest = writeRequest('DELETE', { confirm: true });
    missingKeyRequest.headers.delete('idempotency-key');
    const missingKey = await respondToDeleteResume(missingKeyRequest, resumeId, { execute });
    const weakMatchRequest = writeRequest('POST', {});
    weakMatchRequest.headers.set('if-match', 'W/"1"');
    const weakMatch = await respondToUndeleteResume(weakMatchRequest, resumeId, { execute });

    expect(invalidBody.status).toBe(422);
    expect(missingKey.status).toBe(400);
    expect(weakMatch.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps lifecycle CAS and expiry failures', async () => {
    const conflict = await respondToDeleteResume(
      writeRequest('DELETE', { confirm: true }),
      resumeId,
      { execute: () => Promise.reject(new RevisionConflictError('4')) },
    );
    const expired = await respondToUndeleteResume(writeRequest('POST', {}, '2'), resumeId, {
      execute: () => Promise.reject(new RestoreWindowExpiredError()),
    });
    expect(conflict.status).toBe(412);
    expect(await conflict.json()).toMatchObject({ details: { currentRevision: '4' } });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ code: 'RESTORE_WINDOW_EXPIRED' });
  });

  it('returns only paged trash metadata without public caching', async () => {
    const execute = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
    const response = await respondToListDeletedResumes(
      new Request('http://localhost/api/v1/resumes/trash?limit=5'),
      { execute },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(execute).toHaveBeenCalledWith({ limit: 5 });

    const invalid = await respondToListDeletedResumes(
      new Request('http://localhost/api/v1/resumes/trash?preview=true'),
      { execute },
    );
    expect(invalid.status).toBe(400);
  });
});
