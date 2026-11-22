import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventStatus, VenueBookingStatus } from '../../generated/prisma/client';
import type { Environment } from '../config/environment';
import {
  generateOccurrences,
  intervalsConflict,
  isWithinAvailability,
  type EventOccurrence,
  type RecurrenceRule,
} from './venue-time';
import {
  type BookingSlot,
  type BookingTransaction,
  type BookingVenueRecord,
  type ConflictingSlot,
  VenueBookingsRepository,
} from './venue-bookings.repository';
import { VenueConflictException } from './venue-conflict.exception';

export interface VenueConflictInput extends BookingSlot {
  venueId: string;
  expectedAttendance: number;
  eventId?: string;
  recurrence?: RecurrenceRule;
  exceptionDates?: string[];
}

export interface VenueAlternative extends BookingSlot {
  venueId: string;
  name: string;
  building: string | null;
}

export interface VenueConflictResponse {
  statusCode: 409;
  message: string;
  reasons: string[];
  conflicts: BookingSlot[];
  alternatives: VenueAlternative[];
}

export interface EventBookingSyncInput extends BookingSlot {
  eventId: string;
  venueId: string | null;
  expectedAttendance: number | null;
  eventStatus: EventStatus;
  requestedById: string;
  actorId: string;
}

const MAX_ALTERNATIVES = 3;
const ALTERNATIVE_HORIZON_DAYS = 14;
const ALTERNATIVE_STEP_MS = 15 * 60_000;

@Injectable()
export class VenueBookingsService {
  private readonly campusTimeZone: string;

  constructor(
    private readonly repository: VenueBookingsRepository,
    config: ConfigService<Environment, true>,
  ) {
    this.campusTimeZone = config.get('CAMPUS_TIME_ZONE', { infer: true });
  }

  async checkAvailability(input: VenueConflictInput): Promise<{
    available: true;
    conflicts: [];
    alternatives: [];
  }> {
    const occurrences = this.getOccurrences(input);
    await this.repository.withTransaction((transaction) =>
      this.assertAvailability(transaction, input, occurrences, false),
    );
    return { available: true, conflicts: [], alternatives: [] };
  }

  async syncEventBooking(
    transaction: BookingTransaction,
    input: EventBookingSyncInput,
  ): Promise<void> {
    if (!input.venueId) {
      await this.repository.releaseBooking(transaction, input.eventId, input.actorId);
      return;
    }

    const status = statusForEvent(input.eventStatus);
    if (status === VenueBookingStatus.PENDING || status === VenueBookingStatus.APPROVED) {
      if (input.expectedAttendance === null) {
        throw new BadRequestException(
          'expectedAttendance or capacity is required when booking a venue.',
        );
      }
      await this.assertAvailability(
        transaction,
        {
          venueId: input.venueId,
          startAt: input.startAt,
          endAt: input.endAt,
          expectedAttendance: input.expectedAttendance,
          eventId: input.eventId,
        },
        [{ occurrenceIndex: 0, startAt: input.startAt, endAt: input.endAt }],
        true,
      );
    }

    const previous = await this.repository.findBooking(transaction, input.eventId);
    const action =
      status === VenueBookingStatus.APPROVED
        ? 'VENUE_BOOKING_APPROVED'
        : status === VenueBookingStatus.REJECTED
          ? 'VENUE_BOOKING_REJECTED'
          : status === VenueBookingStatus.CANCELLED
            ? 'VENUE_BOOKING_CANCELLED'
            : previous
              ? 'VENUE_BOOKING_UPDATED'
              : 'VENUE_BOOKING_CREATED';
    const isReviewed =
      status === VenueBookingStatus.APPROVED || status === VenueBookingStatus.REJECTED;
    await this.repository.saveBooking(transaction, {
      eventId: input.eventId,
      venueId: input.venueId,
      requestedById: input.requestedById,
      startAt: input.startAt,
      endAt: input.endAt,
      status,
      reviewedById: isReviewed ? input.actorId : null,
      reviewedAt: isReviewed ? new Date() : null,
      actorId: input.actorId,
      action,
    });
  }

  async lockVenueForEventWrite(
    transaction: BookingTransaction,
    venueId: string,
    requireActive: boolean,
  ): Promise<void> {
    const venue = await this.repository.lockAndFindVenue(transaction, venueId);
    if (requireActive && (!venue || !venue.isActive || venue.deletedAt)) {
      throw new NotFoundException('Venue not found.');
    }
  }

  async assertSeriesAvailability(
    transaction: BookingTransaction,
    input: VenueConflictInput,
    occurrences: EventOccurrence[],
  ): Promise<void> {
    await this.assertAvailability(transaction, input, occurrences, true);
  }

