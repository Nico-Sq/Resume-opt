const DEFAULT_RETURN_TO = '/resumes';
const RETURN_ORIGIN = 'https://resume.local';

export type AuthPostPath =
  | 'sign-in/email'
  | 'sign-up/email'
  | 'send-verification-email'
  | 'request-password-reset'
  | 'reset-password';

export function safeReturnTo(value?: string): string {
  if (!value?.startsWith('/') || value.startsWith('//')) return DEFAULT_RETURN_TO;
  const url = new URL(value, RETURN_ORIGIN);
  if (url.origin !== RETURN_ORIGIN) return DEFAULT_RETURN_TO;
  if (
    url.pathname !== '/' &&
    url.pathname !== '/resumes' &&
    !url.pathname.startsWith('/resumes/') &&
    url.pathname !== '/account'
  ) {
    return DEFAULT_RETURN_TO;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

export function postAuth(path: AuthPostPath, body: Record<string, unknown>): Promise<Response> {
  return fetch(`/api/auth/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
