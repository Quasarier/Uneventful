import { Controller, Get, Module, Req } from '@nestjs/common';
import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Public } from '../src/auth/auth.decorators';
import {
  AuthRateLimitExceededException,
  AuthRateLimitService,
} from '../src/auth/auth-rate-limit.service';
import { AuthService } from '../src/auth/auth.service';
import { GlobalApiRateLimitGuard } from '../src/auth/global-api-rate-limit.guard';
import { AUTHENTICATED_API_RATE_LIMIT } from '../src/auth/global-api-rate-limit.guard';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import type { AuthenticatedRequest, AuthPrincipal } from '../src/auth/auth.types';
import type { Environment } from '../src/config/environment';
import { HttpExceptionFilter } from '../src/http-exception.filter';

const redisUrl = process.env.TEST_REDIS_URL;
const anonymousRateLimit = 301;
const authenticatedUserId = randomUUID();
const authenticatedPrincipal: AuthPrincipal = {
  id: authenticatedUserId,
  role: 'STUDENT',
  tokenVersion: 0,
};

@Controller('global-rate-limit-test')
class GlobalRateLimitTestController {
  @Public()
  @Get('anonymous')
  anonymous(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('authenticated')
  authenticated(@Req() request: AuthenticatedRequest): { userId: string | undefined } {
    return { userId: request.user?.id };
  }
}

@Module({ controllers: [GlobalRateLimitTestController] })
class GlobalRateLimitHttpTestModule {}

if (!redisUrl) {
  throw new Error('TEST_REDIS_URL is required for Redis integration tests.');
}

describe('authentication Redis rate limit integration', () => {
  let redis: Redis;
  let service: AuthRateLimitService;
  let httpApp: INestApplication | undefined;
  let httpBaseUrl: string;

  beforeAll(async () => {
    redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    service = new AuthRateLimitService(redis);
    await redis.connect();
    await redis.ping();

    const reflector = new Reflector();
    const config = {
      get: (key: string) =>
        key === 'ANONYMOUS_RATE_LIMIT_PER_MINUTE' ? anonymousRateLimit : undefined,
    } as ConfigService<Environment, true>;
    const auth = {
      authenticateAccessToken: async () => authenticatedPrincipal,
    } as unknown as AuthService;
    httpApp = await NestFactory.create(GlobalRateLimitHttpTestModule, { logger: false });
    httpApp.setGlobalPrefix('api/v1');
    httpApp.useGlobalFilters(new HttpExceptionFilter());
    httpApp.useGlobalGuards(
      new JwtAuthGuard(reflector, auth, service, config),
      new GlobalApiRateLimitGuard(service, reflector, config),
      new RolesGuard(reflector),
    );
    await httpApp.listen(0, '127.0.0.1');
    const address = httpApp.getHttpServer().address();
    if (!address || typeof address === 'string') {
      throw new Error('Could not determine rate-limit integration server address.');
    }
    httpBaseUrl = `http://127.0.0.1:${address.port}/api/v1/global-rate-limit-test`;
  });

  afterAll(() => {
    void httpApp?.close();
    service?.onModuleDestroy();
  });

  it('shares an atomic per-identifier counter across service calls', async () => {
    const identifier = randomUUID();

    await service.consume('google-account', identifier, 2, 60_000);
    await service.consume('google-account', identifier, 2, 60_000);
    await expect(service.consume('google-account', identifier, 2, 60_000)).rejects.toBeInstanceOf(
      AuthRateLimitExceededException,
    );
  });

  it('keeps authenticated users on the same campus IP in separate Redis buckets', async () => {
    const sharedCampusIp = '198.51.100.44';
    const users = [randomUUID(), randomUUID()];
    const guard = new GlobalApiRateLimitGuard(service, new Reflector(), {
      get: () => 1200,
    } as unknown as ConfigService<Environment, true>);

    for (const id of users) {
      await guard.canActivate({
        getHandler: () => () => undefined,
        getClass: () => class TestController {},
        switchToHttp: () => ({
          getRequest: () => ({
            ip: sharedCampusIp,
            socket: { remoteAddress: sharedCampusIp },
            user: { id, role: 'STUDENT', tokenVersion: 0 },
          }),
        }),
      } as never);
    }

    for (const id of users) {
      const digest = createHash('sha256').update(id).digest('hex');
      await expect(redis.get(`uneventful:auth-rate:v1:api-user:${digest}`)).resolves.toBe('1');
    }
  });

  it('returns 429 with Retry-After when the authenticated user limit is exceeded over HTTP', async () => {
    const digest = createHash('sha256').update(authenticatedUserId).digest('hex');
    await redis.del(`uneventful:auth-rate:v1:api-user:${digest}`);

    for (let attempt = 0; attempt < AUTHENTICATED_API_RATE_LIMIT; attempt += 1) {
      const response = await fetch(`${httpBaseUrl}/authenticated`, {
        headers: { Authorization: 'Bearer global-rate-limit-test-token' },
      });
      expect(response.status).toBe(200);
    }

    const limited = await fetch(`${httpBaseUrl}/authenticated`, {
      headers: { Authorization: 'Bearer global-rate-limit-test-token' },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  });

  it('returns 429 with Retry-After when the anonymous IP limit is exceeded over HTTP', async () => {
    const clientIp = '127.0.0.1';
    const digest = createHash('sha256').update(clientIp).digest('hex');
    await redis.del(`uneventful:auth-rate:v1:api-anonymous-ip:${digest}`);

    for (let attempt = 0; attempt < anonymousRateLimit; attempt += 1) {
      const response = await fetch(`${httpBaseUrl}/anonymous`);
      expect(response.status).toBe(200);
    }

    const limited = await fetch(`${httpBaseUrl}/anonymous`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  });
});
