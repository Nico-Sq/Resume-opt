import {
  AuthenticationRequiredError,
  ResourceNotFoundError,
  StoredResumeInvalidError,
  type GetResumeForEditor,
} from '@resume/application';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getResumeForEditorUseCase } from '../runtime';
import { errorResponse, traceIdFrom } from './api-response';

const ResumeIdSchema = z.uuid();
type ResumeExecutor = Pick<GetResumeForEditor, 'execute'>;

export async function respondWithResume(
  request: Request,
  resumeId: string,
  executor?: ResumeExecutor,
) {
  const traceId = traceIdFrom(request);
  if (!ResumeIdSchema.safeParse(resumeId).success) {
    return errorResponse(400, 'INVALID_RESOURCE_ID', '简历 ID 格式无效', traceId);
  }

  try {
    const resume = await (executor ?? getResumeForEditorUseCase(request.headers)).execute(resumeId);
    return NextResponse.json(
      { data: resume, traceId },
      {
        headers: {
          'Cache-Control': 'private, no-store',
          ETag: `"${resume.revision}"`,
        },
      },
    );
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return errorResponse(401, error.code, error.message, traceId);
    }
    if (error instanceof ResourceNotFoundError) {
      return errorResponse(404, error.code, error.message, traceId);
    }
    if (error instanceof StoredResumeInvalidError) {
      return errorResponse(500, error.code, error.message, traceId);
    }
    return errorResponse(500, 'INTERNAL_ERROR', '服务暂时不可用', traceId, {
      retryable: true,
    });
  }
}
