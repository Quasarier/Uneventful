import { Injectable } from '@nestjs/common';
import { EventStatus, Prisma, type RecurrenceFrequency } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { VenueBookingsService } from '../venues/venue-bookings.service';
import type { EventOccurrence } from '../venues/venue-time';

const eventInclude = {
  club: { select: { name: true, slug: true } },
  category: { select: { name: true, slug: true } },
  venue: { select: { id: true, name: true, building: true } },
} satisfies Prisma.EventInclude;

export type EventRecord = Prisma.EventGetPayload<{ include: typeof eventInclude }>;

const bookingWriteTransactionOptions = { maxWait: 10_000, timeout: 30_000 } as const;

@Injectable()
export class EventsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly venueBookings: VenueBookingsService,
  ) {}

  isActiveClub(clubId: string): Promise<boolean> {
    return this.prisma.club
      .findFirst({ where: { id: clubId, deletedAt: null }, select: { id: true } })
      .then(Boolean);
  }

  clubExists(clubId: string): Promise<boolean> {
    return this.prisma.club
      .findUnique({ where: { id: clubId }, select: { id: true } })
      .then(Boolean);
  }

  isActiveCategory(categoryId: string): Promise<boolean> {
    return this.prisma.eventCategory
      .findFirst({ where: { id: categoryId, deletedAt: null }, select: { id: true } })
      .then(Boolean);
  }

  hasActiveMembership(userId: string, clubId: string): Promise<boolean> {
    return this.prisma.clubMembership
      .findFirst({
        where: {
          userId,
          clubId,
          status: 'ACTIVE',
          club: { deletedAt: null },
          user: { isActive: true, deletedAt: null },
        },
        select: { id: true },
      })
      .then(Boolean);
  }

  async activeMembershipClubIds(userId: string, clubIds: string[]): Promise<Set<string>> {
    if (clubIds.length === 0) {
      return new Set();
    }

    const memberships = await this.prisma.clubMembership.findMany({
      where: {
        userId,
        clubId: { in: clubIds },
        status: 'ACTIVE',
        club: { deletedAt: null },
        user: { isActive: true, deletedAt: null },
      },
      select: { clubId: true },
    });
    return new Set(memberships.map(({ clubId }) => clubId));
  }

  findEvent(id: string): Promise<EventRecord | null> {
    return this.prisma.event.findFirst({
      where: { id, deletedAt: null },
      include: eventInclude,
    });
  }

  async listEvents(where: Prisma.EventWhereInput, page: number, limit: number) {
    const [events, total] = await this.prisma.$transaction([
      this.prisma.event.findMany({
        where,
        include: eventInclude,
        orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.event.count({ where }),
    ]);

    return { events, total };
  }

  async createEvent(data: Prisma.EventUncheckedCreateInput, actorId: string): Promise<EventRecord> {
    return this.prisma.$transaction(async (transaction) => {
      if (typeof data.venueId === 'string') {
        await this.venueBookings.lockVenueForEventWrite(transaction, data.venueId, true);
      }
      const event = await transaction.event.create({ data, include: eventInclude });
      await this.venueBookings.syncEventBooking(transaction, {
        eventId: event.id,
        venueId: event.venueId,
        startAt: event.startAt,
        endAt: event.endAt,
        expectedAttendance: event.expectedAttendance,
        eventStatus: event.status,
        requestedById: event.createdById,
        actorId,
      });
      await transaction.auditLog.create({
        data: {
          actorId,
          action: 'EVENT_CREATED',
          entityType: 'Event',
          entityId: event.id,
          metadata: { toStatus: event.status },
        },
      });
      return event;
    }, bookingWriteTransactionOptions);
  }

  async createEventSeries(
    eventData: Prisma.EventUncheckedCreateInput[],
    recurrence: {
      frequency: RecurrenceFrequency;
      interval: number;
      occurrenceCount: number | null;
      untilDate: Date | null;
      exceptionDates: Date[];
    },
    occurrences: EventOccurrence[],
    actorId: string,
  ): Promise<{ seriesId: string; events: EventRecord[] }> {
    return this.prisma.$transaction(async (transaction) => {
      const first = eventData[0];
      if (!first) {
        throw new Error('An event series must contain at least one occurrence.');
      }

      const series = await transaction.eventSeries.create({
        data: recurrence,
      });
      const createData = eventData.map((event) => ({ ...event, seriesId: series.id }));
      if (first.venueId) {
        const attendance = first.expectedAttendance;
        if (attendance === null || attendance === undefined) {
          throw new Error('A venue event series must include expected attendance.');
        }
        await this.venueBookings.assertSeriesAvailability(
          transaction,
          {
            venueId: first.venueId,
            startAt: first.startAt instanceof Date ? first.startAt : new Date(first.startAt),
            endAt: first.endAt instanceof Date ? first.endAt : new Date(first.endAt),
            expectedAttendance: attendance,
          },
          occurrences,
        );
      }

      const events: EventRecord[] = [];
      for (const data of createData) {
        const event = await transaction.event.create({ data, include: eventInclude });
        await this.venueBookings.syncEventBooking(transaction, {
          eventId: event.id,
          venueId: event.venueId,
          startAt: event.startAt,
          endAt: event.endAt,
          expectedAttendance: event.expectedAttendance,
          eventStatus: event.status,
          requestedById: event.createdById,
          actorId,
        });
        await transaction.auditLog.create({
          data: {
            actorId,
            action: 'EVENT_CREATED',
            entityType: 'Event',
            entityId: event.id,
            metadata: { toStatus: event.status, seriesId: series.id },
          },
        });
        events.push(event);
      }
      await transaction.auditLog.create({
        data: {
          actorId,
          action: 'EVENT_SERIES_CREATED',
          entityType: 'EventSeries',
          entityId: series.id,
          metadata: {
            frequency: recurrence.frequency,
            interval: recurrence.interval,
            occurrenceCount: recurrence.occurrenceCount,
            occurrences: events.length,
          },
        },
      });
      return { seriesId: series.id, events };
    }, bookingWriteTransactionOptions);
  }

  async updateEvent(
    id: string,
    expectedStatus: EventStatus,
    data: Prisma.EventUncheckedUpdateInput,
    actorId: string,
    expectedUpdatedAt: Date,
    audit?: { action: string; metadata: Prisma.InputJsonValue },
  ): Promise<EventRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "events" WHERE "id" = ${id}::uuid AND "deleted_at" IS NULL FOR UPDATE
      `;
      const current = await transaction.event.findUnique({
        where: { id },
        select: { venueId: true },
      });
      if (!current) {
        return null;
      }
      const requestedVenueId =
        typeof data.venueId === 'string'
          ? data.venueId
          : data.venueId === null
            ? null
            : current.venueId;
      const venueIds = new Set(
        [current.venueId, requestedVenueId].filter((venueId): venueId is string =>
          Boolean(venueId),
        ),
      );
      for (const venueId of [...venueIds].sort()) {
        await this.venueBookings.lockVenueForEventWrite(
          transaction,
          venueId,
          typeof data.venueId === 'string' && data.venueId === venueId,
        );
      }
      const result = await transaction.event.updateMany({
        where: { id, deletedAt: null, status: expectedStatus, updatedAt: expectedUpdatedAt },
        data,
      });
      if (result.count !== 1) {
        return null;
      }

      const event = await transaction.event.findUnique({
        where: { id },
        include: eventInclude,
      });
      if (!event) {
        return null;
      }

      await this.venueBookings.syncEventBooking(transaction, {
        eventId: event.id,
        venueId: event.venueId,
        startAt: event.startAt,
        endAt: event.endAt,
        expectedAttendance: event.expectedAttendance,
        eventStatus: event.status,
        requestedById: event.createdById,
        actorId,
      });

      if (audit) {
        await transaction.auditLog.create({
          data: {
            actorId,
            action: audit.action,
            entityType: 'Event',
            entityId: id,
            metadata: audit.metadata,
          },
        });
      }
      return event;
    }, bookingWriteTransactionOptions);
  }

  async deleteEvent(
    id: string,
    expectedStatus: EventStatus,
    expectedUpdatedAt: Date,
    actorId: string,
  ): Promise<EventRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "events" WHERE "id" = ${id}::uuid AND "deleted_at" IS NULL FOR UPDATE
      `;
      const current = await transaction.event.findUnique({
        where: { id },
        select: { venueId: true },
      });
      if (!current) {
        return null;
      }
      if (current.venueId) {
        await this.venueBookings.lockVenueForEventWrite(transaction, current.venueId, false);
      }
      const result = await transaction.event.updateMany({
        where: { id, deletedAt: null, status: expectedStatus, updatedAt: expectedUpdatedAt },
        data: {
          status: EventStatus.CANCELLED,
          deletedAt: new Date(),
          approvedById: null,
          approvedAt: null,
        },
      });
      if (result.count !== 1) {
        return null;
      }
      const event = await transaction.event.findUnique({ where: { id }, include: eventInclude });
      if (!event) {
        return null;
      }
      await this.venueBookings.syncEventBooking(transaction, {
        eventId: event.id,
        venueId: event.venueId,
        startAt: event.startAt,
        endAt: event.endAt,
        expectedAttendance: event.expectedAttendance,
        eventStatus: EventStatus.CANCELLED,
        requestedById: event.createdById,
        actorId,
      });
      await transaction.auditLog.create({
        data: {
          actorId,
          action: 'EVENT_DELETED',
          entityType: 'Event',
          entityId: id,
          metadata: { fromStatus: expectedStatus, toStatus: EventStatus.CANCELLED },
        },
      });
      return event;
    }, bookingWriteTransactionOptions);
  }
  async startImageUpload(
    id: string,
    expectedStatus: EventStatus,
    key: string,
    expiresAt: Date,
    ownerId: string,
  ): Promise<EventRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const result = await transaction.event.updateMany({
        where: { id, deletedAt: null, status: expectedStatus },
        data: {
          pendingImageKey: key,
          pendingImageExpiresAt: expiresAt,
          pendingImageOwnerId: ownerId,
        },
      });
      if (result.count !== 1) {
        return null;
      }

      const event = await transaction.event.findUnique({ where: { id }, include: eventInclude });
      if (!event) {
        return null;
      }

      return event;
    });
  }

  async completeImageUpload(
    id: string,
    uploadKey: string,
    finalKey: string,
    now: Date,
    expectedStatus: EventStatus,
    actorId: string,
    requiresApproval: boolean,
  ): Promise<EventRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const result = await transaction.event.updateMany({
        where: {
          id,
          deletedAt: null,
          status: expectedStatus,
          pendingImageKey: uploadKey,
          pendingImageOwnerId: actorId,
          pendingImageExpiresAt: { gt: now },
        },
        data: {
          imageKey: finalKey,
          pendingImageKey: null,
          pendingImageExpiresAt: null,
          pendingImageOwnerId: null,
          ...(requiresApproval
            ? {
                status: EventStatus.PENDING_APPROVAL,
                approvedById: null,
                approvedAt: null,
              }
            : {}),
        },
      });
      if (result.count !== 1) {
        return null;
      }

      const event = await transaction.event.findUnique({ where: { id }, include: eventInclude });
      if (!event) {
        return null;
      }

      if (requiresApproval) {
        await transaction.auditLog.create({
          data: {
            actorId,
            action: 'EVENT_IMAGE_CHANGED_REQUIRES_APPROVAL',
            entityType: 'Event',
            entityId: id,
            metadata: { fromStatus: expectedStatus, toStatus: EventStatus.PENDING_APPROVAL },
          },
        });
      }
      return event;
    });
  }
}
