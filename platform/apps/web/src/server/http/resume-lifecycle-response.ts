import {
  AuthenticationRequiredError,
  IdempotencyKeyReusedError,
  IdempotencyRequestInProgressError,
  InvalidDeletedResumeCursorError,
  InvalidDeletedResumeListRequestError,
  InvalidResumeLifecycleRequestError,
  ResourceNotFoundError,
  RestoreWindowExpiredError,
  RevisionConflictError,
  type DeleteResume,
  type ListDeletedResumes,
  type UndeleteResume,
} from '@resume/application';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { errorResponse, traceIdFrom } from './api-response';
import { rejectUnsafeCookieWrite } from './csrf-response';
import { PayloadTooLargeError, readJsonBody } from './json-request';
import { parseRevision } from './save-resume-response';
import {
  getDeleteResumeUseCase,
  getListDeletedResumesUseCase,
  getRequestSessionProvider,
  getServerRuntimeConfig,
  getUndeleteResumeUseCase,
} from '../runtime';

const ResumeIdSchema = z.uuid();
const IdempotencyKeySchema = z.uuid();
const DeleteBodySchema = z.strictObject({ confirm: z.literal(true) });
const UndeleteBodySchema = z.strictObject({});
type DeleteExecutor = Pick<DeleteResume, 'execute'>;
type UndeleteExecutor = Pick<UndeleteResume, 'execute'>;

async function validateWrite(
  request: Request,
  resumeId: string,
  schema: typeof DeleteBodySchema | typeof UndeleteBodySchema,
  skipCsrf: boolean,
) {
  const traceId = traceIdFrom(request);
  if (!skipCsrf) {
    const config = getServerRuntimeConfig();
    if (config.AUTH_MODE === 'better-auth') {
      if (!config.BETTER_AUTH_URL) throw new Error('真实身份服务未配置');
      const rejected = await rejectUnsafeCookieWrite(
        request,
        config.BETTER_AUTH_URL,
        getRequestSessionProvider(request.headers),
      );
      if (rejected) return { response: rejected };
    }
  }
  if (!ResumeIdSchema.safeParse(resumeId).success) {
    return { response: errorResponse(400, 'INVALID_RESOURCE_ID', '简历 ID 格式无效', traceId) };
  }
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey) {
    return {
      response: errorResponse(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少 Idempotency-Key', traceId),
    };
  }
  if (!IdempotencyKeySchema.safeParse(idempotencyKey).success) {
    return {
      response: errorResponse(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key 格式无效', traceId),
    };
  }
  const revision = parseRevision(request.headers.get('if-match'));
  if (!revision.success) {
    return {
      response: revision.missing
        ? errorResponse(428, 'IF_MATCH_REQUIRED', '缺少 If-Match', traceId)
        : errorResponse(400, 'INVALID_IF_MATCH', 'If-Match 必须是强 ETag revision', traceId),
    };
  }
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return {
      response: errorResponse(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        '请求体必须是 application/json',
        traceId,
      ),
    };
  }
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(request);
  } catch (error) {
    return {
      response:
        error instanceof PayloadTooLargeError
          ? errorResponse(413, 'PAYLOAD_TOO_LARGE', '请求体超过 1 MiB', traceId)
          : errorResponse(400, 'INVALID_JSON', '请求体不是有效的 UTF-8 JSON', traceId),
    };
  }
  const body = schema.safeParse(rawBody);
  if (!body.success) {
    return {
      response: errorResponse(422, 'INVALID_SCHEMA', '简历删除或恢复请求无效', traceId),
    };
  }
  return { traceId, idempotencyKey, revision: revision.revision, body: body.data };
}

