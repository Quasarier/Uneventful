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
export const SESSION_REVOCATION_CHANNEL = 'uneventful:session-revocation:v1';

const INCREMENT_WITH_EXPIRY = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

const RESERVE_SOCKET_CONNECTION = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
if not redis.call('ZSCORE', KEYS[1], ARGV[4]) and redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
return 1
`;

const REFRESH_SOCKET_CONNECTION = `
if not redis.call('ZSCORE', KEYS[1], ARGV[2]) then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
return 1
`;

const RELEASE_SOCKET_CONNECTION = `
redis.call('ZREM', KEYS[1], ARGV[1])
return 1
`;

export type SessionRevocation =
  { familyId: string; userId?: never } | { userId: string; familyId?: never };

export type AuthRateLimitScope =
  | 'api-user'
  | 'api-anonymous-ip'
  | 'google-start-ip'
  | 'google-callback-ip'
  | 'google-account'
  | 'event-image-ip'
  | 'event-image-user'
  | 'rsvp-user'
  | 'checkin-user'
  | 'venue-conflict-user'
  | 'venue-write-user'
  | 'venue-booking-write-user';

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

  async publishSessionRevocation(revocation: SessionRevocation): Promise<void> {
    try {
      await this.redis.publish(SESSION_REVOCATION_CHANNEL, JSON.stringify(revocation));
    } catch {
      throw new ServiceUnavailableException('Session revocation could not be distributed.');
    }
  }

  async reserveSocketConnection(
    userId: string,
    socketId: string,
    limit: number,
    leaseMs: number,
  ): Promise<boolean> {
    const key = this.socketConnectionKey(userId);
    try {
      const reserved = Number(
        await this.redis.eval(
          RESERVE_SOCKET_CONNECTION,
          1,
          key,
          String(Date.now()),
          String(leaseMs),
          String(limit),
          socketId,
        ),
      );
      if (reserved !== 0 && reserved !== 1) {
        throw new Error('Invalid socket connection reservation result.');
      }
      return reserved === 1;
    } catch {
      throw new ServiceUnavailableException('Real-time connections are temporarily unavailable.');
    }
  }

  async refreshSocketConnection(
    userId: string,
    socketId: string,
    leaseMs: number,
  ): Promise<boolean> {
    try {
      return (
        Number(
          await this.redis.eval(
            REFRESH_SOCKET_CONNECTION,
            1,
            this.socketConnectionKey(userId),
            String(Date.now()),
            socketId,
            String(leaseMs),
          ),
        ) === 1
      );
    } catch {
      throw new ServiceUnavailableException('Real-time connections are temporarily unavailable.');
    }
  }

  async releaseSocketConnection(userId: string, socketId: string): Promise<void> {
    try {
      await this.redis.eval(
        RELEASE_SOCKET_CONNECTION,
        1,
        this.socketConnectionKey(userId),
        socketId,
      );
    } catch {
      throw new ServiceUnavailableException('Real-time connections are temporarily unavailable.');
    }
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

  private socketConnectionKey(userId: string): string {
    const digest = createHash('sha256').update(userId).digest('hex');
    return `uneventful:socket-connections:v1:${digest}`;
  }
}
