import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AuthRateLimitService } from './auth/auth-rate-limit.service';
import { PrismaService } from './database/prisma.service';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: AuthRateLimitService,
  ) {}

  async getReadiness(): Promise<{ status: 'ok' }> {
    const checks = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      this.rateLimit.checkConnection(),
    ]);

    if (checks.some((check) => check.status === 'rejected')) {
      throw new ServiceUnavailableException('Service is not ready.');
    }

    return { status: 'ok' };
  }
}
