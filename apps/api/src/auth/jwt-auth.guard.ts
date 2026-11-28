import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Environment } from '../config/environment';
import { AuthService } from './auth.service';
import { AuthRateLimitService, type RateLimitMessages } from './auth-rate-limit.service';
import { ADMIN_ONLY_KEY, IS_OPTIONAL_AUTH_KEY, IS_PUBLIC_KEY } from './auth.decorators';
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
    const isAdminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isAdminOnly) {
      request.adminOnly = true;
      context
        .switchToHttp()
        .getResponse<Response>()
        .setHeader('Cache-Control', 'private, no-store');
    }
    const isOptionalAuth = this.reflector.getAllAndOverride<boolean>(IS_OPTIONAL_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isOptionalAuth && !authorization) {
      await this.consumeAnonymousRequest(request);
      return true;
    }
    const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);

    if (!match?.[1]) {
      if (isAdminOnly) {
        throw new NotFoundException('Resource not found.');
      }
      await this.consumeAnonymousRequest(request);
      throw new UnauthorizedException('Bearer access token required.');
    }

    try {
      if (isAdminOnly) {
        const session = await this.authService.authenticateAccessTokenSession(match[1]);
        request.user = session.principal;
        request.accessSession = session;
      } else {
        request.user = await this.authService.authenticateAccessToken(match[1]);
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        if (isAdminOnly) {
          throw new NotFoundException('Resource not found.');
        }
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
