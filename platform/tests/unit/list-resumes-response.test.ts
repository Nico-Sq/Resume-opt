import { describe, expect, it, vi } from 'vitest';

import { AuthenticationRequiredError, InvalidResumeCursorError } from '@resume/application';
import { respondToListResumes } from '../../apps/web/src/server/http/list-resumes-response';

function request(query = '') {
  return new Request(`http://localhost/api/v1/resumes${query}`);
}

describe('resume list HTTP boundary', () => {
  it('returns a private metadata page and forwards supported query values', async () => {
    const execute = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
    const response = await respondToListResumes(request('?limit=20&cursor=opaque'), { execute });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ data: { items: [], nextCursor: null } });
    expect(execute).toHaveBeenCalledWith({ limit: 20, cursor: 'opaque' });
  });

  it.each(['?search=java', '?limit=20&limit=21'])('rejects unsupported query %s', async (query) => {
    const execute = vi.fn();
    const response = await respondToListResumes(request(query), { execute });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_QUERY' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps invalid cursors, missing authentication and service failures without public caching', async () => {
    const invalid = await respondToListResumes(request('?cursor=bad'), {
      execute: () => Promise.reject(new InvalidResumeCursorError()),
    });
    const unauthenticated = await respondToListResumes(request(), {
      execute: () => Promise.reject(new AuthenticationRequiredError()),
    });
    const failed = await respondToListResumes(request(), {
      execute: () => Promise.reject(new Error('database unavailable')),
    });

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'INVALID_CURSOR' });
    expect(unauthenticated.status).toBe(401);
    expect(failed.status).toBe(500);
    expect(failed.headers.get('cache-control')).toBe('private, no-store');
  });
});
