import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Param,
  NotFoundException,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UserRole } from '../../generated/prisma/client';
import { OptionalAuth, Roles } from '../auth/auth.decorators';
import { AuthRateLimitService, type RateLimitMessages } from '../auth/auth-rate-limit.service';
import type { AuthenticatedRequest, AuthPrincipal } from '../auth/auth.types';
import type { Environment } from '../config/environment';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { RecommendationPreferenceDto } from './dto/recommendation-preference.dto';
import { AnalyticsService } from './analytics.service';

const analyticsLimitMessages: RateLimitMessages = {
  exceeded: 'Too many analytics requests. Try again later.',
  unavailable: 'Analytics are temporarily unavailable.',
};

const exportLimitMessages: RateLimitMessages = {
  exceeded: 'Too many attendee exports. Try again later.',
  unavailable: 'Attendee exports are temporarily unavailable.',
};

function requirePrincipal(request: AuthenticatedRequest): AuthPrincipal {
  if (!request.user) throw new UnauthorizedException();
  return request.user;
}

function requireMaskedPrincipal(request: AuthenticatedRequest, message: string): AuthPrincipal {
  if (!request.user) {
    throw new NotFoundException(message);
  }
  return request.user;
}

@Controller()
export class AnalyticsController {
  constructor(
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(AuthRateLimitService) private readonly rateLimit: AuthRateLimitService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  @Get('events/:id/analytics')
  @OptionalAuth()
  @Header('Cache-Control', 'private, no-store')
  async eventAnalytics(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) eventId: string,
    @Query() query: AnalyticsQueryDto,
  ) {
    const principal = requireMaskedPrincipal(request, 'Event not found.');
    await this.consumeAnalyticsLimit(principal);
    return this.analytics.getEventAnalytics(principal, eventId, query);
  }

  @Get('clubs/:id/analytics')
  @OptionalAuth()
  @Header('Cache-Control', 'private, no-store')
  async clubAnalytics(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) clubId: string,
    @Query() query: AnalyticsQueryDto,
  ) {
    const principal = requireMaskedPrincipal(request, 'Club not found.');
    await this.consumeAnalyticsLimit(principal);
    return this.analytics.getClubAnalytics(principal, clubId, query);
  }

  @Get('events/:id/attendees/export')
  @OptionalAuth()
  async exportAttendees(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) eventId: string,
    @Res() response: Response,
  ): Promise<void> {
    const principal = requireMaskedPrincipal(request, 'Event not found.');
    await this.rateLimit.consume(
      'analytics-export-user',
      principal.id,
      this.config.get('ANALYTICS_EXPORTS_PER_HOUR', { infer: true }),
      60 * 60_000,
      exportLimitMessages,
    );
    const result = await this.analytics.exportAttendees(principal, eventId);
    response.status(200).set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    await pipeline(Readable.from(result.chunks), response);
  }

  @Get('recommendations')
  @Roles(UserRole.STUDENT)
  @Header('Cache-Control', 'private, no-store')
  async recommendations(@Req() request: AuthenticatedRequest) {
    const principal = requirePrincipal(request);
    await this.consumeRecommendationLimit(principal);
    return this.analytics.getRecommendations(principal);
  }

  @Get('me/recommendation-preference')
  @Roles(UserRole.STUDENT)
  @Header('Cache-Control', 'private, no-store')
  async getRecommendationPreference(@Req() request: AuthenticatedRequest) {
    const principal = requirePrincipal(request);
    await this.consumeRecommendationLimit(principal);
    return this.analytics.getRecommendationPreference(principal.id);
  }

  @Patch('me/recommendation-preference')
  @Roles(UserRole.STUDENT)
  @Header('Cache-Control', 'private, no-store')
  async updateRecommendationPreference(
    @Req() request: AuthenticatedRequest,
    @Body() dto: RecommendationPreferenceDto,
  ) {
    const principal = requirePrincipal(request);
    await this.consumeRecommendationLimit(principal);
    return this.analytics.updateRecommendationPreference(principal, dto);
  }

  @Delete('me/recommendation-data')
  @Roles(UserRole.STUDENT)
  @Header('Cache-Control', 'private, no-store')
  async deleteRecommendationData(@Req() request: AuthenticatedRequest) {
    const principal = requirePrincipal(request);
    await this.consumeRecommendationLimit(principal);
    return this.analytics.deleteRecommendationData(principal);
  }

  @Post('clubs/:id/follow')
  @Roles(UserRole.STUDENT)
  @Header('Cache-Control', 'private, no-store')
  async followClub(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) clubId: string,
  ) {
    const principal = requirePrincipal(request);
    await this.consumeRecommendationLimit(principal);
    return this.analytics.followClub(principal, clubId);
  }

  @Delete('clubs/:id/follow')
  @Roles(UserRole.STUDENT)
  @Header('Cache-Control', 'private, no-store')
  async unfollowClub(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) clubId: string,
  ) {
    const principal = requirePrincipal(request);
    await this.consumeRecommendationLimit(principal);
    return this.analytics.unfollowClub(principal, clubId);
  }

  private consumeAnalyticsLimit(principal: AuthPrincipal): Promise<void> {
    return this.rateLimit.consume(
      'analytics-user',
      principal.id,
      this.config.get('ANALYTICS_RATE_LIMIT_PER_MINUTE', { infer: true }),
      60_000,
      analyticsLimitMessages,
    );
  }

  private consumeRecommendationLimit(principal: AuthPrincipal): Promise<void> {
    return this.rateLimit.consume(
      'recommendation-user',
      principal.id,
      this.config.get('ANALYTICS_RATE_LIMIT_PER_MINUTE', { infer: true }),
      60_000,
      analyticsLimitMessages,
    );
  }
}
