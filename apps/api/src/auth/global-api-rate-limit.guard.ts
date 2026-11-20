import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Environment } from '../config/environment';
import { SKIP_GLOBAL_RATE_LIMIT_KEY } from './auth.decorators';
import { AuthRateLimitService, type RateLimitMessages } from './auth-rate-limit.service';
import type { AuthenticatedRequest } from './auth.types';

export const AUTHENTICATED_API_RATE_LIMIT = 300;
export const GLOBAL_API_RATE_WINDOW_MS = 60_000;

const globalApiRateLimitMessages: RateLimitMessages = {
  exceeded: 'Too many requests. Try again later.',
  unavailable: 'The API is temporarily unavailable.',
};

@Injectable()
export class GlobalApiRateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimit: AuthRateLimitService,
    private readonly reflector: Reflector,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(SKIP_GLOBAL_RATE_LIMIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest & Request>();
    if (request.user) {
      await this.rateLimit.consume(
        'api-user',
        request.user.id,
        AUTHENTICATED_API_RATE_LIMIT,
        GLOBAL_API_RATE_WINDOW_MS,
        globalApiRateLimitMessages,
      );
      return true;
    }

    const clientIp = request.ip || request.socket.remoteAddress || 'unknown';
    await this.rateLimit.consume(
      'api-anonymous-ip',
      clientIp,
      this.config.get('ANONYMOUS_RATE_LIMIT_PER_MINUTE', { infer: true }),
      GLOBAL_API_RATE_WINDOW_MS,
      globalApiRateLimitMessages,
    );
    return true;
  }
}
