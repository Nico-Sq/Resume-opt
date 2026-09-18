import {
  IdempotencyKeyReusedError,
  IdempotencyRequestInProgressError,
  InvalidSaveRequestError,
  ResourceNotFoundError,
  RevisionConflictError,
  TemplateUnavailableError,
  type SaveResumeDocument,
} from '@resume/application';
import { ResumeDocumentV1Schema } from '@resume/domain/resume';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { errorResponse, traceIdFrom } from './api-response';
import { getSaveResumeDocumentUseCase } from '../runtime';

const MAX_JSON_BYTES = 1_048_576;
const ResumeIdSchema = z.uuid();
const IdempotencyKeySchema = z.uuid();
const SaveBodySchema = z.strictObject({
  document: ResumeDocumentV1Schema,
  clientSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

type SaveExecutor = Pick<SaveResumeDocument, 'execute'>;

function parseRevision(
  header: string | null,
): { success: true; revision: string } | { success: false; missing: boolean } {
  if (header === null) return { success: false, missing: true };
  const match = /^"([1-9][0-9]*)"$/u.exec(header);
  if (!match?.[1] || BigInt(match[1]) > 9_223_372_036_854_775_807n) {
    return { success: false, missing: false };
  }
  return { success: true, revision: match[1] };
}

async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > MAX_JSON_BYTES) {
    throw new PayloadTooLargeError();
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_BYTES) throw new PayloadTooLargeError();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidJsonError();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidJsonError();
  }
}

class PayloadTooLargeError extends Error {}
class InvalidJsonError extends Error {}

export async function respondToSaveResume(
  request: Request,
  resumeId: string,
  executor: SaveExecutor = getSaveResumeDocumentUseCase(),
) {
  const traceId = traceIdFrom(request);
  if (!ResumeIdSchema.safeParse(resumeId).success) {
    return errorResponse(400, 'INVALID_RESOURCE_ID', '简历 ID 格式无效', traceId);
  }

  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey) {
    return errorResponse(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少 Idempotency-Key', traceId);
  }
  if (!IdempotencyKeySchema.safeParse(idempotencyKey).success) {
    return errorResponse(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key 格式无效', traceId);
  }

  const revision = parseRevision(request.headers.get('if-match'));
  if (!revision.success) {
    return revision.missing
      ? errorResponse(428, 'IF_MATCH_REQUIRED', '缺少 If-Match', traceId)
      : errorResponse(400, 'INVALID_IF_MATCH', 'If-Match 必须是强 ETag revision', traceId);
  }

  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', '请求体必须是 application/json', traceId);
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(request);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return errorResponse(413, 'PAYLOAD_TOO_LARGE', '请求体超过 1 MiB', traceId);
    }
    return errorResponse(400, 'INVALID_JSON', '请求体不是有效的 UTF-8 JSON', traceId);
  }

  const body = SaveBodySchema.safeParse(rawBody);
  if (!body.success) {
    return errorResponse(422, 'INVALID_SCHEMA', '保存内容不符合简历结构要求', traceId, {
      fieldErrors: body.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
  }

  try {
    const result = await executor.execute({
      resumeId,
      idempotencyKey,
      baseRevision: revision.revision,
      clientSeq: body.data.clientSeq,
      document: body.data.document,
      traceId,
    });
    const headers: Record<string, string> = {
      'Cache-Control': 'private, no-store',
      ETag: `"${result.receipt.revision}"`,
    };
    if (result.replayed) headers['Idempotency-Replayed'] = 'true';
    return NextResponse.json({ data: result.receipt, traceId }, { headers });
  } catch (error) {
    if (error instanceof InvalidSaveRequestError) {
      return errorResponse(422, error.code, error.message, traceId, {
        fieldErrors: error.fieldErrors,
      });
    }
    if (error instanceof ResourceNotFoundError) {
      return errorResponse(404, error.code, error.message, traceId);
    }
    if (error instanceof RevisionConflictError) {
      return errorResponse(412, error.code, error.message, traceId, {
        details: { currentRevision: error.currentRevision },
      });
    }
    if (error instanceof IdempotencyKeyReusedError) {
      return errorResponse(409, error.code, error.message, traceId);
    }
    if (error instanceof IdempotencyRequestInProgressError) {
      return errorResponse(409, error.code, error.message, traceId, { retryable: true });
    }
    if (error instanceof TemplateUnavailableError) {
      return errorResponse(409, error.code, error.message, traceId);
    }
    return errorResponse(500, 'INTERNAL_ERROR', '保存服务暂时不可用', traceId, {
      retryable: true,
    });
  }
}
