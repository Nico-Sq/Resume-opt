import { z } from 'zod';

import { SaveTransportError, type FetchImplementation } from './http-save-transport';

const RenameReceiptSchema = z.strictObject({
  resume: z.strictObject({
    id: z.uuid(),
    title: z.string(),
    locale: z.string(),
    stage: z.enum(['student', 'employed', 'transition']),
    revision: z.string().regex(/^[1-9][0-9]*$/u),
    templateId: z.string(),
    templateVersion: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  }),
  versionId: z.uuid(),
});
const RenameSuccessSchema = z.object({ data: RenameReceiptSchema, traceId: z.uuid() });
const RenameErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  traceId: z.uuid(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export interface RenameResumeRequest {
  resumeId: string;
  title: string;
  baseRevision: string;
  idempotencyKey: string;
}

export type RenameResumeReceipt = z.infer<typeof RenameReceiptSchema>;

export interface RenameTransport {
  rename(request: RenameResumeRequest, signal?: AbortSignal): Promise<RenameResumeReceipt>;
}

const defaultFetch: FetchImplementation = (input, init) => globalThis.fetch(input, init);

function resolveEndpoint(relativeEndpoint: string): string | URL {
  const locationValue: unknown = Reflect.get(globalThis, 'location');
  if (typeof locationValue !== 'object' || locationValue === null) return relativeEndpoint;
  const href: unknown = Reflect.get(locationValue, 'href');
  return typeof href === 'string' ? new URL(relativeEndpoint, href) : relativeEndpoint;
}

export class HttpRenameTransport implements RenameTransport {
  constructor(
    private readonly fetchImplementation: FetchImplementation = defaultFetch,
    private readonly csrfToken?: string,
  ) {}

  async rename(request: RenameResumeRequest, signal?: AbortSignal): Promise<RenameResumeReceipt> {
    let response: Response;
    try {
      response = await this.fetchImplementation(
        resolveEndpoint(`/api/v1/resumes/${encodeURIComponent(request.resumeId)}`),
        {
          method: 'PATCH',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Idempotency-Key': request.idempotencyKey,
            'If-Match': `"${request.baseRevision}"`,
            ...(this.csrfToken ? { 'X-CSRF-Token': this.csrfToken } : {}),
          },
          body: JSON.stringify({ title: request.title }),
          cache: 'no-store',
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new SaveTransportError('aborted', '重命名请求已取消', { cause: error });
      }
      throw new SaveTransportError('network', '无法连接重命名服务', { cause: error });
    }

    const rawBody: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = RenameErrorSchema.safeParse(rawBody);
      const body = parsed.success ? parsed.data : null;
      const options = {
        status: response.status,
        ...(body?.code ? { code: body.code } : {}),
        ...(body?.traceId ? { traceId: body.traceId } : {}),
      };
      const message = body?.message ?? '重命名服务返回了无法识别的错误';
      if (response.status === 401 || response.status === 403) {
        throw new SaveTransportError('auth', message, options);
      }
      if (response.status === 404) {
        throw new SaveTransportError('resource-gone', message, options);
      }
      if (response.status === 412) {
        const currentRevision = body?.details?.currentRevision;
        throw new SaveTransportError('conflict', message, {
          ...options,
          ...(typeof currentRevision === 'string' ? { currentRevision } : {}),
        });
      }
      if (response.status === 422) throw new SaveTransportError('validation', message, options);
      if (
        body?.retryable ||
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        throw new SaveTransportError('retryable', message, options);
      }
      throw new SaveTransportError('fatal', message, options);
    }

    const parsed = RenameSuccessSchema.safeParse(rawBody);
    if (!parsed.success) throw new SaveTransportError('fatal', '重命名回执格式无效');
    const receipt = parsed.data.data;
    if (
      receipt.resume.id !== request.resumeId ||
      receipt.resume.title !== request.title ||
      response.headers.get('etag') !== `"${receipt.resume.revision}"`
    ) {
      throw new SaveTransportError('fatal', '重命名回执与请求不匹配', {
        traceId: parsed.data.traceId,
      });
    }
    return receipt;
  }
}
