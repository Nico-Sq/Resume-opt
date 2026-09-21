import {
  AuthenticationRequiredError,
  InvalidResumeCursorError,
  InvalidResumeListRequestError,
  type ListResumes,
} from '@resume/application';
import { NextResponse } from 'next/server';

import { errorResponse, traceIdFrom } from './api-response';
import { getListResumesUseCase } from '../runtime';

type ListExecutor = Pick<ListResumes, 'execute'>;

export async function respondToListResumes(request: Request, executor?: ListExecutor) {
  const traceId = traceIdFrom(request);
  const searchParams = new URL(request.url).searchParams;
  if (
    [...searchParams.keys()].some((key) => !['cursor', 'limit'].includes(key)) ||
    [...new Set(searchParams.keys())].some((key) => searchParams.getAll(key).length !== 1)
  ) {
    return errorResponse(400, 'INVALID_QUERY', '分页参数无效', traceId);
  }
  const cursor = searchParams.get('cursor') ?? undefined;
  const rawLimit = searchParams.get('limit');
  const limit = rawLimit === null ? undefined : Number(rawLimit);

  try {
    const result = await (executor ?? getListResumesUseCase(request.headers)).execute({
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
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
      error instanceof InvalidResumeCursorError ||
      error instanceof InvalidResumeListRequestError
    ) {
      return errorResponse(400, error.code, error.message, traceId);
    }
    return errorResponse(500, 'INTERNAL_ERROR', '简历列表服务暂时不可用', traceId, {
      retryable: true,
    });
  }
}