  getOccurrences(input: VenueConflictInput): EventOccurrence[] {
    if (!input.recurrence) {
      if (input.endAt <= input.startAt) {
        throw new BadRequestException('endAt must be later than startAt.');
      }
      return [{ occurrenceIndex: 0, startAt: input.startAt, endAt: input.endAt }];
    }
    try {
      return generateOccurrences(
        input.startAt,
        input.endAt,
        input.recurrence,
        input.exceptionDates ?? [],
        this.campusTimeZone,
      );
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private async assertAvailability(
    transaction: BookingTransaction,
    input: VenueConflictInput,
    occurrences: EventOccurrence[],
    lock: boolean,
  ): Promise<BookingVenueRecord> {
    const venue = lock
      ? await this.repository.lockAndFindVenue(transaction, input.venueId)
      : await this.repository.findVenue(transaction, input.venueId);
    if (!venue || !venue.isActive || venue.deletedAt) {
      throw new NotFoundException('Venue not found.');
    }

    const reasons = new Set<string>();
    const conflicts: ConflictingSlot[] = [];
    const now = Date.now();

    if (input.expectedAttendance > venue.capacity) {
      reasons.add('CAPACITY');
    }

    for (const occurrence of occurrences) {
      if (occurrence.startAt.getTime() <= now) {
        reasons.add('PAST_START');
      }
      if (
        !isWithinAvailability(
          occurrence.startAt,
          occurrence.endAt,
          venue.availability,
          this.campusTimeZone,
        )
      ) {
        reasons.add('OUTSIDE_HOURS');
      }
      conflicts.push(
        ...(await this.repository.findConflicts(
          transaction,
          venue.id,
          occurrence,
          venue.bufferMinutes,
          input.eventId,
        )),
      );
    }

    occurrences.forEach((leftOccurrence, leftIndex) => {
      occurrences.slice(leftIndex + 1).forEach((rightOccurrence) => {
        if (
          intervalsConflict(
            leftOccurrence.startAt,
            leftOccurrence.endAt,
            rightOccurrence.startAt,
            rightOccurrence.endAt,
            venue.bufferMinutes,
          )
        ) {
          conflicts.push(leftOccurrence, rightOccurrence);
        }
      });
    });

    if (conflicts.length > 0) {
      reasons.add('BOOKING_CONFLICT');
    }
    if (reasons.size > 0) {
      const uniqueConflicts = uniqueSlots(conflicts);
      const alternatives = await this.findAlternatives(
        transaction,
        venue,
        occurrences[0]!,
        input.expectedAttendance,
        input.eventId,
      );
      throw new VenueConflictException({
        statusCode: 409,
        message: 'The venue is not available for the requested time.',
        reasons: [...reasons].sort(),
        conflicts: uniqueConflicts,
        alternatives,
      } satisfies VenueConflictResponse);
    }
    return venue;
  }

  private async findAlternatives(
    transaction: BookingTransaction,
    venue: BookingVenueRecord,
    requestedSlot: BookingSlot,
    expectedAttendance: number,
    excludeEventId?: string,
  ): Promise<VenueAlternative[]> {
    const alternatives: VenueAlternative[] = [];
    if (requestedSlot.startAt.getTime() > Date.now()) {
      const otherVenues = await this.repository.listActiveVenues(transaction);
      for (const candidate of otherVenues) {
        if (candidate.id === venue.id || candidate.capacity < expectedAttendance) {
          continue;
        }
        if (
          !isWithinAvailability(
            requestedSlot.startAt,
            requestedSlot.endAt,
            candidate.availability,
            this.campusTimeZone,
          )
        ) {
          continue;
        }
        const conflicts = await this.repository.findConflicts(
          transaction,
          candidate.id,
          requestedSlot,
          candidate.bufferMinutes,
          excludeEventId,
        );
        if (conflicts.length === 0) {
          alternatives.push(toAlternative(candidate, requestedSlot));
          if (alternatives.length === MAX_ALTERNATIVES) {
            return alternatives;
          }
        }
      }
    }

    const durationMs = requestedSlot.endAt.getTime() - requestedSlot.startAt.getTime();
    const horizonStart = Math.max(requestedSlot.startAt.getTime(), Date.now());
    const firstCandidate = Math.ceil(horizonStart / ALTERNATIVE_STEP_MS) * ALTERNATIVE_STEP_MS;
    const horizonEnd = requestedSlot.startAt.getTime() + ALTERNATIVE_HORIZON_DAYS * 86_400_000;
    const existingBookings =
      venue.capacity >= expectedAttendance
        ? await this.repository.listVenueBookings(
            transaction,
            venue.id,
            new Date(firstCandidate),
            new Date(horizonEnd),
            venue.bufferMinutes,
          )
        : [];
    for (
      let candidateStart = firstCandidate;
      venue.capacity >= expectedAttendance &&
      candidateStart + durationMs <= horizonEnd &&
      alternatives.length < MAX_ALTERNATIVES;
      candidateStart += ALTERNATIVE_STEP_MS
    ) {
      const startAt = new Date(candidateStart);
      const endAt = new Date(candidateStart + durationMs);
      if (
        !isWithinAvailability(startAt, endAt, venue.availability, this.campusTimeZone) ||
        existingBookings.some((booking) =>
          intervalsConflict(startAt, endAt, booking.startAt, booking.endAt, venue.bufferMinutes),
        )
      ) {
        continue;
      }
      alternatives.push(toAlternative(venue, { startAt, endAt }));
    }
    return alternatives;
  }
}

function statusForEvent(status: EventStatus): VenueBookingStatus {
  switch (status) {
    case EventStatus.APPROVED:
      return VenueBookingStatus.APPROVED;
    case EventStatus.REJECTED:
      return VenueBookingStatus.REJECTED;
    case EventStatus.CANCELLED:
      return VenueBookingStatus.CANCELLED;
    case EventStatus.DRAFT:
    case EventStatus.PENDING_APPROVAL:
      return VenueBookingStatus.PENDING;
  }
}

function toAlternative(venue: BookingVenueRecord, slot: BookingSlot): VenueAlternative {
  return {
    venueId: venue.id,
    name: venue.name,
    building: venue.building,
    startAt: slot.startAt,
    endAt: slot.endAt,
  };
}

function uniqueSlots(slots: BookingSlot[]): BookingSlot[] {
  const seen = new Set<string>();
  return slots
    .sort((left, right) => left.startAt.getTime() - right.startAt.getTime())
    .filter((slot) => {
      const key = `${slot.startAt.toISOString()}|${slot.endAt.toISOString()}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map(({ startAt, endAt }) => ({ startAt, endAt }));
}
