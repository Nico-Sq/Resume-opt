import { randomUUID } from 'node:crypto';

import { ResourceNotFoundError, StoredResumeInvalidError } from '@resume/application';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getResumeForEditorUseCase } from '@/server/runtime';

const ResumeIdSchema = z.uuid();

function traceIdFrom(request: Request) {
  const candidate = request.headers.get('x-request-id');
  return candidate && z.uuid().safeParse(candidate).success ? candidate : randomUUID();
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  traceId: string,
  retryable = false,
) {
  return NextResponse.json({ code, message, traceId, retryable }, { status });
}

export async function respondWithResume(request: Request, resumeId: string) {
  const traceId = traceIdFrom(request);
  if (!ResumeIdSchema.safeParse(resumeId).success) {
    return errorResponse(400, 'INVALID_RESOURCE_ID', '简历 ID 格式无效', traceId);
  }

  try {
    const resume = await getResumeForEditorUseCase().execute(resumeId);
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
    if (error instanceof ResourceNotFoundError) {
      return errorResponse(404, error.code, error.message, traceId);
    }
    if (error instanceof StoredResumeInvalidError) {
      return errorResponse(500, error.code, error.message, traceId);
    }
    return errorResponse(500, 'INTERNAL_ERROR', '服务暂时不可用', traceId, true);
  }
}
