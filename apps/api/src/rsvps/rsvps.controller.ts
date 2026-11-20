import {
  Body,
  Controller,
  Delete,
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
import { UserRole } from '../../generated/prisma/client';
import { Roles } from '../auth/auth.decorators';
import { AuthRateLimitService, type RateLimitMessages } from '../auth/auth-rate-limit.service';
import type { AuthenticatedRequest, AuthPrincipal } from '../auth/auth.types';
import type { Environment } from '../config/environment';
import { CreateRsvpDto } from './dto/create-rsvp.dto';
import { ListEventAttendeesDto } from './dto/list-event-attendees.dto';
import { RsvpsService } from './rsvps.service';

const rsvpRateLimitMessages: RateLimitMessages = {
  exceeded: 'Too many RSVP requests. Try again later.',
  unavailable: 'RSVPs are temporarily unavailable.',
};

function requirePrincipal(request: AuthenticatedRequest): AuthPrincipal {
  if (!request.user) {
    throw new UnauthorizedException();
  }
  return request.user;
}

@Controller('events')
export class RsvpsController {
  constructor(
    @Inject(RsvpsService)
    private readonly rsvps: RsvpsService,
    @Inject(AuthRateLimitService)
    private readonly rateLimit: AuthRateLimitService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  @Get(':id/rsvp/status')
  @Header('Cache-Control', 'private, no-store')
  async getStatus(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) eventId: string,
  ) {
    const principal = requirePrincipal(request);
    await this.consumeRateLimit(principal);
    return this.rsvps.getStatus(eventId, principal.id);
  }

  @Get(':id/attendees')
  @Header('Cache-Control', 'private, no-store')
  async listAttendees(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) eventId: string,
    @Query() query: ListEventAttendeesDto,
  ) {
    const principal = requirePrincipal(request);
    await this.consumeRateLimit(principal);
    return this.rsvps.listEventAttendees(eventId, principal, query);
  }

  @Post(':id/rsvp')
  @Roles(UserRole.STUDENT)
  @Header('Cache-Control', 'private, no-store')
  async rsvp(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) eventId: string,
    @Body() dto: CreateRsvpDto,
  ) {
    const principal = requirePrincipal(request);
    await this.consumeRateLimit(principal);
    return this.rsvps.rsvp(eventId, principal.id, dto.checkConflicts === true);
  }

  @Delete(':id/rsvp')
  @Roles(UserRole.STUDENT)
  @Header('Cache-Control', 'private, no-store')
  async cancel(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) eventId: string) {
    const principal = requirePrincipal(request);
    await this.consumeRateLimit(principal);
    return this.rsvps.cancel(eventId, principal.id);
  }

  @Post(':id/rsvp/ticket')
  @Roles(UserRole.STUDENT)
  @Header('Cache-Control', 'private, no-store')
  async issueTicket(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) eventId: string,
  ) {
    const principal = requirePrincipal(request);
    await this.consumeRateLimit(principal);
    return this.rsvps.issueTicket(eventId, principal.id);
  }

  private consumeRateLimit(principal: AuthPrincipal): Promise<void> {
    return this.rateLimit.consume(
      'rsvp-user',
      principal.id,
      this.config.get('RSVP_RATE_LIMIT_PER_MINUTE', { infer: true }),
      60_000,
      rsvpRateLimitMessages,
    );
  }
}
