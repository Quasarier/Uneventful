import {
  Inject,
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';

export const AUTH_RATE_LIMIT_REDIS = Symbol('AUTH_RATE_LIMIT_REDIS');

const INCREMENT_WITH_EXPIRY = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

export type AuthRateLimitScope =
  | 'api-user'
  | 'api-anonymous-ip'
  | 'google-start-ip'
  | 'google-callback-ip'
  | 'google-account'
  | 'event-image-ip'
  | 'event-image-user'
  | 'rsvp-user'
  | 'checkin-user';

export interface RateLimitMessages {
  exceeded: string;
  unavailable: string;
}

const authenticationRateLimitMessages: RateLimitMessages = {
  exceeded: 'Too many authentication attempts. Try again later.',
  unavailable: 'Authentication is temporarily unavailable.',
};

export class AuthRateLimitExceededException extends HttpException {
  constructor(
    message = authenticationRateLimitMessages.exceeded,
    readonly retryAfterSeconds = 60,
  ) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

@Injectable()
export class AuthRateLimitService implements OnModuleDestroy {
  constructor(
    @Inject(AUTH_RATE_LIMIT_REDIS)
    private readonly redis: Redis,
  ) {}

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  async checkConnection(): Promise<void> {
    await this.redis.ping();
  }

  async consume(
    scope: AuthRateLimitScope,
    identifier: string,
    limit: number,
    windowMs: number,
    messages: RateLimitMessages = authenticationRateLimitMessages,
  ): Promise<void> {
    const digest = createHash('sha256').update(identifier).digest('hex');
    const key = `uneventful:auth-rate:v1:${scope}:${digest}`;
    let count: number;
    try {
      count = Number(await this.redis.eval(INCREMENT_WITH_EXPIRY, 1, key, String(windowMs)));
    } catch {
      throw new ServiceUnavailableException(messages.unavailable);
    }

    if (!Number.isSafeInteger(count) || count < 1) {
      throw new ServiceUnavailableException(messages.unavailable);
    }
    if (count > limit) {
      throw new AuthRateLimitExceededException(
        messages.exceeded,
        Math.max(1, Math.ceil(windowMs / 1_000)),
      );
    }
  }
}
