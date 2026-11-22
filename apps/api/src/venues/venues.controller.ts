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
} from '@nestjs/common';
import { UserRole } from '../../generated/prisma/client';
import { AuthRateLimitService, type RateLimitMessages } from '../auth/auth-rate-limit.service';
import { Roles } from '../auth/auth.decorators';
import type { AuthenticatedRequest, AuthPrincipal } from '../auth/auth.types';
import { CheckVenueConflictsDto } from './dto/check-venue-conflicts.dto';
import { CreateVenueDto } from './dto/create-venue.dto';
import { UpdateVenueDto } from './dto/update-venue.dto';
import { VenuesService } from './venues.service';

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
  @Roles(UserRole.ADMIN)
  async create(@Req() request: AuthenticatedRequest, @Body() dto: CreateVenueDto) {
    const principal = requirePrincipal(request);
    await this.consumeWriteLimit(principal);
    return this.venues.create(principal, dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVenueDto,
  ) {
    const principal = requirePrincipal(request);
    await this.consumeWriteLimit(principal);
    return this.venues.update(principal, id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  async retire(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const principal = requirePrincipal(request);
    await this.consumeWriteLimit(principal);
    return this.venues.retire(principal, id);
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
