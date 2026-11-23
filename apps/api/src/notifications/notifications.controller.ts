import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../auth/auth.decorators';
import { AuthRateLimitService, type RateLimitMessages } from '../auth/auth-rate-limit.service';
import type { AuthenticatedRequest, AuthPrincipal } from '../auth/auth.types';
import type { Environment } from '../config/environment';
import { DeletePushSubscriptionDto, PushSubscriptionDto } from './dto/push-subscription.dto';
import { PatchNotificationPreferencesDto } from './dto/notification-preferences.dto';
import { UnsubscribeTokenDto } from './dto/unsubscribe-token.dto';
import { NotificationsService } from './notifications.service';
import { UnsubscribeService } from './unsubscribe.service';

const notificationRateLimitMessages: RateLimitMessages = {
  exceeded: 'Too many notification requests. Try again later.',
  unavailable: 'Notification settings are temporarily unavailable.',
};

const unsubscribeRateLimitMessages: RateLimitMessages = {
  exceeded: 'Too many unsubscribe requests. Try again later.',
  unavailable: 'Unsubscribe is temporarily unavailable.',
};

function requirePrincipal(request: AuthenticatedRequest): AuthPrincipal {
  if (!request.user) {
    throw new UnauthorizedException();
  }
  return request.user;
}

@Controller()
export class NotificationsController {
  constructor(
    @Inject(NotificationsService)
    private readonly notifications: NotificationsService,
    private readonly unsubscribeService: UnsubscribeService,
    private readonly rateLimit: AuthRateLimitService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  @Get('me/notification-preferences')
  @Header('Cache-Control', 'private, no-store')
  async getPreferences(@Req() request: AuthenticatedRequest) {
    const principal = requirePrincipal(request);
    await this.consumeUserRateLimit(principal);
    return this.notifications.getPreferences(principal.id);
  }

  @Patch('me/notification-preferences')
  @Header('Cache-Control', 'private, no-store')
  async patchPreferences(
    @Req() request: AuthenticatedRequest,
    @Body() dto: PatchNotificationPreferencesDto,
  ) {
    const principal = requirePrincipal(request);
    await this.consumeUserRateLimit(principal);
    return this.notifications.updatePreferences(principal, dto.preferences);
  }

  @Post('me/push-subscriptions')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'private, no-store')
  async addPushSubscription(
    @Req() request: AuthenticatedRequest,
    @Body() dto: PushSubscriptionDto,
  ): Promise<void> {
    const principal = requirePrincipal(request);
    await this.consumeUserRateLimit(principal);
    await this.notifications.addPushSubscription(principal, dto);
  }

  @Delete('me/push-subscriptions')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'private, no-store')
  async removePushSubscription(
    @Req() request: AuthenticatedRequest,
    @Body() dto: DeletePushSubscriptionDto,
  ): Promise<void> {
    const principal = requirePrincipal(request);
    await this.consumeUserRateLimit(principal);
    await this.notifications.removePushSubscription(principal, dto.endpoint);
  }

  @Public()
  @Post('unsubscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async unsubscribe(
    @Req() request: AuthenticatedRequest,
    @Query() dto: UnsubscribeTokenDto,
  ): Promise<void> {
    const clientIp = request.ip || request.socket.remoteAddress || 'unknown';
    await this.rateLimit.consume(
      'notification-unsubscribe-ip',
      clientIp,
      this.config.get('NOTIFICATION_UNSUBSCRIBE_RATE_LIMIT_PER_MINUTE', { infer: true }),
      60_000,
      unsubscribeRateLimitMessages,
    );
    await this.unsubscribeService.unsubscribe(dto.token);
  }

  private consumeUserRateLimit(principal: AuthPrincipal): Promise<void> {
    return this.rateLimit.consume(
      'notification-user',
      principal.id,
      this.config.get('NOTIFICATION_RATE_LIMIT_PER_MINUTE', { infer: true }),
      60_000,
      notificationRateLimitMessages,
    );
  }
}
