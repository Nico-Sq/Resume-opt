import { handleBetterAuthRequest } from '@resume/infrastructure/better-auth-server';

import { errorResponse, traceIdFrom } from '@/server/http/api-response';
import { getBetterAuthServer, getRequestSessionProvider } from '@/server/runtime';

export const runtime = 'nodejs';

async function handle(request: Request) {
  try {
    return await handleBetterAuthRequest(
      getBetterAuthServer(),
      request,
      getRequestSessionProvider(request.headers),
    );
  } catch {
    return errorResponse(503, 'AUTH_UNAVAILABLE', '认证服务暂时不可用', traceIdFrom(request), {
      retryable: true,
    });
  }
}

export const GET = handle;
export const POST = handle;
