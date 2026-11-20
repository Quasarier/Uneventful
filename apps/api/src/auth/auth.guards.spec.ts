import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { Environment } from '../config/environment';
import type { AuthService } from './auth.service';
import type { AuthRateLimitService } from './auth-rate-limit.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

function context(request: object): ExecutionContext {
  const handler = () => undefined;
  return {
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('authorization guards', () => {
  const config = {
    get: vi.fn().mockReturnValue(1200),
  } as unknown as ConfigService<Environment, true>;

  it('allows only explicitly public routes to skip authentication', async () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(true),
    } as unknown as Reflector;
    const authService = {
      authenticateAccessToken: vi.fn(),
    } as unknown as AuthService;
    const rateLimit = { consume: vi.fn() };
    const guard = new JwtAuthGuard(
      reflector,
      authService,
      rateLimit as unknown as AuthRateLimitService,
      config,
    );

    await expect(guard.canActivate(context({ headers: {} }))).resolves.toBe(true);
    expect(authService.authenticateAccessToken).not.toHaveBeenCalled();
    expect(rateLimit.consume).not.toHaveBeenCalled();
  });

  it('rate limits unauthenticated requests by IP before rejecting them', async () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const authService = {
      authenticateAccessToken: vi.fn(),
    } as unknown as AuthService;
    const rateLimit = { consume: vi.fn().mockResolvedValue(undefined) };
    const guard = new JwtAuthGuard(
      reflector,
      authService,
      rateLimit as unknown as AuthRateLimitService,
      config,
    );

    await expect(
      guard.canActivate({
        ...context({
          headers: { authorization: 'Basic token' },
          ip: '192.0.2.44',
          socket: { remoteAddress: '127.0.0.1' },
        }),
      } as ExecutionContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(rateLimit.consume).toHaveBeenCalledWith(
      'api-anonymous-ip',
      '192.0.2.44',
      1200,
      60_000,
      expect.any(Object),
    );
  });

  it('returns forbidden when the authenticated role is not permitted', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(['ADMIN']),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(() =>
      guard.canActivate(
        context({
          user: {
            id: '00000000-0000-4000-8000-000000000001',
            role: 'STUDENT',
            tokenVersion: 0,
          },
        }),
      ),
    ).toThrow(ForbiddenException);
  });
});
