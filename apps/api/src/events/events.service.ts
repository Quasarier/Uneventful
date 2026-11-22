import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventStatus, Prisma, type UserRole } from '../../generated/prisma/client';
import { randomUUID } from 'node:crypto';
import type { AuthPrincipal } from '../auth/auth.types';
import type { CreateEventDto } from './dto/create-event.dto';
import type { CreateImageUploadDto } from './dto/create-image-upload.dto';
import type { ListEventsDto } from './dto/list-events.dto';
import type { RejectEventDto } from './dto/reject-event.dto';
import type { UpdateEventDto } from './dto/update-event.dto';
import type { CreateEventSeriesDto } from '../venues/dto/create-event-series.dto';
import {
  ALLOWED_EVENT_IMAGE_TYPES,
  EVENT_IMAGE_UPLOAD_TTL_SECONDS,
  MAX_EVENT_IMAGE_SIZE,
  isEventImageContentType,
} from './event-image.constants';
import { EventImageStorageService } from './event-image-storage.service';
import { sanitizeDescription } from './event-description-sanitizer';
import { type EventRecord, EventsRepository } from './events.repository';
import { toEventResponseDto } from './event-response.dto';
import { VenueBookingsService } from '../venues/venue-bookings.service';

function slugify(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 200);
  return `${base || 'event'}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function parseDate(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new BadRequestException('A valid date is required.');
  }
  return date;
}

function assertValidRange(startAt: Date, endAt: Date): void {
  if (endAt <= startAt) {
    throw new BadRequestException('endAt must be later than startAt.');
  }
}

@Injectable()
export class EventsService {
  constructor(
    private readonly repository: EventsRepository,
    private readonly imageStorage: EventImageStorageService,
    private readonly venueBookings: VenueBookingsService,
  ) {}

  async list(actor: AuthPrincipal, query: ListEventsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const startDate = query.startDate ? parseDate(query.startDate) : undefined;
    const endDate = query.endDate ? parseDate(query.endDate) : undefined;
    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestException('startDate must not be later than endDate.');
    }

    const filters: Prisma.EventWhereInput[] = [{ deletedAt: null }];
    if (actor.role === 'STUDENT') {
      filters.push({ status: EventStatus.APPROVED, isPublic: true });
    } else if (actor.role === 'ORGANIZER') {
      filters.push({
        OR: [
          { status: EventStatus.APPROVED, isPublic: true },
          {
            club: {
              is: {
                deletedAt: null,
                memberships: {
                  some: {
                    userId: actor.id,
                    status: 'ACTIVE',
                    user: { isActive: true, deletedAt: null },
                  },
                },
              },
            },
          },
        ],
      });
    }
    if (query.categoryId) {
      filters.push({ categoryId: query.categoryId });
    }
    if (query.clubId) {
      filters.push({ clubId: query.clubId });
    }
    if (query.startDate || query.endDate) {
      const endDateIsDateOnly = Boolean(query.endDate && /^\d{4}-\d{2}-\d{2}$/.test(query.endDate));
      const exclusiveEndDate =
        endDate && endDateIsDateOnly
          ? new Date(endDate.getTime() + 24 * 60 * 60 * 1000)
          : undefined;
      filters.push({
        startAt: {
          ...(startDate ? { gte: startDate } : {}),
          ...(exclusiveEndDate ? { lt: exclusiveEndDate } : endDate ? { lte: endDate } : {}),
        },
      });
    }
    if (query.q) {
      filters.push({
        OR: [
          { title: { contains: query.q, mode: 'insensitive' } },
          { description: { contains: query.q, mode: 'insensitive' } },
        ],
      });
    }

    const { events, total } = await this.repository.listEvents({ AND: filters }, page, limit);
    const memberClubIds =
      actor.role === 'ADMIN'
        ? new Set(events.map((event) => event.clubId))
        : await this.repository.activeMembershipClubIds(actor.id, [
            ...new Set(events.map((event) => event.clubId)),
          ]);
    return {
      data: events.map((event) => toEventResponseDto(event, memberClubIds.has(event.clubId))),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async get(actor: AuthPrincipal, id: string) {
    const event = await this.requireEvent(id);
    await this.assertCanView(actor, event);
    const isMember =
      actor.role === 'ADMIN' || (await this.repository.hasActiveMembership(actor.id, event.clubId));
    return toEventResponseDto(event, isMember);
  }

  async create(actor: AuthPrincipal, dto: CreateEventDto) {
    this.assertCanManage(actor.role);
    await this.assertCanManageClub(actor, dto.clubId);
    await this.requireActiveCategory(dto.categoryId);

    const startAt = parseDate(dto.startAt);
    const endAt = parseDate(dto.endAt);
    assertValidRange(startAt, endAt);
    this.assertValidTimeZone(dto.timeZone);

    const event = await this.repository.createEvent(
      {
        title: dto.title.trim(),
        slug: slugify(dto.title),
        description: sanitizeDescription(dto.description),
        startAt,
        endAt,
        timeZone: dto.timeZone,
        capacity: dto.capacity ?? null,
        expectedAttendance: dto.expectedAttendance ?? dto.capacity ?? null,
        isPublic: dto.isPublic,
        venueId: dto.venueId ?? null,
        clubId: dto.clubId,
        categoryId: dto.categoryId,
        createdById: actor.id,
        status: EventStatus.DRAFT,
      },
      actor.id,
    );
    return toEventResponseDto(event);
  }

  async createSeries(actor: AuthPrincipal, dto: CreateEventSeriesDto) {
    this.assertCanManage(actor.role);
    await this.assertCanManageClub(actor, dto.clubId);
    await this.requireActiveCategory(dto.categoryId);

    const startAt = parseDate(dto.startAt);
    const endAt = parseDate(dto.endAt);
    assertValidRange(startAt, endAt);
    this.assertValidTimeZone(dto.timeZone);
    if ((dto.recurrence.count === undefined) === (dto.recurrence.untilDate === undefined)) {
      throw new BadRequestException('Specify exactly one recurrence count or end date.');
    }

    for (const date of dto.exceptionDates) {
      const parsed = new Date(`${date}T00:00:00.000Z`);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        throw new BadRequestException('exceptionDates must contain valid calendar dates.');
      }
    }

    const expectedAttendance = dto.expectedAttendance ?? dto.capacity ?? 0;
    const occurrences = this.venueBookings.getOccurrences({
      venueId: dto.venueId ?? '',
      startAt,
      endAt,
      expectedAttendance,
      recurrence: dto.recurrence,
      exceptionDates: dto.exceptionDates,
    });
    if (dto.venueId && expectedAttendance < 1) {
      throw new BadRequestException(
        'expectedAttendance or capacity is required when booking a venue.',
      );
    }

    const result = await this.repository.createEventSeries(
      occurrences.map((occurrence) => ({
        title: dto.title.trim(),
        slug: slugify(dto.title),
        description: sanitizeDescription(dto.description),
        startAt: occurrence.startAt,
        endAt: occurrence.endAt,
        timeZone: dto.timeZone,
        capacity: dto.capacity ?? null,
        expectedAttendance: dto.expectedAttendance ?? dto.capacity ?? null,
        isPublic: dto.isPublic,
        venueId: dto.venueId ?? null,
        occurrenceIndex: occurrence.occurrenceIndex,
        clubId: dto.clubId,
        categoryId: dto.categoryId,
        createdById: actor.id,
        status: EventStatus.DRAFT,
      })),
      {
        frequency: dto.recurrence.frequency,
        interval: dto.recurrence.interval,
        occurrenceCount: dto.recurrence.count ?? null,
        untilDate: dto.recurrence.untilDate
          ? new Date(`${dto.recurrence.untilDate}T00:00:00.000Z`)
          : null,
        exceptionDates: dto.exceptionDates.map((date) => new Date(`${date}T00:00:00.000Z`)),
      },
      occurrences,
      actor.id,
    );
    return {
      seriesId: result.seriesId,
      events: result.events.map((event) => toEventResponseDto(event)),
    };
  }

  async update(actor: AuthPrincipal, id: string, dto: UpdateEventDto) {
    this.assertCanManage(actor.role);
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException('At least one event field must be provided.');
    }

    const current = await this.requireEvent(id);
    await this.assertCanManageEvent(actor, current);
    if (current.status === EventStatus.CANCELLED) {
      throw new ConflictException('This event cannot be edited in its current state.');
    }

    if (dto.categoryId) {
      await this.requireActiveCategory(dto.categoryId);
    }

    const startAt = dto.startAt ? parseDate(dto.startAt) : current.startAt;
    const endAt = dto.endAt ? parseDate(dto.endAt) : current.endAt;
    assertValidRange(startAt, endAt);
    if (dto.timeZone !== undefined) {
      this.assertValidTimeZone(dto.timeZone);
    }

    const requiresApproval = current.status === EventStatus.APPROVED;
    const data: Prisma.EventUncheckedUpdateInput = {
      ...(dto.title !== undefined ? { title: dto.title.trim(), slug: slugify(dto.title) } : {}),
      ...(dto.description !== undefined
        ? { description: sanitizeDescription(dto.description) }
        : {}),
      ...(dto.startAt !== undefined ? { startAt } : {}),
      ...(dto.endAt !== undefined ? { endAt } : {}),
      ...(dto.timeZone !== undefined ? { timeZone: dto.timeZone } : {}),
      ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
      ...(dto.expectedAttendance !== undefined
        ? { expectedAttendance: dto.expectedAttendance }
        : {}),
      ...(dto.isPublic !== undefined ? { isPublic: dto.isPublic } : {}),
      ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
      ...(dto.venueId !== undefined ? { venueId: dto.venueId } : {}),
      ...(requiresApproval
        ? {
            status: EventStatus.PENDING_APPROVAL,
            approvedById: null,
            approvedAt: null,
            rejectionReason: null,
          }
        : dto.categoryId
          ? { rejectionReason: null }
          : {}),
    };

    const updated = await this.repository.updateEvent(
      id,
      current.status,
      data,
      actor.id,
      current.updatedAt,
      requiresApproval
        ? {
            action: 'EVENT_UPDATED_REQUIRES_APPROVAL',
            metadata: {
              fromStatus: EventStatus.APPROVED,
              toStatus: EventStatus.PENDING_APPROVAL,
            },
          }
        : undefined,
    );
    if (!updated) {
      throw new ConflictException('The event changed while it was being updated.');
    }
    return toEventResponseDto(updated, true);
  }

  async submit(actor: AuthPrincipal, id: string) {
    const event = await this.requireEvent(id);
    await this.assertCanManageEvent(actor, event);
    if (event.status !== EventStatus.DRAFT && event.status !== EventStatus.REJECTED) {
      throw new ConflictException('Only draft or rejected events can be submitted.');
    }
    return this.transition(event, actor, EventStatus.PENDING_APPROVAL, 'EVENT_SUBMITTED', {
      rejectionReason: null,
    });
  }

  async approve(actor: AuthPrincipal, id: string) {
    this.assertAdmin(actor.role);
    const event = await this.requireEvent(id);
    if (event.status !== EventStatus.PENDING_APPROVAL) {
      throw new ConflictException('Only pending events can be approved.');
    }
    if (event.createdById === actor.id) {
      throw new ForbiddenException('Event creators cannot approve their own events.');
    }
    return this.transition(event, actor, EventStatus.APPROVED, 'EVENT_APPROVED', {
      approvedById: actor.id,
      approvedAt: new Date(),
      rejectionReason: null,
    });
  }

  async reject(actor: AuthPrincipal, id: string, dto: RejectEventDto) {
    this.assertAdmin(actor.role);
    const event = await this.requireEvent(id);
    if (event.status !== EventStatus.PENDING_APPROVAL) {
      throw new ConflictException('Only pending events can be rejected.');
    }
    const reason = dto.reason.trim();
    if (!reason) {
      throw new BadRequestException('A rejection reason is required.');
    }
    return this.transition(
      event,
      actor,
      EventStatus.REJECTED,
      'EVENT_REJECTED',
      { rejectionReason: reason },
      { reason },
    );
  }

  async cancel(actor: AuthPrincipal, id: string) {
    this.assertCanManage(actor.role);
    const event = await this.requireEvent(id);
    await this.assertCanManageEvent(actor, event);
    if (event.status === EventStatus.CANCELLED) {
      throw new ConflictException('The event is already cancelled.');
    }
    return this.transition(event, actor, EventStatus.CANCELLED, 'EVENT_CANCELLED', {
      approvedById: null,
      approvedAt: null,
    });
  }

  async delete(actor: AuthPrincipal, id: string) {
    this.assertCanManage(actor.role);
    const event = await this.requireEvent(id);
    await this.assertCanManageEvent(actor, event);
    const deleted = await this.repository.deleteEvent(id, event.status, event.updatedAt, actor.id);
    if (!deleted) {
      throw new ConflictException('The event changed while it was being deleted.');
    }
    return { id: deleted.id, status: 'DELETED' as const };
  }

  async createImageUpload(actor: AuthPrincipal, id: string, dto: CreateImageUploadDto) {
    if (dto.size < 1 || dto.size > MAX_EVENT_IMAGE_SIZE) {
      throw new BadRequestException('The image exceeds the allowed size.');
    }
    const event = await this.requireEvent(id);
    await this.assertCanManageEvent(actor, event);
    if (event.status === EventStatus.CANCELLED) {
      throw new ConflictException('Cancelled events cannot receive images.');
    }
    const contentType = dto.contentType;
    const extension = Object.entries(ALLOWED_EVENT_IMAGE_TYPES).find(
      ([allowedType]) => allowedType === contentType,
    )?.[1];
    if (!extension) {
      throw new BadRequestException('The image type is not allowed.');
    }
    const key = `event-uploads/staging/${event.id}/${randomUUID()}.${extension}`;
    const expiresAt = new Date(Date.now() + EVENT_IMAGE_UPLOAD_TTL_SECONDS * 1000);
    const upload = await this.imageStorage.createUploadForm(key, contentType);
    const updated = await this.repository.startImageUpload(
      event.id,
      event.status,
      key,
      expiresAt,
      actor.id,
    );
    if (!updated) {
      throw new ConflictException('The event changed while the upload was being prepared.');
    }
    return {
      ...upload,
      expiresIn: EVENT_IMAGE_UPLOAD_TTL_SECONDS,
      maxSizeBytes: MAX_EVENT_IMAGE_SIZE,
    };
  }

  async confirmImageUpload(actor: AuthPrincipal, id: string) {
    const event = await this.requireEvent(id);
    await this.assertCanManageEvent(actor, event);
    if (event.status === EventStatus.CANCELLED) {
      throw new ConflictException('Cancelled events cannot receive images.');
    }
    const key = event.pendingImageKey;
    if (!key || !event.pendingImageExpiresAt || event.pendingImageExpiresAt <= new Date()) {
      throw new ConflictException('There is no active image upload for this event.');
    }
    if (event.pendingImageOwnerId !== actor.id) {
      throw new NotFoundException('Event image upload not found.');
    }
    const match = key.match(
      /^event-uploads\/staging\/([0-9a-f-]{36})\/[0-9a-f-]{36}\.(jpg|png|webp)$/,
    );
    if (!match || match[1] !== event.id) {
      throw new ConflictException('The pending image upload is invalid.');
    }
    const extension = match[2];
    const rawContentType = Object.entries(ALLOWED_EVENT_IMAGE_TYPES).find(
      ([, allowedExtension]) => allowedExtension === extension,
    )?.[0];
    if (!rawContentType || !isEventImageContentType(rawContentType)) {
      throw new ConflictException('The pending image upload is invalid.');
    }

    const finalKey = `events/${event.id}/${randomUUID()}.${extension}`;
    await this.imageStorage.sanitizeAndStoreUploadedObject(key, finalKey, rawContentType);
    const completed = await this.repository.completeImageUpload(
      id,
      key,
      finalKey,
      new Date(),
      event.status,
      actor.id,
      event.status === EventStatus.APPROVED && actor.role !== 'ADMIN',
    );
    if (!completed) {
      throw new ConflictException('The image upload expired or changed before confirmation.');
    }
    return toEventResponseDto(completed, true);
  }

  async getImage(actor: AuthPrincipal, id: string) {
    const event = await this.requireEvent(id);
    await this.assertCanView(actor, event);
    if (!event.imageKey) {
      throw new NotFoundException('Event image not found.');
    }
    return this.imageStorage.getFinalImage(event.imageKey);
  }

  private async transition(
    event: EventRecord,
    actor: AuthPrincipal,
    toStatus: EventStatus,
    action: string,
    extra: Prisma.EventUncheckedUpdateInput,
    extraMetadata?: Prisma.InputJsonValue,
  ) {
    const updated = await this.repository.updateEvent(
      event.id,
      event.status,
      { ...extra, status: toStatus },
      actor.id,
      event.updatedAt,
      {
        action,
        metadata: {
          fromStatus: event.status,
          toStatus,
          ...(extraMetadata && typeof extraMetadata === 'object' && !Array.isArray(extraMetadata)
            ? extraMetadata
            : {}),
        },
      },
    );
    if (!updated) {
      throw new ConflictException('The event changed while its state was being updated.');
    }
    return toEventResponseDto(updated, true);
  }

  private async requireEvent(id: string): Promise<EventRecord> {
    const event = await this.repository.findEvent(id);
    if (!event) {
      throw new NotFoundException('Event not found.');
    }
    return event;
  }

  private async assertCanView(actor: AuthPrincipal, event: EventRecord): Promise<void> {
    if (
      actor.role === 'ADMIN' ||
      (event.status === EventStatus.APPROVED &&
        event.isPublic &&
        (actor.role === 'STUDENT' || actor.role === 'ORGANIZER'))
    ) {
      return;
    }
    if (
      actor.role === 'ORGANIZER' &&
      (await this.repository.hasActiveMembership(actor.id, event.clubId))
    ) {
      return;
    }
    throw new NotFoundException('Event not found.');
  }

  private async assertCanManageEvent(actor: AuthPrincipal, event: EventRecord): Promise<void> {
    this.assertCanManage(actor.role);
    const allowed =
      actor.role === 'ADMIN'
        ? await this.repository.clubExists(event.clubId)
        : await this.repository.hasActiveMembership(actor.id, event.clubId);
    if (!allowed) {
      throw new NotFoundException('Event not found.');
    }
  }

  private async assertCanManageClub(
    actor: AuthPrincipal,
    clubId: string,
    allowDeletedForAdmin = false,
  ): Promise<void> {
    const clubExists =
      actor.role === 'ADMIN' && allowDeletedForAdmin
        ? await this.repository.clubExists(clubId)
        : await this.repository.isActiveClub(clubId);
    if (!clubExists) {
      throw new NotFoundException('Club not found.');
    }
    if (actor.role === 'ADMIN') {
      return;
    }
    if (!(await this.repository.hasActiveMembership(actor.id, clubId))) {
      throw new ForbiddenException('Active club membership is required.');
    }
  }

  private async requireActiveCategory(categoryId: string): Promise<void> {
    if (!(await this.repository.isActiveCategory(categoryId))) {
      throw new NotFoundException('Event category not found.');
    }
  }

  private assertCanManage(role: UserRole): void {
    if (role !== 'ORGANIZER' && role !== 'ADMIN') {
      throw new ForbiddenException();
    }
  }

  private assertAdmin(role: UserRole): void {
    if (role !== 'ADMIN') {
      throw new ForbiddenException();
    }
  }

  private assertValidTimeZone(timeZone: string): void {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
    } catch {
      throw new BadRequestException('timeZone must be a valid IANA time zone.');
    }
  }
}
