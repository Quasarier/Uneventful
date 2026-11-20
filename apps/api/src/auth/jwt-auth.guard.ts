import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Environment } from '../config/environment';
import { AuthService } from './auth.service';
import { AuthRateLimitService, type RateLimitMessages } from './auth-rate-limit.service';
import { IS_PUBLIC_KEY } from './auth.decorators';
import type { AuthenticatedRequest } from './auth.types';

const anonymousRateLimitMessages: RateLimitMessages = {
  exceeded: 'Too many requests. Try again later.',
  unavailable: 'The API is temporarily unavailable.',
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    private readonly rateLimit: AuthRateLimitService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);

    if (!match?.[1]) {
      await this.consumeAnonymousRequest(request);
      throw new UnauthorizedException('Bearer access token required.');
    }

    try {
      request.user = await this.authService.authenticateAccessToken(match[1]);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        await this.consumeAnonymousRequest(request);
      }
      throw error;
    }
    return true;
  }

  private consumeAnonymousRequest(request: AuthenticatedRequest): Promise<void> {
    const clientIp = request.ip || request.socket.remoteAddress || 'unknown';
    return this.rateLimit.consume(
      'api-anonymous-ip',
      clientIp,
      this.config.get('ANONYMOUS_RATE_LIMIT_PER_MINUTE', { infer: true }),
      60_000,
      anonymousRateLimitMessages,
    );
  }
}
