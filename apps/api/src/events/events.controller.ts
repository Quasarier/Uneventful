import {
  Body,
  Controller,
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
} from '@nestjs/common';
import type { Response } from 'express';
import { UserRole } from '../../generated/prisma/client';
import { Roles } from '../auth/auth.decorators';
import { AuthRateLimitService, type RateLimitMessages } from '../auth/auth-rate-limit.service';
import type { AuthenticatedRequest, AuthPrincipal } from '../auth/auth.types';
import { CreateEventDto } from './dto/create-event.dto';
import { CreateImageUploadDto } from './dto/create-image-upload.dto';
import { ListEventsDto } from './dto/list-events.dto';
import { RejectEventDto } from './dto/reject-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { EventsService } from './events.service';

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

@Controller('events')
export class EventsController {
  constructor(
    @Inject(EventsService)
    private readonly events: EventsService,
    @Inject(AuthRateLimitService)
    private readonly rateLimit: AuthRateLimitService,
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
  create(@Req() request: AuthenticatedRequest, @Body() dto: CreateEventDto) {
    return this.events.create(requirePrincipal(request), dto);
  }

  @Patch(':id')
  @Roles(UserRole.ORGANIZER, UserRole.ADMIN)
  update(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEventDto,
  ) {
    return this.events.update(requirePrincipal(request), id, dto);
  }

  @Post(':id/submit')
  @Roles(UserRole.ORGANIZER, UserRole.ADMIN)
  submit(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.events.submit(requirePrincipal(request), id);
  }

  @Post(':id/approve')
  @Roles(UserRole.ADMIN)
  approve(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.events.approve(requirePrincipal(request), id);
  }

  @Post(':id/reject')
  @Roles(UserRole.ADMIN)
  reject(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectEventDto,
  ) {
    return this.events.reject(requirePrincipal(request), id, dto);
  }

  @Post(':id/cancel')
  @Roles(UserRole.ORGANIZER, UserRole.ADMIN)
  cancel(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.events.cancel(requirePrincipal(request), id);
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
      })
      .send(image.body);
  }
}
