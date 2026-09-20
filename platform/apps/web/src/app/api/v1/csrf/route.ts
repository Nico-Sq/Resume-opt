import { errorResponse, traceIdFrom } from '@/server/http/api-response';
import { respondWithCsrf } from '@/server/http/csrf-response';
import { getRequestSessionProvider } from '@/server/runtime';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    return await respondWithCsrf(request, getRequestSessionProvider(request.headers));
  } catch {
    return errorResponse(503, 'SESSION_UNAVAILABLE', '会话服务暂时不可用', traceIdFrom(request), {
      retryable: true,
    });
  }
}
