import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app.controller';
import { AppService } from '../src/app.service';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { PrismaService } from '../src/database/prisma.service';
import { HealthService } from '../src/health.service';
import { HttpExceptionFilter } from '../src/http-exception.filter';

let healthService: HealthService;

Reflect.defineMetadata('design:paramtypes', [AppService, HealthService], AppController);

@Module({
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: HealthService,
      useFactory: () => healthService,
    },
  ],
})
class HealthHttpIntegrationModule {}

describe('health HTTP integration', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns a generic readiness failure without dependency details or hostnames', async () => {
    healthService = new HealthService(
      {
        $queryRaw: vi
          .fn()
          .mockRejectedValue(new Error('database connection failed at db.internal.example')),
      } as unknown as PrismaService,
      {
        checkConnection: vi
          .fn()
          .mockRejectedValue(new Error('Redis connection failed at redis.internal.example')),
      } as unknown as AuthRateLimitService,
    );

    app = await NestFactory.create(HealthHttpIntegrationModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') {
      throw new Error('Could not determine health integration server address.');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/health/ready`);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain('"message":"Internal server error"');
    expect(body).not.toContain('database connection failed');
    expect(body).not.toContain('Redis connection failed');
    expect(body).not.toContain('db.internal.example');
    expect(body).not.toContain('redis.internal.example');
  });
});
