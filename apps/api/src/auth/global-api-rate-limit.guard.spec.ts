import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { validateEnvironment, type Environment } from '../config/environment';
import {
  AUTHENTICATED_API_RATE_LIMIT,
  GLOBAL_API_RATE_WINDOW_MS,
  GlobalApiRateLimitGuard,
} from './global-api-rate-limit.guard';
import type { AuthRateLimitService } from './auth-rate-limit.service';
import { SKIP_GLOBAL_RATE_LIMIT_KEY } from './auth.decorators';

function makeConfig(): ConfigService<Environment, true> {
  return new ConfigService<Environment, true>(
    validateEnvironment({
      NODE_ENV: 'test',
      PORT: 3001,
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      ANONYMOUS_RATE_LIMIT_PER_MINUTE: 1200,
      GOOGLE_CLIENT_ID: 'rate-limit-client',
      GOOGLE_CLIENT_SECRET: 'rate-limit-secret',
      GOOGLE_CALLBACK_URL: 'http://localhost:3001/api/v1/auth/google/callback',
      UNIVERSITY_EMAIL_DOMAIN: 'example.edu',
      CAMPUS_TIME_ZONE: 'America/New_York',
      WEB_ORIGIN: 'http://localhost:3000',
      SESSION_SECRET: 'test-session-secret-with-at-least-thirty-two-characters',
      JWT_PRIVATE_KEY_B64: Buffer.from('unused-private-key').toString('base64'),
      JWT_PUBLIC_KEY_B64: Buffer.from('unused-public-key').toString('base64'),
      JWT_KEY_ID: 'rate-limit-test',
      TICKET_SIGNING_PRIVATE_KEY_B64: Buffer.from('unused-ticket-private-key').toString('base64'),
      TICKET_SIGNING_PUBLIC_KEY_B64: Buffer.from('unused-ticket-public-key').toString('base64'),
      TICKET_SIGNING_KEY_ID: 'rate-limit-ticket-test',
      JWT_ISSUER: 'https://api.uneventful.test',
      JWT_AUDIENCE: 'uneventful-api',
      REFRESH_TOKEN_TTL_DAYS: 30,
      OBJECT_STORAGE_BUCKET: 'rate-limit-test',
      OBJECT_STORAGE_REGION: 'us-east-1',
    }),
  );
}

function contextFor(request: object, handler = () => undefined): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('GlobalApiRateLimitGuard', () => {
  it('uses the higher configured IP limit for anonymous requests', async () => {
    const rateLimit = { consume: vi.fn().mockResolvedValue(undefined) };
    const guard = new GlobalApiRateLimitGuard(
      rateLimit as unknown as AuthRateLimitService,
      new Reflector(),
      makeConfig(),
    );

    await expect(
      guard.canActivate(contextFor({ ip: '192.0.2.20', socket: { remoteAddress: '127.0.0.1' } })),
    ).resolves.toBe(true);
    expect(rateLimit.consume).toHaveBeenCalledWith(
      'api-anonymous-ip',
      '192.0.2.20',
      1200,
      GLOBAL_API_RATE_WINDOW_MS,
      expect.any(Object),
    );
  });

  it('keeps authenticated users behind the same IP in separate buckets', async () => {
    const rateLimit = { consume: vi.fn().mockResolvedValue(undefined) };
    const guard = new GlobalApiRateLimitGuard(
      rateLimit as unknown as AuthRateLimitService,
      new Reflector(),
      makeConfig(),
    );
    const sharedIp = '198.51.100.8';

    await guard.canActivate(
      contextFor({
        ip: sharedIp,
        socket: { remoteAddress: sharedIp },
        user: { id: 'user-one', role: 'STUDENT', tokenVersion: 0 },
      }),
    );
    await guard.canActivate(
      contextFor({
        ip: sharedIp,
        socket: { remoteAddress: sharedIp },
        user: { id: 'user-two', role: 'STUDENT', tokenVersion: 0 },
      }),
    );

    expect(rateLimit.consume).toHaveBeenNthCalledWith(
      1,
      'api-user',
      'user-one',
      AUTHENTICATED_API_RATE_LIMIT,
      GLOBAL_API_RATE_WINDOW_MS,
      expect.any(Object),
    );
    expect(rateLimit.consume).toHaveBeenNthCalledWith(
      2,
      'api-user',
      'user-two',
      AUTHENTICATED_API_RATE_LIMIT,
      GLOBAL_API_RATE_WINDOW_MS,
      expect.any(Object),
    );
  });

  it('fails closed when the global anonymous limit cannot be enforced', async () => {
    const unavailable = new Error('rate limit unavailable');
    const rateLimit = { consume: vi.fn().mockRejectedValue(unavailable) };
    const guard = new GlobalApiRateLimitGuard(
      rateLimit as unknown as AuthRateLimitService,
      new Reflector(),
      makeConfig(),
    );
    const context = contextFor({
      ip: undefined,
      socket: { remoteAddress: '127.0.0.1' },
    });

    await expect(guard.canActivate(context)).rejects.toBe(unavailable);
    expect(rateLimit.consume).toHaveBeenCalledWith(
      'api-anonymous-ip',
      '127.0.0.1',
      1200,
      GLOBAL_API_RATE_WINDOW_MS,
      expect.any(Object),
    );
  });

  it('does not contact Redis for routes explicitly exempted from global limiting', async () => {
    const rateLimit = { consume: vi.fn() };
    const liveHandler = () => undefined;
    Reflect.defineMetadata(SKIP_GLOBAL_RATE_LIMIT_KEY, true, liveHandler);
    const guard = new GlobalApiRateLimitGuard(
      rateLimit as unknown as AuthRateLimitService,
      new Reflector(),
      makeConfig(),
    );

    await expect(
      guard.canActivate(
        contextFor({ ip: '192.0.2.20', socket: { remoteAddress: '127.0.0.1' } }, liveHandler),
      ),
    ).resolves.toBe(true);
    expect(rateLimit.consume).not.toHaveBeenCalled();
  });
});
