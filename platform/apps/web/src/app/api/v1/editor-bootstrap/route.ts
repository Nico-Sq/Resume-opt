import { NextResponse } from 'next/server';

import { respondWithResume } from '@/server/http/resume-response';
import { getServerRuntimeConfig } from '@/server/runtime';

export async function GET(request: Request) {
  try {
    const config = getServerRuntimeConfig();
    if (!config.DEV_FIXED_RESUME_ID) throw new Error('缺少固定简历 ID');
    return await respondWithResume(request, config.DEV_FIXED_RESUME_ID);
  } catch {
    return NextResponse.json(
      {
        code: 'DEVELOPMENT_BOOTSTRAP_UNAVAILABLE',
        message: '开发启动入口不可用',
        traceId: crypto.randomUUID(),
        retryable: false,
      },
      { status: 503 },
    );
  }
}