function lifecycleError(error: unknown, traceId: string, service: string) {
  if (error instanceof AuthenticationRequiredError) {
    return errorResponse(401, error.code, error.message, traceId);
  }
  if (error instanceof InvalidResumeLifecycleRequestError) {
    return errorResponse(422, error.code, error.message, traceId);
  }
  if (error instanceof ResourceNotFoundError) {
    return errorResponse(404, error.code, error.message, traceId);
  }
  if (error instanceof RevisionConflictError) {
    return errorResponse(412, error.code, error.message, traceId, {
      details: { currentRevision: error.currentRevision },
    });
  }
  if (error instanceof RestoreWindowExpiredError) {
    return errorResponse(410, error.code, error.message, traceId);
  }
  if (error instanceof IdempotencyKeyReusedError) {
    return errorResponse(409, error.code, error.message, traceId);
  }
  if (error instanceof IdempotencyRequestInProgressError) {
    return errorResponse(409, error.code, error.message, traceId, { retryable: true });
  }
  return errorResponse(500, 'INTERNAL_ERROR', `${service}暂时不可用`, traceId, {
    retryable: true,
  });
}

export async function respondToDeleteResume(
  request: Request,
  resumeId: string,
  executor?: DeleteExecutor,
) {
  const checked = await validateWrite(request, resumeId, DeleteBodySchema, Boolean(executor));
  if ('response' in checked) return checked.response;
  try {
    const result = await (executor ?? getDeleteResumeUseCase(request.headers)).execute({
      resumeId,
      idempotencyKey: checked.idempotencyKey,
      baseRevision: checked.revision,
      traceId: checked.traceId,
      confirm: true,
    });
    const headers: Record<string, string> = {
      'Cache-Control': 'private, no-store',
      ETag: `"${result.revision}"`,
    };
    if (result.replayed) headers['Idempotency-Replayed'] = 'true';
    return NextResponse.json(
      {
        data: {
          id: result.id,
          revision: result.revision,
          deletedAt: result.deletedAt,
          restoreUntil: result.restoreUntil,
        },
        traceId: checked.traceId,
      },
      { headers },
    );
  } catch (error) {
    return lifecycleError(error, checked.traceId, '简历删除服务');
  }
}

export async function respondToUndeleteResume(
  request: Request,
  resumeId: string,
  executor?: UndeleteExecutor,
) {
  const checked = await validateWrite(request, resumeId, UndeleteBodySchema, Boolean(executor));
  if ('response' in checked) return checked.response;
  try {
    const result = await (executor ?? getUndeleteResumeUseCase(request.headers)).execute({
      resumeId,
      idempotencyKey: checked.idempotencyKey,
      baseRevision: checked.revision,
      traceId: checked.traceId,
    });
    const headers: Record<string, string> = {
      'Cache-Control': 'private, no-store',
      ETag: `"${result.resume.revision}"`,
    };
    if (result.replayed) headers['Idempotency-Replayed'] = 'true';
    return NextResponse.json(
      { data: { resume: result.resume }, traceId: checked.traceId },
      { headers },
    );
  } catch (error) {
    return lifecycleError(error, checked.traceId, '简历恢复服务');
  }
}

export async function respondToListDeletedResumes(
  request: Request,
  executor?: Pick<ListDeletedResumes, 'execute'>,
) {
  const traceId = traceIdFrom(request);
  const searchParams = new URL(request.url).searchParams;
  if (
    [...searchParams.keys()].some((key) => !['cursor', 'limit'].includes(key)) ||
    [...new Set(searchParams.keys())].some((key) => searchParams.getAll(key).length !== 1)
  ) {
    return errorResponse(400, 'INVALID_QUERY', '回收站分页参数无效', traceId);
  }
  const cursor = searchParams.get('cursor') ?? undefined;
  const rawLimit = searchParams.get('limit');
  try {
    const result = await (executor ?? getListDeletedResumesUseCase(request.headers)).execute({
      ...(cursor ? { cursor } : {}),
      ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
    });
    return NextResponse.json(
      { data: result, traceId },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return errorResponse(401, error.code, error.message, traceId);
    }
    if (
      error instanceof InvalidDeletedResumeCursorError ||
      error instanceof InvalidDeletedResumeListRequestError
    ) {
      return errorResponse(400, error.code, error.message, traceId);
    }
    return errorResponse(500, 'INTERNAL_ERROR', '回收站列表服务暂时不可用', traceId, {
      retryable: true,
    });
  }
}
