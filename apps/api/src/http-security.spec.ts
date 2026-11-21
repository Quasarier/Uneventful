import helmet from 'helmet';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createCorsOptions, helmetOptions } from './http-security';

describe('HTTP security configuration', () => {
  it('allows credentialed CORS only from the configured web origin', () => {
    const options = createCorsOptions('https://campus.example.edu');

    expect(options.origin).toEqual(['https://campus.example.edu']);
    expect(options.origin).not.toContain('*');
    expect(options.credentials).toBe(true);
    expect(options.allowedHeaders).toContain('X-Uneventful-CSRF');
    expect(options.methods).toContain('DELETE');
  });

  it('preserves the popup opener while adding Helmet security headers', async () => {
    expect(helmetOptions.crossOriginOpenerPolicy.policy).toBe('same-origin-allow-popups');

    const server = createServer((request, response) => {
      helmet(helmetOptions)(request, response, () => {
        response.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test HTTP server did not bind to a TCP port.');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}`);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
