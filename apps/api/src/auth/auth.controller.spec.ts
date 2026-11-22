import { ConfigService } from '@nestjs/config';
import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../config/environment';
import type { AuthenticatedRequest } from './auth.types';
import { AuthController } from './auth.controller';
import {
  AuthRateLimitExceededException,
  type AuthRateLimitService,
} from './auth-rate-limit.service';
import type { AuthService } from './auth.service';
import type { GoogleOidcService } from './google-oidc.service';

const WEB_ORIGIN = 'http://localhost:3000';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: {
    refresh: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    getRefreshCookieMaxAgeMs: ReturnType<typeof vi.fn>;
    completeGoogleLogin: ReturnType<typeof vi.fn>;
  };
  let googleOidc: {
    createLoginStart: ReturnType<typeof vi.fn>;
    verifyCallback: ReturnType<typeof vi.fn>;
  };
  let rateLimit: {
    consume: ReturnType<typeof vi.fn>;
    publishSessionRevocation: ReturnType<typeof vi.fn>;
  };
  let oauthStartLimit: number;
  let oauthCallbackLimit: number;
  let response: Response;
  let responseMethods: {
    cookie: ReturnType<typeof vi.fn>;
    clearCookie: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
    redirect: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    authService = {
      refresh: vi.fn(),
      logout: vi.fn(),
      getRefreshCookieMaxAgeMs: vi.fn().mockReturnValue(2_592_000_000),
      completeGoogleLogin: vi.fn(),
    };
    googleOidc = {
      createLoginStart: vi.fn().mockReturnValue({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=state',
        transactionCookie: 'signed-transaction',
      }),
      verifyCallback: vi.fn().mockResolvedValue({
        googleSubject: 'subject',
        email: 'student@example.edu',
        firstName: 'Test',
        lastName: 'Student',
        avatarUrl: null,
      }),
    };
    rateLimit = {
      consume: vi.fn().mockResolvedValue(undefined),
      publishSessionRevocation: vi.fn().mockResolvedValue(undefined),
    };
    oauthStartLimit = 1200;
    oauthCallbackLimit = 1200;
    responseMethods = {
      cookie: vi.fn(),
      clearCookie: vi.fn(),
      setHeader: vi.fn(),
      redirect: vi.fn(),
    };
    response = responseMethods as unknown as Response;
    const config = {
      get: (key: string) => {
        switch (key) {
          case 'WEB_ORIGIN':
            return WEB_ORIGIN;
          case 'GOOGLE_OAUTH_START_RATE_LIMIT_PER_15_MINUTES':
            return oauthStartLimit;
          case 'GOOGLE_OAUTH_CALLBACK_RATE_LIMIT_PER_15_MINUTES':
            return oauthCallbackLimit;
          default:
            return undefined;
        }
      },
    } as ConfigService<Environment, true>;
    controller = new AuthController(
      authService as unknown as AuthService,
      googleOidc as unknown as GoogleOidcService,
      config,
      rateLimit as unknown as AuthRateLimitService,
    );
  });

  it('requires exact Origin and the custom CSRF header for cookie endpoints', async () => {
    await expect(
      controller.refresh(makeRequest({ origin: WEB_ORIGIN }), response),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.refresh(
        makeRequest({ origin: 'https://attacker.invalid', 'x-uneventful-csrf': '1' }),
        response,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.logout(makeRequest({ origin: WEB_ORIGIN }), response),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(authService.refresh).not.toHaveBeenCalled();
    expect(authService.logout).not.toHaveBeenCalled();
  });

  it('sets strict refresh-cookie flags after a CSRF-validated refresh', async () => {
    authService.refresh.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'rotated-refresh-token',
      expiresIn: 900,
    });

    await controller.refresh(
      makeRequest({ origin: WEB_ORIGIN, 'x-uneventful-csrf': '1' }),
      response,
    );

    expect(responseMethods.cookie).toHaveBeenCalledWith(
      '__Secure-uneventful_refresh',
      'rotated-refresh-token',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/api/v1/auth',
      }),
    );
  });

  it('clears a tampered refresh cookie after rejecting it', async () => {
    const tamperedCookie = 'A'.repeat(43);
    authService.refresh.mockRejectedValue(new UnauthorizedException());

    await expect(
      controller.refresh(
        makeRequest({
          origin: WEB_ORIGIN,
          'x-uneventful-csrf': '1',
          cookie: `__Secure-uneventful_refresh=${tamperedCookie}`,
        }),
        response,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(authService.refresh).toHaveBeenCalledWith(tamperedCookie);
    expect(responseMethods.clearCookie).toHaveBeenCalledWith(
      '__Secure-uneventful_refresh',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/api/v1/auth',
      }),
    );
  });

  it('keeps the OAuth redirect on the configured popup and hides account conflicts', async () => {
    authService.completeGoogleLogin.mockRejectedValue(
      new ConflictException('This Google account cannot be linked.'),
    );

    await controller.finishGoogleLogin({ code: 'code', state: 'state' }, makeRequest({}), response);

    expect(responseMethods.redirect).toHaveBeenCalledWith(
      303,
      `${WEB_ORIGIN}/auth/popup?status=error`,
    );
  });

  it('returns the same callback result for an invalid identity and an account conflict', async () => {
    const conflictResponse = makeResponse();
    authService.completeGoogleLogin.mockRejectedValue(new ConflictException());
    await controller.finishGoogleLogin(
      { code: 'code', state: 'state' },
      makeRequest({}),
      conflictResponse.response,
    );

    const invalidIdentityResponse = makeResponse();
    googleOidc.verifyCallback.mockRejectedValue(new UnauthorizedException());
    await controller.finishGoogleLogin(
      { code: 'code', state: 'state' },
      makeRequest({}),
      invalidIdentityResponse.response,
    );

    expect(conflictResponse.methods.redirect).toHaveBeenCalledWith(
      303,
      `${WEB_ORIGIN}/auth/popup?status=error`,
    );
    expect(invalidIdentityResponse.methods.redirect).toHaveBeenCalledWith(
      303,
      `${WEB_ORIGIN}/auth/popup?status=error`,
    );
  });

  it('applies the per-IP rate limit before starting an OAuth transaction', async () => {
    await controller.startGoogleLogin(makeRequest({}), response);

    expect(rateLimit.consume).toHaveBeenCalledWith('google-start-ip', '192.0.2.10', 1200, 900_000);
    expect(responseMethods.cookie).toHaveBeenCalledWith(
      '__Secure-uneventful_oauth',
      'signed-transaction',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/api/v1/auth/google/callback',
      }),
    );
  });

  it('rate-limits verified account callbacks before creating sessions', async () => {
    rateLimit.consume.mockImplementation(async (scope: string) => {
      if (scope === 'google-account') {
        throw new AuthRateLimitExceededException();
      }
    });

    await expect(
      controller.finishGoogleLogin({ code: 'code', state: 'state' }, makeRequest({}), response),
    ).rejects.toBeInstanceOf(AuthRateLimitExceededException);

    expect(rateLimit.consume).toHaveBeenNthCalledWith(
      1,
      'google-callback-ip',
      '192.0.2.10',
      1200,
      900_000,
    );
    expect(rateLimit.consume).toHaveBeenNthCalledWith(
      2,
      'google-account',
      'student@example.edu',
      10,
      900_000,
    );
    expect(authService.completeGoogleLogin).not.toHaveBeenCalled();
  });

  it('uses the configured OAuth start and callback IP limits', async () => {
    oauthStartLimit = 4321;
    oauthCallbackLimit = 5432;
    authService.completeGoogleLogin.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 900,
    });

    await controller.startGoogleLogin(makeRequest({}), response);
    await controller.finishGoogleLogin({ code: 'code', state: 'state' }, makeRequest({}), response);

    expect(rateLimit.consume).toHaveBeenNthCalledWith(
      1,
      'google-start-ip',
      '192.0.2.10',
      4321,
      900_000,
    );
    expect(rateLimit.consume).toHaveBeenNthCalledWith(
      2,
      'google-callback-ip',
      '192.0.2.10',
      5432,
      900_000,
    );
  });
});

function makeRequest(headers: Record<string, string>): AuthenticatedRequest {
  return {
    ip: '192.0.2.10',
    socket: { remoteAddress: '192.0.2.10' },
    headers,
  } as unknown as AuthenticatedRequest;
}

function makeResponse(): {
  response: Response;
  methods: {
    cookie: ReturnType<typeof vi.fn>;
    clearCookie: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
    redirect: ReturnType<typeof vi.fn>;
  };
} {
  const methods = {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
    setHeader: vi.fn(),
    redirect: vi.fn(),
  };
  return { response: methods as unknown as Response, methods };
}
