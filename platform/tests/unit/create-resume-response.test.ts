import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  AuthenticationRequiredError,
  IdempotencyKeyReusedError,
  InvalidCreateResumeRequestError,
} from '@resume/application';
import { createInitialResumeDocument } from '@resume/domain/resume';
import { respondToCreateResume } from '../../apps/web/src/server/http/create-resume-response';

const resumeId = '61000000-0000-4000-8000-000000000001';
const resume = {
  id: resumeId,
  title: '后端工程师简历',
  document: createInitialResumeDocument(),
  revision: '1',
  schemaVersion: 1 as const,
  templateId: 'ats-basic',
  templateVersion: '1.0.0',
  updatedAt: '2026-09-21T00:00:00.000Z',
};

function request(body: unknown = { title: resume.title, stage: 'student', mode: 'blank' }) {
  return new Request('http://localhost/api/v1/resumes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify(body),
  });
}

describe('create resume HTTP boundary', () => {
  it('returns the current DTO with creation headers and replay marker', async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ resume, versionId: randomUUID(), replayed: true }),
    );
    const response = await respondToCreateResume(request(), { execute });

    expect(response.status).toBe(201);
    expect(response.headers.get('etag')).toBe('"1"');
    expect(response.headers.get('location')).toBe(`/api/v1/resumes/${resumeId}`);
    expect(response.headers.get('idempotency-replayed')).toBe('true');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ data: resume });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ title: resume.title, stage: 'student', mode: 'blank' }),
    );
  });

  it('requires an idempotency key and rejects client ownership fields before execution', async () => {
    const execute = vi.fn();
    const missingKeyRequest = request();
    missingKeyRequest.headers.delete('idempotency-key');
    const missingKey = await respondToCreateResume(missingKeyRequest, { execute });
    const ownerField = await respondToCreateResume(
      request({ title: resume.title, stage: 'student', mode: 'blank', ownerId: randomUUID() }),
      { execute },
    );

    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect(ownerField.status).toBe(422);
    expect(await ownerField.json()).toMatchObject({ code: 'INVALID_SCHEMA' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps authentication, title validation and idempotency conflicts', async () => {
    const unauthenticated = await respondToCreateResume(request(), {
      execute: () => Promise.reject(new AuthenticationRequiredError()),
    });
    const invalid = await respondToCreateResume(request(), {
      execute: () =>
        Promise.reject(
          new InvalidCreateResumeRequestError([
            { path: 'title', code: 'custom', message: '名称过长' },
          ]),
        ),
    });
    const reused = await respondToCreateResume(request(), {
      execute: () => Promise.reject(new IdempotencyKeyReusedError()),
    });

    expect(unauthenticated.status).toBe(401);
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({
      code: 'INVALID_SCHEMA',
      fieldErrors: [{ path: 'title' }],
    });
    expect(reused.status).toBe(409);
  });
});
