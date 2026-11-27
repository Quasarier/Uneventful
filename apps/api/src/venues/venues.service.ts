import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types';
import type { CheckVenueConflictsDto } from './dto/check-venue-conflicts.dto';
import type { CreateVenueDto } from './dto/create-venue.dto';
import type { UpdateVenueDto } from './dto/update-venue.dto';
import { toVenueResponseDto } from './venue-response.dto';
import { VenueBookingsService } from './venue-bookings.service';
import { VenuesRepository } from './venues.repository';

export interface AdminVenueAuditContext {
  reason: string;
  actorIp: string;
}

@Injectable()
export class VenuesService {
  constructor(
    private readonly repository: VenuesRepository,
    private readonly bookings: VenueBookingsService,
  ) {}

  async list() {
    const venues = await this.repository.listActive();
    return { data: venues.map(toVenueResponseDto) };
  }

  async get(actor: AuthPrincipal, venueId: string) {
    const venue = await this.repository.findById(venueId);
    if (!venue || venue.deletedAt || (actor.role !== 'ADMIN' && !venue.isActive)) {
      throw new NotFoundException('Venue not found.');
    }
    return toVenueResponseDto(venue);
  }

  async create(actor: AuthPrincipal, dto: CreateVenueDto, auditContext?: AdminVenueAuditContext) {
    this.assertAdmin(actor);
    this.assertValidHours(dto.availabilityHours);
    return toVenueResponseDto(
      await this.repository.create(dto, actor.id, this.validateAuditContext(auditContext)),
    );
  }

  async update(
    actor: AuthPrincipal,
    venueId: string,
    dto: UpdateVenueDto,
    auditContext?: AdminVenueAuditContext,
  ) {
    this.assertAdmin(actor);
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException('At least one venue field must be provided.');
    }
    if (dto.availabilityHours) {
      this.assertValidHours(dto.availabilityHours);
    }
    const venue = await this.repository.update(
      venueId,
      dto,
      actor.id,
      this.validateAuditContext(auditContext),
    );
    if (!venue || venue.deletedAt) {
      throw new NotFoundException('Venue not found.');
    }
    return toVenueResponseDto(venue);
  }

  async retire(actor: AuthPrincipal, venueId: string, auditContext?: AdminVenueAuditContext) {
    this.assertAdmin(actor);
    const venue = await this.repository.retire(
      venueId,
      actor.id,
      this.validateAuditContext(auditContext),
    );
    if (!venue || venue.deletedAt) {
      throw new NotFoundException('Venue not found.');
    }
    return toVenueResponseDto(venue);
  }

  async checkConflicts(actor: AuthPrincipal, dto: CheckVenueConflictsDto) {
    if (actor.role !== 'ADMIN' && actor.role !== 'ORGANIZER') {
      throw new ForbiddenException();
    }
    if (dto.eventId) {
      const event = await this.repository.findVisibleEventClub(dto.eventId);
      if (
        !event ||
        (actor.role !== 'ADMIN' &&
          !(await this.repository.hasActiveMembership(actor.id, event.clubId)))
      ) {
        throw new NotFoundException('Event not found.');
      }
    }
    return this.bookings.checkAvailability({
      venueId: dto.venueId,
      startAt: new Date(dto.startAt),
      endAt: new Date(dto.endAt),
      expectedAttendance: dto.expectedAttendance,
      ...(dto.eventId ? { eventId: dto.eventId } : {}),
      ...(dto.recurrence ? { recurrence: dto.recurrence } : {}),
      ...(dto.exceptionDates ? { exceptionDates: dto.exceptionDates } : {}),
    });
  }

  private assertAdmin(actor: AuthPrincipal): void {
    if (actor.role !== 'ADMIN') {
      throw new ForbiddenException();
    }
  }

  private validateAuditContext(
    context: AdminVenueAuditContext | undefined,
  ): AdminVenueAuditContext | undefined {
    if (!context) return undefined;
    const reason = context.reason.trim();
    if (!reason || reason.length > 1000) {
      throw new BadRequestException('A reason between 1 and 1000 characters is required.');
    }
    return { ...context, reason };
  }

  private assertValidHours(
    hours: Array<{ weekday: number; opensAt: string; closesAt: string }>,
  ): void {
    if (hours.some(({ opensAt, closesAt }) => closesAt <= opensAt)) {
      throw new BadRequestException('Venue closing times must be later than opening times.');
    }
  }
}
