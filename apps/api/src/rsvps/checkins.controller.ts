import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnalyticsCacheService } from '../analytics/analytics-cache.service';
import { AuthRateLimitService, type RateLimitMessages } from '../auth/auth-rate-limit.service';
import type { AuthenticatedRequest, AuthPrincipal } from '../auth/auth.types';
import type { Environment } from '../config/environment';
import { CheckinsService } from './checkins.service';
import { CheckinManifestQueryDto } from './dto/checkin-manifest-query.dto';
import { CheckinTicketDto } from './dto/checkin-ticket.dto';
import { ManualCheckinLookupDto } from './dto/manual-checkin-lookup.dto';
import { ManualCheckinDto } from './dto/manual-checkin.dto';
import { SyncCheckinsDto } from './dto/sync-checkins.dto';

const checkinRateLimitMessages: RateLimitMessages = {
  exceeded: 'Too many check-in requests. Try again later.',
  unavailable: 'Check-in is temporarily unavailable.',
};

function requirePrincipal(request: AuthenticatedRequest): AuthPrincipal {
  if (!request.user) {
    throw new UnauthorizedException();
  }
  return request.user;
}

@Controller('events')
export class CheckinsController {
  constructor(
    private readonly checkins: CheckinsService,
    @Inject(AuthRateLimitService)
    private readonly rateLimit: AuthRateLimitService,
    private readonly config: ConfigService<Environment, true>,
    private readonly analyticsCache: AnalyticsCacheService,
  ) {}

  @Get(':id/checkin-manifest')
  @Header('Cache-Control', 'private, no-store')
  async getManifest(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) eventId: string,
    @Query() query: CheckinManifestQueryDto,
  ) {
    const actor = requirePrincipal(request);
    await this.consumeRateLimit(actor);
    return this.checkins.getManifest(eventId, actor, query);
  }

  @Post(':id/checkins')
  @Header('Cache-Control', 'private, no-store')
  async checkIn(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) eventId: string,
    @Body() dto: CheckinTicketDto,
  ) {
    const actor = requirePrincipal(request);
    await this.consumeRateLimit(actor);
    const result = await this.checkins.checkIn(eventId, actor, dto);
    if (result.status === 'VALID') await this.analyticsCache.invalidateEvent(eventId);
    return result;
  }

  @Post(':id/checkins/sync')
  @Header('Cache-Control', 'private, no-store')
  async syncCheckins(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) eventId: string,
    @Body() dto: SyncCheckinsDto,
  ) {
    const actor = requirePrincipal(request);
    await this.consumeRateLimit(actor);
    const result = await this.checkins.syncCheckins(eventId, actor, dto);
    if (result.data.some((item) => item.status === 'VALID')) {
      await this.analyticsCache.invalidateEvent(eventId);
    }
    return result;
  }

  @Get(':id/checkins/lookup')
  @Header('Cache-Control', 'private, no-store')
  async lookup(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) eventId: string,
    @Query() query: ManualCheckinLookupDto,
  ) {
    const actor = requirePrincipal(request);
    await this.consumeRateLimit(actor);
    return this.checkins.lookup(eventId, actor, query);
  }

  @Post(':id/checkins/manual')
  @Header('Cache-Control', 'private, no-store')
  async manualCheckIn(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) eventId: string,
    @Body() dto: ManualCheckinDto,
  ) {
    const actor = requirePrincipal(request);
    await this.consumeRateLimit(actor);
    const result = await this.checkins.manualCheckIn(eventId, actor, dto);
    if (result.status === 'VALID') await this.analyticsCache.invalidateEvent(eventId);
    return result;
  }

  private consumeRateLimit(actor: AuthPrincipal): Promise<void> {
    return this.rateLimit.consume(
      'checkin-user',
      actor.id,
      this.config.get('CHECKIN_RATE_LIMIT_PER_MINUTE', { infer: true }),
      60_000,
      checkinRateLimitMessages,
    );
  }
}
