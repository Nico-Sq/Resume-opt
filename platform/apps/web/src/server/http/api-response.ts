import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';
import { z } from 'zod';

export interface ApiFieldError {
  path: string;
  code: string;
  message: string;
}

export interface ApiErrorOptions {
  retryable?: boolean;
  fieldErrors?: ApiFieldError[];
  details?: Record<string, string | number>;
  headers?: HeadersInit;
}

export function traceIdFrom(request: Request): string {
  const candidate = request.headers.get('x-request-id');
  return candidate && z.uuid().safeParse(candidate).success ? candidate : randomUUID();
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  traceId: string,
  options: ApiErrorOptions = {},
) {
  const body: {
    code: string;
    message: string;
    traceId: string;
    retryable: boolean;
    fieldErrors?: ApiFieldError[];
    details?: Record<string, string | number>;
  } = {
    code,
    message,
    traceId,
    retryable: options.retryable ?? false,
  };
  if (options.fieldErrors) body.fieldErrors = options.fieldErrors;
  if (options.details) body.details = options.details;
  const headers = new Headers(options.headers);
  headers.set('Cache-Control', 'private, no-store');
  return NextResponse.json(body, { status, headers });
}
