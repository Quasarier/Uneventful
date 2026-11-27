import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/environment';
import { isAdminIpAllowed } from '../config/ip-network';
import { AuthRateLimitService, type RateLimitMessages } from '../auth/auth-rate-limit.service';
import { AuthService } from '../auth/auth.service';
import type { AuthenticatedRequest } from '../auth/auth.types';

const adminRateLimitMessages: RateLimitMessages = {
  exceeded: 'Too many administrator requests. Try again later.',
  unavailable: 'Administrator services are temporarily unavailable.',
};

@Injectable()
export class AdminAccessGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<Environment, true>,
    private readonly rateLimit: AuthRateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = request.accessSession;
    if (
      !session ||
      request.user?.id !== session.principal.id ||
      session.principal.role !== 'ADMIN' ||
      !(await this.auth.isAccessSessionActive(session))
    ) {
      throw new NotFoundException('Resource not found.');
    }

    const allowlist = this.config.get('ADMIN_IP_ALLOWLIST', { infer: true });
    const clientIp = request.ip || request.socket.remoteAddress || '';
    if (!isAdminIpAllowed(allowlist, clientIp)) {
      throw new NotFoundException('Resource not found.');
    }

    await this.rateLimit.consume(
      'admin-user',
      session.principal.id,
      this.config.get('ADMIN_RATE_LIMIT_PER_MINUTE', { infer: true }),
      60_000,
      adminRateLimitMessages,
    );
    return true;
  }
}
