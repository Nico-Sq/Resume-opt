import { z } from 'zod';

import type { PendingSaveEnvelope } from '../persistence';

const SaveReceiptSchema = z.strictObject({
  resumeId: z.uuid(),
  revision: z.string().regex(/^[1-9][0-9]*$/u),
  versionId: z.uuid(),
  acknowledgedSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  savedAt: z.iso.datetime({ offset: true }),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

const SaveSuccessSchema = z.object({
  data: SaveReceiptSchema,
  traceId: z.uuid(),
});

const SaveErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  traceId: z.uuid(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export type SaveFailureKind =
  'network' | 'retryable' | 'conflict' | 'auth' | 'validation' | 'fatal' | 'aborted';

export type SaveReceipt = z.infer<typeof SaveReceiptSchema>;

export class SaveTransportError extends Error {
  constructor(
    readonly kind: SaveFailureKind,
    message: string,
    readonly options: {
      status?: number;
      code?: string;
      traceId?: string;
      currentRevision?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SaveTransportError';
  }
}

export interface SaveTransport {
  save(envelope: PendingSaveEnvelope, signal?: AbortSignal): Promise<SaveReceipt>;
}

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const defaultFetch: FetchImplementation = (input, init) => globalThis.fetch(input, init);

function classifyHttpFailure(
  status: number,
  body: z.infer<typeof SaveErrorSchema> | null,
): SaveTransportError {
  const options = {
    status,
    ...(body?.code ? { code: body.code } : {}),
    ...(body?.traceId ? { traceId: body.traceId } : {}),
  };
  const message = body?.message ?? '保存服务返回了无法识别的错误';
  if (status === 401 || status === 403) return new SaveTransportError('auth', message, options);
  if (status === 412) {
    const currentRevision = body?.details?.currentRevision;
    return new SaveTransportError('conflict', message, {
      ...options,
      ...(typeof currentRevision === 'string' ? { currentRevision } : {}),
    });
  }
  if (status === 422) return new SaveTransportError('validation', message, options);
  if (body?.retryable || status === 408 || status === 425 || status === 429 || status >= 500) {
    return new SaveTransportError('retryable', message, options);
  }
  return new SaveTransportError('fatal', message, options);
}

export class HttpSaveTransport implements SaveTransport {
  constructor(private readonly fetchImplementation: FetchImplementation = defaultFetch) {}

  async save(envelope: PendingSaveEnvelope, signal?: AbortSignal): Promise<SaveReceipt> {
    const relativeEndpoint = `/api/v1/resumes/${encodeURIComponent(envelope.resumeId)}/document`;
    let response: Response;
    try {
      const endpoint =
        typeof globalThis.location?.href === 'string'
          ? new URL(relativeEndpoint, globalThis.location.href)
          : relativeEndpoint;
      response = await this.fetchImplementation(endpoint, {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': envelope.idempotencyKey,
          'If-Match': `"${envelope.baseRevision}"`,
        },
        body: JSON.stringify({
          document: envelope.document,
          clientSeq: envelope.clientSeq,
        }),
        cache: 'no-store',
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new SaveTransportError('aborted', '保存请求已取消', { cause: error });
      }
      throw new SaveTransportError('network', '无法连接保存服务', { cause: error });
    }

    let rawBody: unknown = null;
    try {
      rawBody = await response.json();
    } catch {
      // 无效响应体会在下方按协议错误处理。
    }

    if (!response.ok) {
      const parsedError = SaveErrorSchema.safeParse(rawBody);
      throw classifyHttpFailure(response.status, parsedError.success ? parsedError.data : null);
    }

    const parsed = SaveSuccessSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new SaveTransportError('fatal', '保存回执格式无效');
    }
    const receipt = parsed.data.data;
    const etag = response.headers.get('etag');
    if (
      receipt.resumeId !== envelope.resumeId ||
      receipt.acknowledgedSeq !== envelope.clientSeq ||
      etag !== `"${receipt.revision}"`
    ) {
      throw new SaveTransportError('fatal', '保存回执与请求不匹配', {
        traceId: parsed.data.traceId,
      });
    }
    return receipt;
  }
}
