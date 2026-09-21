import {
  AuthenticationRequiredError,
  IdempotencyKeyReusedError,
  IdempotencyRequestInProgressError,
  InvalidCopyResumeRequestError,
  ResourceNotFoundError,
  RevisionConflictError,
  TemplateUnavailableError,
  type CopyResume,
} from '@resume/application';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { errorResponse, traceIdFrom } from './api-response';
import { rejectUnsafeCookieWrite } from './csrf-response';
import { PayloadTooLargeError, readJsonBody } from './json-request';
import {
  getCopyResumeUseCase,
  getRequestSessionProvider,
  getServerRuntimeConfig,
} from '../runtime';

const ResumeIdSchema = z.uuid();
const IdempotencyKeySchema = z.uuid();
const CopyBodySchema = z.strictObject({ sourceRevision: z.string(), title: z.string() });
type CopyExecutor = Pick<CopyResume, 'execute'>;

export async function respondToCopyResume(
  request: Request,
  sourceResumeId: string,
  executor?: CopyExecutor,
) {
  const traceId = traceIdFrom(request);
  if (!executor) {
    const config = getServerRuntimeConfig();
    if (config.AUTH_MODE === 'better-auth') {
      if (!config.BETTER_AUTH_URL) throw new Error('真实身份服务未配置');
      const rejected = await rejectUnsafeCookieWrite(
        request,
        config.BETTER_AUTH_URL,
        getRequestSessionProvider(request.headers),
      );
      if (rejected) return rejected;
    }
    executor = getCopyResumeUseCase(request.headers);
  }
  if (!ResumeIdSchema.safeParse(sourceResumeId).success) {
    return errorResponse(400, 'INVALID_RESOURCE_ID', '简历 ID 格式无效', traceId);
  }
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey) {
    return errorResponse(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少 Idempotency-Key', traceId);
  }
  if (!IdempotencyKeySchema.safeParse(idempotencyKey).success) {
    return errorResponse(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key 格式无效', traceId);
  }
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', '请求体必须是 application/json', traceId);
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(request);
  } catch (error) {
    return error instanceof PayloadTooLargeError
      ? errorResponse(413, 'PAYLOAD_TOO_LARGE', '请求体超过 1 MiB', traceId)
      : errorResponse(400, 'INVALID_JSON', '请求体不是有效的 UTF-8 JSON', traceId);
  }
  const body = CopyBodySchema.safeParse(rawBody);
  if (!body.success) {
    return errorResponse(422, 'INVALID_SCHEMA', '复制简历请求无效', traceId, {
      fieldErrors: body.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
  }

  try {
    const result = await executor.execute({
      ...body.data,
      sourceResumeId,
      idempotencyKey,
      traceId,
    });
    const headers: Record<string, string> = {
      'Cache-Control': 'private, no-store',
      ETag: `"${result.resume.revision}"`,
      Location: `/api/v1/resumes/${result.resume.id}`,
    };
    if (result.replayed) headers['Idempotency-Replayed'] = 'true';
    return NextResponse.json({ data: result.resume, traceId }, { status: 201, headers });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return errorResponse(401, error.code, error.message, traceId);
    }
    if (error instanceof InvalidCopyResumeRequestError) {
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
    return errorResponse(500, 'INTERNAL_ERROR', '复制简历服务暂时不可用', traceId, {
      retryable: true,
    });
  }
}
