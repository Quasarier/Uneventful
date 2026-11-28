import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '../../generated/prisma/client';
import { AuthRateLimitService, type RateLimitMessages } from '../auth/auth-rate-limit.service';
import { AdminOnly, Roles } from '../auth/auth.decorators';
import { AdminAccessGuard } from '../admin/admin-access.guard';
import type { AuthenticatedRequest, AuthPrincipal } from '../auth/auth.types';
import { CheckVenueConflictsDto } from './dto/check-venue-conflicts.dto';
import { VenuesService } from './venues.service';
import { AdminCreateVenueDto } from '../admin/dto/admin-create-venue.dto';
import { AdminUpdateVenueDto } from '../admin/dto/admin-update-venue.dto';
import { AdminReasonDto } from '../admin/dto/admin-reason.dto';

const venueConflictRateLimit: RateLimitMessages = {
  exceeded: 'Too many venue conflict checks. Try again later.',
  unavailable: 'Venue conflict checks are temporarily unavailable.',
};

const venueWriteRateLimit: RateLimitMessages = {
  exceeded: 'Too many venue changes. Try again later.',
  unavailable: 'Venue changes are temporarily unavailable.',
};

function requirePrincipal(request: AuthenticatedRequest): AuthPrincipal {
  if (!request.user) {
    throw new UnauthorizedException();
  }
  return request.user;
}

@Controller('venues')
export class VenuesController {
  constructor(
    @Inject(VenuesService) private readonly venues: VenuesService,
    @Inject(AuthRateLimitService) private readonly rateLimit: AuthRateLimitService,
  ) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list() {
    return this.venues.list();
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  get(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.venues.get(requirePrincipal(request), id);
  }

  @Post('conflicts')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ORGANIZER, UserRole.ADMIN)
  @Header('Cache-Control', 'private, no-store')
  async checkConflicts(@Req() request: AuthenticatedRequest, @Body() dto: CheckVenueConflictsDto) {
    const principal = requirePrincipal(request);
    await this.rateLimit.consume(
      'venue-conflict-user',
      principal.id,
      30,
      60_000,
      venueConflictRateLimit,
    );
    return this.venues.checkConflicts(principal, dto);
  }

  @Post()
  @AdminOnly()
  @UseGuards(AdminAccessGuard)
  async create(@Req() request: AuthenticatedRequest, @Body() dto: AdminCreateVenueDto) {
    const principal = requirePrincipal(request);
    await this.consumeWriteLimit(principal);
    const { reason, ...venue } = dto;
    return this.venues.create(principal, venue, {
      reason,
      actorIp: request.ip || request.socket.remoteAddress || '',
    });
  }

  @Patch(':id')
  @AdminOnly()
  @UseGuards(AdminAccessGuard)
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminUpdateVenueDto,
  ) {
    const principal = requirePrincipal(request);
    await this.consumeWriteLimit(principal);
    const { reason, ...venue } = dto;
    return this.venues.update(principal, id, venue, {
      reason,
      actorIp: request.ip || request.socket.remoteAddress || '',
    });
  }

  @Delete(':id')
  @AdminOnly()
  @UseGuards(AdminAccessGuard)
  async retire(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminReasonDto,
  ) {
    const principal = requirePrincipal(request);
    await this.consumeWriteLimit(principal);
    return this.venues.retire(principal, id, {
      reason: dto.reason,
      actorIp: request.ip || request.socket.remoteAddress || '',
    });
  }

  private consumeWriteLimit(principal: AuthPrincipal): Promise<void> {
    return this.rateLimit.consume(
      'venue-write-user',
      principal.id,
      30,
      60_000,
      venueWriteRateLimit,
    );
  }
}
