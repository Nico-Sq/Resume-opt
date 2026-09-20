import { timingSafeEqual } from 'node:crypto';

import type { SessionProvider } from '@resume/application';
import { NextResponse } from 'next/server';

import { errorResponse, traceIdFrom } from './api-response';

export interface CsrfSessionProvider extends SessionProvider {
  getCsrfToken(): Promise<string | null>;
}

function tokensMatch(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export async function respondWithCsrf(
  request: Request,
  provider: CsrfSessionProvider,
): Promise<Response> {
  const traceId = traceIdFrom(request);
  try {
    const [session, csrfToken] = await Promise.all([
      provider.getSession(),
      provider.getCsrfToken(),
    ]);
    if (!session?.emailVerified || !csrfToken) {
      return errorResponse(401, 'AUTHENTICATION_REQUIRED', '需要已验证的登录会话', traceId);
    }
    return NextResponse.json(
      { data: { csrfToken }, traceId },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch {
    return errorResponse(503, 'SESSION_UNAVAILABLE', '会话服务暂时不可用', traceId, {
      retryable: true,
    });
  }
}

export async function rejectUnsafeCookieWrite(
  request: Request,
  trustedOrigin: string,
  provider: CsrfSessionProvider,
): Promise<Response | null> {
  const traceId = traceIdFrom(request);
  if (request.headers.get('origin') !== new URL(trustedOrigin).origin) {
    return errorResponse(403, 'ORIGIN_FORBIDDEN', '请求来源不受信任', traceId);
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin') {
    return errorResponse(403, 'CROSS_SITE_FORBIDDEN', '拒绝跨站写请求', traceId);
  }
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', '请求体必须是 application/json', traceId);
  }

  try {
    const [session, expectedToken] = await Promise.all([
      provider.getSession(),
      provider.getCsrfToken(),
    ]);
    if (!session?.emailVerified || !expectedToken) {
      return errorResponse(401, 'AUTHENTICATION_REQUIRED', '需要已验证的登录会话', traceId);
    }
    const suppliedToken = request.headers.get('x-csrf-token');
    if (!suppliedToken || !tokensMatch(suppliedToken, expectedToken)) {
      return errorResponse(403, 'CSRF_TOKEN_INVALID', 'CSRF Token 无效', traceId);
    }
    return null;
  } catch {
    return errorResponse(503, 'SESSION_UNAVAILABLE', '会话服务暂时不可用', traceId, {
      retryable: true,
    });
  }
}
