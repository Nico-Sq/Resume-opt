import { createHash } from 'node:crypto';

import type { AccountDeletionReceipt } from '@resume/infrastructure/account-deletion';
import type {
  AuthoritativeAuthSession,
  BetterAuthSessionProvider,
} from '@resume/infrastructure/better-auth-server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { errorResponse, traceIdFrom } from './api-response';
import { rejectUnsafeCookieWrite } from './csrf-response';
import { InvalidJsonError, PayloadTooLargeError, readJsonBody } from './json-request';

const DeleteAccountSchema = z
  .object({ confirm: z.literal(true), password: z.string().min(1).max(200) })
  .strict();
const requestHash = createHash('sha256').update('{"confirm":true}').digest('hex');
const RECENT_AUTH_MS = 10 * 60 * 1_000;

export interface AccountDeletionSessionProvider {
  getAuthoritativeSession(): Promise<AuthoritativeAuthSession | null>;
  getCsrfToken(): Promise<string | null>;
  getSession(): ReturnType<BetterAuthSessionProvider['getSession']>;
  revokeAllSessions(userId: string): Promise<void>;
  verifyCurrentPassword(password: string): Promise<boolean>;
}

export interface AccountDeletionRequestStore {
  accept(input: {
    userId: string;
    idempotencyKey: string;
    requestHash: string;
    traceId: string;
  }): Promise<AccountDeletionReceipt | 'key_reused' | 'not_found'>;
  recordAuthRevocation(userId: string, requestId: string, errorCode?: string): Promise<void>;
}

export async function respondToDeleteAccount(
  request: Request,
  provider: AccountDeletionSessionProvider,
  requests: AccountDeletionRequestStore,
  trustedOrigin: string,
  now = Date.now(),
): Promise<Response> {
  const traceId = traceIdFrom(request);
  const unsafe = await rejectUnsafeCookieWrite(request, trustedOrigin, provider);
  if (unsafe) return unsafe;

  const key = request.headers.get('idempotency-key');
  if (!key || !z.uuid().safeParse(key).success) {
    return errorResponse(400, 'IDEMPOTENCY_KEY_REQUIRED', '需要有效的幂等键', traceId);
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return errorResponse(413, 'PAYLOAD_TOO_LARGE', '请求体过大', traceId);
    }
    if (error instanceof InvalidJsonError) {
      return errorResponse(400, 'INVALID_JSON', '请求体不是有效 JSON', traceId);
    }
    throw error;
  }
  const parsed = DeleteAccountSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(422, 'VALIDATION_FAILED', '必须确认注销并输入当前密码', traceId);
  }

  try {
    const session = await provider.getAuthoritativeSession();
    if (!session?.emailVerified) {
      return errorResponse(401, 'AUTHENTICATION_REQUIRED', '需要已验证的登录会话', traceId);
    }
    if (now - session.createdAt.getTime() >= RECENT_AUTH_MS) {
      return errorResponse(
        401,
        'REAUTHENTICATION_REQUIRED',
        '登录时间已超过 10 分钟，请重新登录后再注销账户',
        traceId,
      );
    }
    if (!(await provider.verifyCurrentPassword(parsed.data.password))) {
      return errorResponse(401, 'PASSWORD_INVALID', '当前密码不正确', traceId);
    }

    const receipt = await requests.accept({
      userId: session.userId,
      idempotencyKey: key,
      requestHash,
      traceId,
    });
    if (receipt === 'key_reused') {
      return errorResponse(409, 'IDEMPOTENCY_KEY_REUSED', '幂等键已用于不同请求', traceId);
    }
    if (receipt === 'not_found') {
      return errorResponse(401, 'AUTHENTICATION_REQUIRED', '账户已不可用', traceId);
    }

    try {
      await provider.revokeAllSessions(session.userId);
      await requests.recordAuthRevocation(session.userId, receipt.requestId);
    } catch {
      try {
        await requests.recordAuthRevocation(
          session.userId,
          receipt.requestId,
          'AUTH_SESSION_REVOCATION_FAILED',
        );
      } catch {
        // 受理和业务停用已经提交，记录失败不能把不可逆结果伪装成未受理。
      }
    }

    return NextResponse.json(
      {
        data: {
          requestId: receipt.requestId,
          status: 'accepted',
          acceptedAt: receipt.requestedAt,
        },
        traceId,
      },
      { status: 202, headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch {
    return errorResponse(503, 'ACCOUNT_DELETION_UNAVAILABLE', '账户注销暂时无法受理', traceId, {
      retryable: true,
    });
  }
}
