import { Injectable } from '@nestjs/common';
import { Prisma, VenueBookingStatus } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';

const venueInclude = {
  availability: {
    select: { weekday: true, opensAt: true, closesAt: true },
    orderBy: { weekday: 'asc' },
  },
} satisfies Prisma.VenueInclude;

export type BookingVenueRecord = Prisma.VenueGetPayload<{ include: typeof venueInclude }>;
export type BookingTransaction = Prisma.TransactionClient;

export interface BookingSlot {
  startAt: Date;
  endAt: Date;
}

export type ConflictingSlot = BookingSlot;

export interface SaveBookingInput extends BookingSlot {
  eventId: string;
  venueId: string;
  requestedById: string;
  status: VenueBookingStatus;
  reviewedById: string | null;
  reviewedAt: Date | null;
  actorId: string;
  action: string;
}

@Injectable()
export class VenueBookingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  withTransaction<T>(work: (transaction: BookingTransaction) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async lockAndFindVenue(
    transaction: BookingTransaction,
    venueId: string,
  ): Promise<BookingVenueRecord | null> {
    await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "venues" WHERE "id" = ${venueId}::uuid FOR UPDATE
    `;
    return transaction.venue.findUnique({ where: { id: venueId }, include: venueInclude });
  }

  findVenue(transaction: BookingTransaction, venueId: string): Promise<BookingVenueRecord | null> {
    return transaction.venue.findUnique({ where: { id: venueId }, include: venueInclude });
  }

  async findConflicts(
    transaction: BookingTransaction,
    venueId: string,
    slot: BookingSlot,
    bufferMinutes: number,
    excludeEventId?: string,
  ): Promise<ConflictingSlot[]> {
    const padding = bufferMinutes * 60_000;
    const bookings = await transaction.venueBooking.findMany({
      where: {
        venueId,
        status: { in: [VenueBookingStatus.PENDING, VenueBookingStatus.APPROVED] },
        ...(excludeEventId ? { eventId: { not: excludeEventId } } : {}),
        startAt: { lt: new Date(slot.endAt.getTime() + padding) },
        endAt: { gt: new Date(slot.startAt.getTime() - padding) },
      },
      select: { startAt: true, endAt: true },
      orderBy: [{ startAt: 'asc' }, { endAt: 'asc' }],
    });
    return bookings.map(({ startAt, endAt }) => ({ startAt, endAt }));
  }

  listActiveVenues(transaction: BookingTransaction): Promise<BookingVenueRecord[]> {
    return transaction.venue.findMany({
      where: { isActive: true, deletedAt: null },
      include: venueInclude,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 100,
    });
  }

  async listVenueBookings(
    transaction: BookingTransaction,
    venueId: string,
    startAt: Date,
    endAt: Date,
    bufferMinutes: number,
  ): Promise<ConflictingSlot[]> {
    const padding = bufferMinutes * 60_000;
    const bookings = await transaction.venueBooking.findMany({
      where: {
        venueId,
        status: { in: [VenueBookingStatus.PENDING, VenueBookingStatus.APPROVED] },
        startAt: { lt: new Date(endAt.getTime() + padding) },
        endAt: { gt: new Date(startAt.getTime() - padding) },
      },
      select: { startAt: true, endAt: true },
      orderBy: [{ startAt: 'asc' }, { endAt: 'asc' }],
    });
    return bookings.map(({ startAt: bookingStart, endAt: bookingEnd }) => ({
      startAt: bookingStart,
      endAt: bookingEnd,
    }));
  }

  findBooking(transaction: BookingTransaction, eventId: string) {
    return transaction.venueBooking.findFirst({
      where: { eventId },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async saveBooking(transaction: BookingTransaction, input: SaveBookingInput): Promise<void> {
    const previous = await this.findBooking(transaction, input.eventId);
    await transaction.venueBooking.updateMany({
      where: {
        eventId: input.eventId,
        status: { in: [VenueBookingStatus.PENDING, VenueBookingStatus.APPROVED] },
        ...(previous ? { id: { not: previous.id } } : {}),
      },
      data: {
        status: VenueBookingStatus.CANCELLED,
        reviewedById: null,
        reviewedAt: null,
      },
    });
    const booking = previous
      ? await transaction.venueBooking.update({
          where: { id: previous.id },
          data: {
            venueId: input.venueId,
            requestedById: input.requestedById,
            status: input.status,
            startAt: input.startAt,
            endAt: input.endAt,
            reviewedById: input.reviewedById,
            reviewedAt: input.reviewedAt,
          },
        })
      : await transaction.venueBooking.create({
          data: {
            eventId: input.eventId,
            venueId: input.venueId,
            requestedById: input.requestedById,
            status: input.status,
            startAt: input.startAt,
            endAt: input.endAt,
            reviewedById: input.reviewedById,
            reviewedAt: input.reviewedAt,
          },
        });
    await transaction.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        entityType: 'VenueBooking',
        entityId: booking.id,
        metadata: { venueId: input.venueId, status: input.status },
      },
    });
  }

  async releaseBooking(
    transaction: BookingTransaction,
    eventId: string,
    actorId: string,
  ): Promise<void> {
    const bookings = await transaction.venueBooking.findMany({
      where: {
        eventId,
        status: { in: [VenueBookingStatus.PENDING, VenueBookingStatus.APPROVED] },
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, venueId: true },
    });
    const booking = bookings[0];
    if (!booking) {
      return;
    }
    await transaction.venueBooking.updateMany({
      where: { eventId, status: { in: [VenueBookingStatus.PENDING, VenueBookingStatus.APPROVED] } },
      data: {
        status: VenueBookingStatus.CANCELLED,
        reviewedById: null,
        reviewedAt: null,
      },
    });
    await transaction.auditLog.create({
      data: {
        actorId,
        action: 'VENUE_BOOKING_CANCELLED',
        entityType: 'VenueBooking',
        entityId: booking.id,
        metadata: { venueId: booking.venueId, status: VenueBookingStatus.CANCELLED },
      },
    });
  }
}
