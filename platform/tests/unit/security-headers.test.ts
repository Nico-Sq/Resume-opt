import { describe, expect, it } from 'vitest';

import nextConfig from '../../apps/web/next.config';

describe('web security headers', () => {
  it('applies a restrictive CSP and browser hardening headers to every route', async () => {
    if (!nextConfig.headers) throw new Error('安全响应头未配置');
    const routes = await nextConfig.headers();
    const route = routes.find((candidate) => candidate.source === '/(.*)');
    const headers = new Map(route?.headers.map(({ key, value }) => [key, value]));
    const policy = headers.get('Content-Security-Policy');

    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toMatch(/https?:\/\//u);
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(headers.get('Permissions-Policy')).toContain('camera=()');
  });
});
