import type { SessionProvider } from '@resume/application';
import { NextResponse } from 'next/server';

import { errorResponse, traceIdFrom } from './api-response';
import { getRequestSessionProvider } from '../runtime';

export async function respondWithSession(request: Request, provider?: SessionProvider) {
  const traceId = traceIdFrom(request);
  try {
    const session = await (provider ?? getRequestSessionProvider(request.headers)).getSession();
    const data = session
      ? {
          userId: session.userId,
          displayName: session.displayName,
          emailVerified: session.emailVerified,
        }
      : null;
    return NextResponse.json(
      { data, traceId },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch {
    return errorResponse(503, 'SESSION_UNAVAILABLE', '会话服务暂时不可用', traceId, {
      retryable: true,
    });
  }
}
