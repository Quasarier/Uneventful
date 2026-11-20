import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { Environment } from '../config/environment';
import { AuthRateLimitService, AUTH_RATE_LIMIT_REDIS } from './auth-rate-limit.service';

@Module({
  providers: [
    {
      provide: AUTH_RATE_LIMIT_REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) =>
        new Redis(config.get('REDIS_URL', { infer: true }), {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          retryStrategy: (attempt) => (attempt >= 3 ? null : Math.min(attempt * 250, 1000)),
        }),
    },
    AuthRateLimitService,
  ],
  exports: [AuthRateLimitService],
})
export class AuthRateLimitModule {}
