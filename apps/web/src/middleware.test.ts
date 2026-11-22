import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

describe('security middleware', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses report-only CSP and omits HSTS outside production', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'http://localhost:3001/api/v1');

    const response = middleware(new NextRequest('http://localhost:3000/events'));

    expect(response.headers.has('Content-Security-Policy-Report-Only')).toBe(true);
    expect(response.headers.has('Strict-Transport-Security')).toBe(false);
    expect(response.headers.get('Content-Security-Policy-Report-Only')).toContain(
      "connect-src 'self' http://localhost:3001 ws://localhost:3001",
    );
    expect(response.headers.get('Content-Security-Policy-Report-Only')).not.toContain(' *');
  });

  it('allows camera access only on the dedicated event scanner route', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'http://localhost:3001/api/v1');

    const scanner = middleware(
      new NextRequest('http://localhost:3000/events/45b7f5a1-4de0-4bfc-b3a0-918f89375c10/scanner'),
    );
    const eventPage = middleware(new NextRequest('http://localhost:3000/events'));

    expect(scanner.headers.get('Permissions-Policy')).toBe(
      'camera=(self), microphone=(), geolocation=()',
    );
    expect(eventPage.headers.get('Permissions-Policy')).toBe(
      'camera=(), microphone=(), geolocation=()',
    );
    expect(scanner.headers.get('Content-Security-Policy-Report-Only')).toContain(
      "frame-ancestors 'none'",
    );
  });
});
