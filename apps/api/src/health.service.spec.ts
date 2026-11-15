import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { HealthService } from './health.service';

describe('HealthService', () => {
  it('reports readiness only when PostgreSQL and Redis respond', async () => {
    const service = new HealthService(
      { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) } as never,
      { checkConnection: vi.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(service.getReadiness()).resolves.toEqual({ status: 'ok' });
  });

  it('fails readiness when either dependency is unavailable', async () => {
    const service = new HealthService(
      { $queryRaw: vi.fn().mockRejectedValue(new Error('database unavailable')) } as never,
      { checkConnection: vi.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(service.getReadiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('fails readiness when Redis is unavailable', async () => {
    const service = new HealthService(
      { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) } as never,
      { checkConnection: vi.fn().mockRejectedValue(new Error('redis unavailable')) } as never,
    );

    await expect(service.getReadiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
