import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from '../database/prisma.service';
import { AUTH_RATE_LIMIT_REDIS } from '../auth/auth-rate-limit.service';

const CACHE_TTL_SECONDS = 20;

export type CacheDecoder<T> = (value: unknown) => T | null;

@Injectable()
export class AnalyticsCacheService {
  constructor(
    @Inject(AUTH_RATE_LIMIT_REDIS) private readonly redis: Redis,
    private readonly prisma: PrismaService,
  ) {}

  async getOrCompute<T>(
    key: string,
    indexes: readonly string[],
    decode: CacheDecoder<T>,
    compute: () => Promise<T>,
  ): Promise<T> {
    try {
      const cached = await this.redis.get(key);
      if (cached) {
        const parsed: unknown = JSON.parse(cached);
        const decoded = decode(parsed);
        if (decoded !== null) return decoded;
      }

      const value = await compute();
      const pipeline = this.redis.pipeline();
      pipeline.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
      for (const index of indexes) {
        pipeline.sadd(index, key);
        pipeline.expire(index, CACHE_TTL_SECONDS * 2);
      }
      const result = await pipeline.exec();
      if (result?.some(([error]) => error !== null)) {
        throw new Error('Redis cache write failed.');
      }
      return value;
    } catch {
      throw new ServiceUnavailableException('Analytics are temporarily unavailable.');
    }
  }

  async invalidateEvent(eventId: string, userId?: string): Promise<void> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { clubId: true },
    });
    const keys = [`analytics:event:index:${eventId}`];
    if (event) keys.push(`analytics:club:index:${event.clubId}`);
    if (userId) keys.push(`recommendations:user:index:${userId}`);
    await this.deleteIndexed(keys);
  }

  async invalidateClub(clubId: string, userId?: string): Promise<void> {
    const keys = [`analytics:club:index:${clubId}`];
    if (userId) keys.push(`recommendations:user:index:${userId}`);
    await this.deleteIndexed(keys);
  }

  async invalidateRecommendations(userId: string): Promise<void> {
    await this.deleteIndexed([`recommendations:user:index:${userId}`]);
  }

  private async deleteIndexed(indexes: readonly string[]): Promise<void> {
    try {
      const pipeline = this.redis.pipeline();
      for (const index of indexes) {
        const keys = await this.redis.smembers(index);
        if (keys.length > 0) pipeline.del(...keys);
        pipeline.del(index);
      }
      const result = await pipeline.exec();
      if (result?.some(([error]) => error !== null)) {
        throw new Error('Redis cache invalidation failed.');
      }
    } catch {
      throw new ServiceUnavailableException('Analytics are temporarily unavailable.');
    }
  }
}
