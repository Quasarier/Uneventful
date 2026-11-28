import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { UserRole } from '../../generated/prisma/client';
import { AdminOnly, Roles } from '../auth/auth.decorators';
import { AdminAccessGuard } from '../admin/admin-access.guard';
import { AuthRateLimitService, type RateLimitMessages } from '../auth/auth-rate-limit.service';
import type { AuthenticatedRequest, AuthPrincipal } from '../auth/auth.types';
import { CreateEventDto } from './dto/create-event.dto';
import { CreateImageUploadDto } from './dto/create-image-upload.dto';
import { ListEventsDto } from './dto/list-events.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { CreateEventSeriesDto } from '../venues/dto/create-event-series.dto';
import { EventsService } from './events.service';
import { AdminService } from '../admin/admin.service';
import { AdminReasonDto } from '../admin/dto/admin-reason.dto';

function requirePrincipal(request: AuthenticatedRequest): AuthPrincipal {
  if (!request.user) {
    throw new UnauthorizedException();
  }
  return request.user;
}

const eventImageRateLimit: RateLimitMessages = {
  exceeded: 'Too many image requests. Try again later.',
  unavailable: 'Image delivery is temporarily unavailable.',
};

const eventBookingWriteRateLimit: RateLimitMessages = {
  exceeded: 'Too many event or venue booking changes. Try again later.',
  unavailable: 'Event or venue booking changes are temporarily unavailable.',
};

@Controller('events')
export class EventsController {
  constructor(
    @Inject(EventsService)
    private readonly events: EventsService,
    @Inject(AuthRateLimitService)
    private readonly rateLimit: AuthRateLimitService,
    @Inject(AdminService)
    private readonly admin: AdminService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Query() query: ListEventsDto) {
    return this.events.list(requirePrincipal(request), query);
  }

  @Get(':id')
  get(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.events.get(requirePrincipal(request), id);
  }

  @Post()
  @Roles(UserRole.ORGANIZER, UserRole.ADMIN)
  async create(@Req() request: AuthenticatedRequest, @Body() dto: CreateEventDto) {
    const principal = requirePrincipal(request);
    await this.consumeBookingWriteLimit(principal);
    return this.events.create(principal, dto);
  }

  @Post('series')
  @Roles(UserRole.ORGANIZER, UserRole.ADMIN)
  async createSeries(@Req() request: AuthenticatedRequest, @Body() dto: CreateEventSeriesDto) {
    const principal = requirePrincipal(request);
    await this.consumeBookingWriteLimit(principal);
    return this.events.createSeries(principal, dto);
  }

  @Patch(':id')
  @Roles(UserRole.ORGANIZER, UserRole.ADMIN)
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEventDto,
  ) {
    const principal = requirePrincipal(request);
    await this.consumeBookingWriteLimit(principal);
    return this.events.update(principal, id, dto);
  }

  @Post(':id/submit')
  @Roles(UserRole.ORGANIZER, UserRole.ADMIN)
  async submit(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const principal = requirePrincipal(request);
    await this.consumeBookingWriteLimit(principal);
    return this.events.submit(principal, id);
  }

  @Post(':id/approve')
  @AdminOnly()
  @UseGuards(AdminAccessGuard)
  async approve(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminReasonDto,
  ) {
    const principal = requirePrincipal(request);
    await this.consumeBookingWriteLimit(principal);
    return this.admin.approveEvent(
      principal,
      id,
      dto.reason,
      request.ip || request.socket.remoteAddress || '',
    );
  }

  @Post(':id/reject')
  @AdminOnly()
  @UseGuards(AdminAccessGuard)
  async reject(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminReasonDto,
  ) {
    const principal = requirePrincipal(request);
    await this.consumeBookingWriteLimit(principal);
    return this.admin.rejectEvent(
      principal,
      id,
      dto.reason,
      request.ip || request.socket.remoteAddress || '',
    );
  }

  @Post(':id/cancel')
  @Roles(UserRole.ORGANIZER, UserRole.ADMIN)
  async cancel(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const principal = requirePrincipal(request);
    await this.consumeBookingWriteLimit(principal);
    return this.events.cancel(principal, id);
  }

  @Delete(':id')
  @Roles(UserRole.ORGANIZER, UserRole.ADMIN)
  async delete(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const principal = requirePrincipal(request);
    await this.consumeBookingWriteLimit(principal);
    return this.events.delete(principal, id);
  }

  @Post(':id/image-upload')
  @Roles(UserRole.ORGANIZER, UserRole.ADMIN)
  createImageUpload(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateImageUploadDto,
  ) {
    return this.events.createImageUpload(requirePrincipal(request), id, dto);
  }

  @Post(':id/image-upload/confirm')
  @Roles(UserRole.ORGANIZER, UserRole.ADMIN)
  confirmImageUpload(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.events.confirmImageUpload(requirePrincipal(request), id);
  }

  @Get(':id/image')
  async getImage(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const principal = requirePrincipal(request);
    const clientIp = request.ip || request.socket.remoteAddress || 'unknown';
    await this.rateLimit.consume('event-image-ip', clientIp, 120, 60_000, eventImageRateLimit);
    await this.rateLimit.consume(
      'event-image-user',
      principal.id,
      120,
      60_000,
      eventImageRateLimit,
    );
    const image = await this.events.getImage(principal, id);
    response
      .status(200)
      .set({
        'Content-Type': image.contentType,
        'Content-Disposition': `attachment; filename="event-image.${image.extension}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      })
      .send(image.body);
  }

  private consumeBookingWriteLimit(principal: AuthPrincipal): Promise<void> {
    return this.rateLimit.consume(
      'venue-booking-write-user',
      principal.id,
      30,
      60_000,
      eventBookingWriteRateLimit,
    );
  }
}
