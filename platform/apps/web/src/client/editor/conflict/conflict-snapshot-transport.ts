import { ResumeDocumentV1Schema } from '@resume/domain/resume';
import { z } from 'zod';

import type { RemoteResumeSnapshot } from '../persistence';

const RemoteResumeResponseSchema = z.object({
  data: z.object({
    id: z.uuid(),
    document: ResumeDocumentV1Schema,
    revision: z.string().regex(/^[1-9][0-9]*$/u),
  }),
  traceId: z.uuid(),
});

export type ConflictSnapshotFailureKind = 'network' | 'auth' | 'not-found' | 'retryable' | 'fatal';

export class ConflictSnapshotError extends Error {
  constructor(
    readonly kind: ConflictSnapshotFailureKind,
    message: string,
    readonly options: { status?: number; traceId?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ConflictSnapshotError';
  }
}

export interface ConflictSnapshotTransport {
  loadCurrent(resumeId: string, signal?: AbortSignal): Promise<RemoteResumeSnapshot>;
}

export type ConflictFetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const defaultFetch: ConflictFetchImplementation = (input, init) => globalThis.fetch(input, init);

function resolveEndpoint(relativeEndpoint: string): string | URL {
  const locationValue: unknown = Reflect.get(globalThis, 'location');
  if (typeof locationValue !== 'object' || locationValue === null) return relativeEndpoint;
  const href: unknown = Reflect.get(locationValue, 'href');
  return typeof href === 'string' ? new URL(relativeEndpoint, href) : relativeEndpoint;
}

export class HttpConflictSnapshotTransport implements ConflictSnapshotTransport {
  constructor(private readonly fetchImplementation: ConflictFetchImplementation = defaultFetch) {}

  async loadCurrent(resumeId: string, signal?: AbortSignal): Promise<RemoteResumeSnapshot> {
    const relativeEndpoint = `/api/v1/resumes/${encodeURIComponent(resumeId)}`;
    let response: Response;
    try {
      const endpoint = resolveEndpoint(relativeEndpoint);
      response = await this.fetchImplementation(endpoint, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      throw new ConflictSnapshotError('network', '无法读取服务器上的最新版本', { cause });
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // 统一在下方按不可识别响应处理。
    }
    if (!response.ok) {
      const kind =
        response.status === 401 || response.status === 403
          ? 'auth'
          : response.status === 404
            ? 'not-found'
            : response.status >= 500
              ? 'retryable'
              : 'fatal';
      throw new ConflictSnapshotError(kind, '服务器最新版本读取失败', {
        status: response.status,
      });
    }

    const parsed = RemoteResumeResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new ConflictSnapshotError('fatal', '服务器最新版本格式无效');
    }
    const remote = parsed.data.data;
    if (remote.id !== resumeId || response.headers.get('etag') !== `"${remote.revision}"`) {
      throw new ConflictSnapshotError('fatal', '服务器最新版本回执不匹配', {
        traceId: parsed.data.traceId,
      });
    }
    return { resumeId: remote.id, document: remote.document, revision: remote.revision };
  }
}
