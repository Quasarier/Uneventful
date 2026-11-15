import { ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AuthRateLimitExceededException, AuthRateLimitService } from './auth-rate-limit.service';

describe('AuthRateLimitService', () => {
  it('uses an atomic Redis counter with an expiry and hashed identifiers', async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue(1),
    } as unknown as Redis;
    const service = new AuthRateLimitService(redis);
    const account = 'student@example.edu';

    await service.consume('google-account', account, 10, 900_000);

    const expectedDigest = createHash('sha256').update(account).digest('hex');
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('INCR'),
      1,
      `uneventful:auth-rate:v1:google-account:${expectedDigest}`,
      '900000',
    );
  });

  it('rejects attempts over the configured limit', async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue(11),
    } as unknown as Redis;

    await expect(
      new AuthRateLimitService(redis).consume('google-account', 'student@example.edu', 10, 900_000),
    ).rejects.toBeInstanceOf(AuthRateLimitExceededException);
  });

  it('enforces image-download limits with the image-specific response', async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue(121),
    } as unknown as Redis;

    await expect(
      new AuthRateLimitService(redis).consume('event-image-ip', '192.0.2.12', 120, 60_000, {
        exceeded: 'Too many image requests. Try again later.',
        unavailable: 'Image delivery is temporarily unavailable.',
      }),
    ).rejects.toThrow('Too many image requests. Try again later.');
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('INCR'),
      1,
      expect.stringMatching(/^uneventful:auth-rate:v1:event-image-ip:[0-9a-f]{64}$/),
      '60000',
    );
  });

  it('fails closed when Redis is unavailable', async () => {
    const redis = {
      eval: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    } as unknown as Redis;

    await expect(
      new AuthRateLimitService(redis).consume('google-start-ip', '192.0.2.1', 15, 900_000),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
