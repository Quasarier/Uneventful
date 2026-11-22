import { NextRequest, NextResponse } from 'next/server';

function createContentSecurityPolicy(
  nonce: string,
  apiOrigin: string,
  production: boolean,
): string {
  const socketOrigin = new URL(apiOrigin);
  socketOrigin.protocol = socketOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "script-src-attr 'none'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${apiOrigin} ${socketOrigin.origin}`,
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    ...(production ? ['upgrade-insecure-requests'] : []),
  ];
  return directives.join('; ');
}

export function middleware(request: NextRequest) {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!apiBaseUrl) {
    throw new Error('NEXT_PUBLIC_API_BASE_URL is required to build the content security policy.');
  }
  const apiUrl = new URL(apiBaseUrl);
  if (apiUrl.protocol !== 'http:' && apiUrl.protocol !== 'https:') {
    throw new Error('NEXT_PUBLIC_API_BASE_URL must use HTTP or HTTPS.');
  }

  const nonce = btoa(crypto.randomUUID());
  const production = process.env.NODE_ENV === 'production';
  const policy = createContentSecurityPolicy(nonce, apiUrl.origin, production);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Content-Security-Policy', policy);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(
    production ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
    policy,
  );
  const isScannerRoute = /^\/events\/[^/]+\/scanner\/?$/.test(request.nextUrl.pathname);
  response.headers.set(
    'Permissions-Policy',
    isScannerRoute
      ? 'camera=(self), microphone=(), geolocation=()'
      : 'camera=(), microphone=(), geolocation=()',
  );
  if (request.nextUrl.pathname === '/auth/popup') {
    response.headers.set('Cross-Origin-Opener-Policy', 'unsafe-none');
  }
  if (production) {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000');
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
