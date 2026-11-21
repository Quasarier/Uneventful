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
  });
});
