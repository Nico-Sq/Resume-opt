import {
  AuthenticationRequiredError,
  IdempotencyKeyReusedError,
  IdempotencyRequestInProgressError,
  InvalidCreateResumeRequestError,
  ResourceNotFoundError,
  TemplateUnavailableError,
  type CreateResume,
} from '@resume/application';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { errorResponse, traceIdFrom } from './api-response';
import { rejectUnsafeCookieWrite } from './csrf-response';
import { PayloadTooLargeError, readJsonBody } from './json-request';
import {
  getCreateResumeUseCase,
  getRequestSessionProvider,
  getServerRuntimeConfig,
} from '../runtime';

const IdempotencyKeySchema = z.uuid();
const CreateBodySchema = z.strictObject({
  title: z.string(),
  stage: z.enum(['student', 'employed', 'transition']),
  mode: z.enum(['blank', 'basic-template']),
});
type CreateExecutor = Pick<CreateResume, 'execute'>;

export async function respondToCreateResume(request: Request, executor?: CreateExecutor) {
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
    executor = getCreateResumeUseCase(request.headers);
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
  const body = CreateBodySchema.safeParse(rawBody);
  if (!body.success) {
    return errorResponse(422, 'INVALID_SCHEMA', '新建简历请求无效', traceId, {
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
    if (error instanceof InvalidCreateResumeRequestError) {
      return errorResponse(422, error.code, error.message, traceId, {
        fieldErrors: error.fieldErrors,
      });
    }
    if (error instanceof ResourceNotFoundError) {
      return errorResponse(404, error.code, error.message, traceId);
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
    return errorResponse(500, 'INTERNAL_ERROR', '新建简历服务暂时不可用', traceId, {
      retryable: true,
    });
  }
}
