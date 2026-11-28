import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ClubVerificationStatus,
  EventStatus,
  NotificationType,
  RsvpStatus,
  TicketStatus,
  type Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { toEventResponseDto } from '../events/event-response.dto';
import type { AuthPrincipal } from '../auth/auth.types';
import { TicketSigningService } from './ticket-signing.service';
import {
  cancelPendingRsvpReminders,
  enqueueNotifications,
  scheduleRsvpReminders,
} from '../notifications/notification-outbox';
import {
  MAX_ATTENDEE_PAGE_SIZE,
  type EventAttendeeDto,
  type ListEventAttendeesDto,
} from './dto/list-event-attendees.dto';

type LockedUser = { id: string; role: string; is_active: boolean; deleted_at: Date | null };

const myRsvpEventInclude = {
  club: { select: { name: true, slug: true, verificationStatus: true } },
  category: { select: { name: true, slug: true } },
  venue: { select: { id: true, name: true, building: true } },
} satisfies Prisma.EventInclude;

const visibleRsvpEventSelect = {
  id: true,
  title: true,
  status: true,
  startAt: true,
  endAt: true,
  capacity: true,
  isPublic: true,
} satisfies Prisma.EventSelect;

const eventAttendeeSelect = {
  status: true,
  waitlistPosition: true,
  user: { select: { firstName: true, lastName: true } },
} satisfies Prisma.RsvpSelect;

type EventAttendeeRecord = Prisma.RsvpGetPayload<{ select: typeof eventAttendeeSelect }>;

@Injectable()
export class RsvpsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ticketSigning: TicketSigningService,
  ) {}

  async listMine(userId: string) {
    const rsvps = await this.prisma.rsvp.findMany({
      where: {
        userId,
        status: { in: [RsvpStatus.GOING, RsvpStatus.WAITLISTED] },
        event: {
          deletedAt: null,
          club: { verificationStatus: { not: ClubVerificationStatus.SUSPENDED } },
        },
      },
      orderBy: [{ event: { startAt: 'asc' } }, { createdAt: 'asc' }],
      include: {
        event: { include: myRsvpEventInclude },
        ticket: { select: { status: true, expiresAt: true } },
      },
    });

    return {
      data: rsvps.map((rsvp) => ({
        id: rsvp.id,
        status: rsvp.status,
        waitlistPosition: rsvp.waitlistPosition,
        createdAt: rsvp.createdAt,
        event: toEventResponseDto(rsvp.event),
        ticket: rsvp.ticket
          ? {
              status: rsvp.ticket.status,
              expiresAt: rsvp.ticket.expiresAt,
            }
          : null,
      })),
    };
  }

  async listEventAttendees(eventId: string, actor: AuthPrincipal, query: ListEventAttendeesDto) {
    const page = query.page ?? 1;
    const limit = Math.max(1, Math.min(query.limit ?? 20, MAX_ATTENDEE_PAGE_SIZE));

    return this.prisma.$transaction(async (tx) => {
      const event = await tx.event.findFirst({
        where: {
          id: eventId,
          deletedAt: null,
          ...(actor.role === 'ADMIN'
            ? {}
            : {
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
              }),
        },
        select: { id: true },
      });
      if (!event || (actor.role !== 'ADMIN' && actor.role !== 'ORGANIZER')) {
        throw new NotFoundException('Event not found.');
      }

      const canViewCancelled = actor.role === 'ADMIN' && query.status === RsvpStatus.CANCELLED;
      const filterCancelledOnly = query.status === RsvpStatus.CANCELLED && actor.role !== 'ADMIN';
      const where: Prisma.RsvpWhereInput = {
        eventId,
        ...(filterCancelledOnly
          ? { status: { in: [] } }
          : query.status
            ? { status: query.status }
            : { status: { in: [RsvpStatus.GOING, RsvpStatus.WAITLISTED, RsvpStatus.CHECKED_IN] } }),
      };

      let total = 0;
      let rsvps: EventAttendeeRecord[] = [];
      if (!filterCancelledOnly) {
        [total, rsvps] = await Promise.all([
          tx.rsvp.count({ where }),
          tx.rsvp.findMany({
            where,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            skip: (page - 1) * limit,
            take: limit,
            select: eventAttendeeSelect,
          }),
        ]);
      }

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: 'EVENT_ATTENDEES_VIEWED',
          entityType: 'Event',
          entityId: eventId,
          metadata: {
            page,
            limit,
            ...(query.status ? { status: query.status } : {}),
            includeCancelled: canViewCancelled,
          },
        },
      });

      const data: EventAttendeeDto[] = rsvps.map((rsvp) => ({
        displayName: `${rsvp.user.firstName} ${rsvp.user.lastName}`.trim(),
        status: rsvp.status,
        waitlistPosition: rsvp.waitlistPosition,
      }));

      return { data, page, limit, total };
    });
  }

  async getStatus(eventId: string, userId: string) {
    const event = await this.prisma.event.findFirst({
      where: this.visibleRsvpEventWhere(eventId, userId),
      select: visibleRsvpEventSelect,
    });
    if (!event) {
      throw new NotFoundException('Event not found.');
    }
    this.assertRsvpOpen(event.startAt, event.endAt);

    const [goingCount, rsvp] = await Promise.all([
      this.prisma.rsvp.count({
        where: {
          eventId,
          status: { in: [RsvpStatus.GOING, RsvpStatus.CHECKED_IN] },
        },
      }),
      this.prisma.rsvp.findUnique({
        where: { eventId_userId: { eventId, userId } },
        select: { status: true, waitlistPosition: true },
      }),
    ]);

    return {
      status: rsvp?.status ?? null,
      waitlistPosition: rsvp?.waitlistPosition ?? null,
      capacity: event.capacity,
      goingCount,
      isFull: event.capacity !== null && goingCount >= event.capacity,
    };
  }

  async rsvp(eventId: string, userId: string, checkConflicts: boolean) {
    return this.prisma.$transaction(
      async (tx) => {
        const users = await tx.$queryRaw<LockedUser[]>`
        SELECT "id", "role", "is_active", "deleted_at"
        FROM "users"
        WHERE "id" = ${userId}::uuid
        FOR UPDATE
      `;
        const user = users[0];
        if (!user || !user.is_active || user.deleted_at !== null) {
          throw new ForbiddenException('An active student account is required.');
        }
        if (user.role !== 'STUDENT') {
          throw new ForbiddenException('Only students can RSVP.');
        }

        const event = await this.lockVisibleEvent(tx, eventId, userId);
        this.assertRsvpOpen(event.startAt, event.endAt);

        const existing = await tx.rsvp.findUnique({
          where: { eventId_userId: { eventId, userId } },
        });
        if (existing && existing.status !== RsvpStatus.CANCELLED) {
          throw new ConflictException('You already have an RSVP for this event.');
        }

        if (checkConflicts) {
          const conflict = await tx.rsvp.findFirst({
            where: {
              userId,
              eventId: { not: eventId },
              status: { in: [RsvpStatus.GOING, RsvpStatus.CHECKED_IN] },
              event: {
                is: {
                  status: EventStatus.APPROVED,
                  deletedAt: null,
                  startAt: { lt: event.endAt },
                  endAt: { gt: event.startAt },
                },
              },
            },
            select: { id: true },
          });
          if (conflict) {
            throw new ConflictException('This event overlaps another event you are attending.');
          }
        }

        const goingCount = await tx.rsvp.count({
          where: {
            eventId,
            status: { in: [RsvpStatus.GOING, RsvpStatus.CHECKED_IN] },
          },
        });
        const waitlistedCount = await tx.rsvp.count({
          where: { eventId, status: RsvpStatus.WAITLISTED },
        });
        const going =
          event.capacity === null || (goingCount < event.capacity && waitlistedCount === 0);
        const waitlistPosition = going ? null : await this.nextWaitlistPosition(tx, eventId);
        const status = going ? RsvpStatus.GOING : RsvpStatus.WAITLISTED;
        const rsvp = existing
          ? await tx.rsvp.update({
              where: { id: existing.id },
              data: { status, waitlistPosition, checkedInAt: null },
            })
          : await tx.rsvp.create({
              data: { eventId, userId, status, waitlistPosition },
            });

        const ticketToken = going
          ? await this.issueTicketInTransaction(tx, rsvp.id, event.id, event.endAt)
          : null;
        const notificationType = going
          ? NotificationType.RSVP_CONFIRMED
          : NotificationType.WAITLISTED;
        await enqueueNotifications(tx, [
          {
            userId,
            eventId,
            type: notificationType,
            title: going ? 'RSVP confirmed' : 'Added to waitlist',
            body: going
              ? `Your RSVP for ${event.title} is confirmed.`
              : `You are on the waitlist for ${event.title}.`,
            dedupeKey: `rsvp:${rsvp.id}:${notificationType}:${Date.now()}`,
          },
        ]);
        if (going) {
          await scheduleRsvpReminders(tx, {
            userId,
            eventId,
            rsvpId: rsvp.id,
            eventTitle: event.title,
            startAt: event.startAt,
          });
        }

        return {
          id: rsvp.id,
          eventId,
          status: rsvp.status,
          waitlistPosition: rsvp.waitlistPosition,
          ...(ticketToken ? { ticketToken } : {}),
        };
      },
      { maxWait: 30_000, timeout: 30_000 },
    );
  }

  async cancel(eventId: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      const event = await this.lockVisibleEvent(tx, eventId, userId);
      this.assertBeforeEventStart(event.startAt);

      const rsvp = await tx.rsvp.findUnique({
        where: { eventId_userId: { eventId, userId } },
        include: { ticket: true },
      });
      if (!rsvp || rsvp.status === RsvpStatus.CANCELLED) {
        throw new NotFoundException('RSVP not found.');
      }
      if (rsvp.status === RsvpStatus.CHECKED_IN) {
        throw new ConflictException('A checked-in RSVP cannot be cancelled.');
      }
      this.assertBeforeEventStart(event.startAt);

      await tx.rsvp.update({
        where: { id: rsvp.id },
        data: { status: RsvpStatus.CANCELLED, waitlistPosition: null },
      });
      await cancelPendingRsvpReminders(tx, eventId, userId);
      await enqueueNotifications(tx, [
        {
          userId,
          eventId,
          type: NotificationType.RSVP_CANCELLED,
          title: 'RSVP cancelled',
          body: `Your RSVP for ${event.title} has been cancelled.`,
          dedupeKey: `rsvp-cancelled:${rsvp.id}:${Date.now()}`,
        },
      ]);
      if (rsvp.ticket && rsvp.ticket.status !== TicketStatus.REVOKED) {
        await tx.ticket.update({
          where: { id: rsvp.ticket.id },
          data: { status: TicketStatus.REVOKED, revokedAt: new Date() },
        });
      }

      const promoteWaitlist =
        rsvp.status === RsvpStatus.GOING && event.endAt > new Date() && event.capacity !== null;
      if (promoteWaitlist) {
        await tx.rsvpPromotionOutbox.create({ data: { eventId } });
      }

      return { id: rsvp.id, eventId, status: RsvpStatus.CANCELLED };
    });
  }

  async issueTicket(eventId: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockEvent(tx, eventId);
      const event = await tx.event.findUnique({ where: { id: eventId } });
      if (!event || event.deletedAt || !event.isPublic) {
        throw new NotFoundException('Event not found.');
      }
      if (event.status !== EventStatus.APPROVED) {
        throw new NotFoundException('Event not found.');
      }
      if (TicketSigningService.expiresAt(event.endAt) <= new Date()) {
        throw new ConflictException('A ticket is not available for this event.');
      }

      const rsvp = await tx.rsvp.findUnique({
        where: { eventId_userId: { eventId, userId } },
        include: { ticket: true },
      });
      if (!rsvp || rsvp.status !== RsvpStatus.GOING) {
        throw new NotFoundException('Event not found.');
      }
      if (rsvp.ticket?.status === TicketStatus.USED) {
        throw new ConflictException('This ticket has already been used.');
      }

      const token = await this.issueTicketInTransaction(tx, rsvp.id, event.id, event.endAt);
      return {
        eventId,
        rsvpId: rsvp.id,
        token,
        expiresAt: TicketSigningService.expiresAt(event.endAt),
      };
    });
  }

  async promoteNextWaitlisted(eventId: string, outboxId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockEvent(tx, eventId);
      const outboxRecords = await tx.$queryRaw<
        Array<{ id: string; event_id: string; processed_at: Date | null }>
      >`
        SELECT "id", "event_id", "processed_at"
        FROM "rsvp_promotion_outbox"
        WHERE "id" = ${outboxId}::uuid
        FOR UPDATE
      `;
      const outbox = outboxRecords[0];
      if (!outbox || outbox.processed_at) {
        return;
      }
      if (outbox.event_id !== eventId) {
        throw new Error('RSVP promotion job does not match its outbox record.');
      }

      const event = await tx.event.findUnique({ where: { id: eventId } });
      if (
        !event ||
        event.deletedAt ||
        !event.isPublic ||
        event.status !== EventStatus.APPROVED ||
        event.startAt <= new Date() ||
        event.endAt <= new Date() ||
        event.capacity === null
      ) {
        await this.markPromotionProcessed(tx, outboxId);
        return;
      }

      const goingCount = await tx.rsvp.count({
        where: {
          eventId,
          status: { in: [RsvpStatus.GOING, RsvpStatus.CHECKED_IN] },
        },
      });
      if (goingCount >= event.capacity) {
        await this.markPromotionProcessed(tx, outboxId);
        return;
      }

      const next = await tx.rsvp.findFirst({
        where: { eventId, status: RsvpStatus.WAITLISTED },
        orderBy: [{ waitlistPosition: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      if (!next) {
        await this.markPromotionProcessed(tx, outboxId);
        return;
      }

      await tx.rsvp.update({
        where: { id: next.id },
        data: { status: RsvpStatus.GOING, waitlistPosition: null },
      });
      await this.issueTicketInTransaction(tx, next.id, event.id, event.endAt);
      await enqueueNotifications(tx, [
        {
          userId: next.userId,
          eventId,
          type: NotificationType.RSVP_CONFIRMED,
          title: 'Waitlist spot available',
          body: `A spot opened for ${event.title}; your RSVP is confirmed.`,
          dedupeKey: `rsvp-promoted:${outboxId}`,
        },
      ]);
      await scheduleRsvpReminders(tx, {
        userId: next.userId,
        eventId,
        rsvpId: next.id,
        eventTitle: event.title,
        startAt: event.startAt,
      });
      await this.markPromotionProcessed(tx, outboxId);
    });
  }

  private async markPromotionProcessed(
    tx: Prisma.TransactionClient,
    outboxId: string,
  ): Promise<void> {
    await tx.rsvpPromotionOutbox.update({
      where: { id: outboxId },
      data: { processedAt: new Date() },
    });
  }

  private async lockEvent(tx: Prisma.TransactionClient, eventId: string): Promise<void> {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "events"
      WHERE "id" = ${eventId}::uuid
      FOR UPDATE
    `;
  }

  private async lockVisibleEvent(tx: Prisma.TransactionClient, eventId: string, userId: string) {
    let event = await tx.event.findFirst({
      where: this.visibleRsvpEventWhere(eventId, userId),
      select: visibleRsvpEventSelect,
    });
    if (!event) {
      throw new NotFoundException('Event not found.');
    }

    await this.lockEvent(tx, eventId);
    event = await tx.event.findFirst({
      where: this.visibleRsvpEventWhere(eventId, userId),
      select: visibleRsvpEventSelect,
    });
    if (!event) {
      throw new NotFoundException('Event not found.');
    }
    return event;
  }

  private visibleRsvpEventWhere(eventId: string, userId: string): Prisma.EventWhereInput {
    return {
      id: eventId,
      status: EventStatus.APPROVED,
      deletedAt: null,
      club: {
        is: { verificationStatus: { not: ClubVerificationStatus.SUSPENDED } },
      },
      OR: [
        { isPublic: true },
        {
          club: {
            is: {
              deletedAt: null,
              memberships: {
                some: {
                  userId,
                  status: 'ACTIVE',
                  user: { isActive: true, deletedAt: null },
                },
              },
            },
          },
        },
      ],
    };
  }

  private async nextWaitlistPosition(
    tx: Prisma.TransactionClient,
    eventId: string,
  ): Promise<number> {
    const aggregate = await tx.rsvp.aggregate({
      where: { eventId, status: RsvpStatus.WAITLISTED },
      _max: { waitlistPosition: true },
    });
    return (aggregate._max.waitlistPosition ?? 0) + 1;
  }

  private async issueTicketInTransaction(
    tx: Prisma.TransactionClient,
    rsvpId: string,
    eventId: string,
    eventEndAt: Date,
  ): Promise<string> {
    const expiresAt = TicketSigningService.expiresAt(eventEndAt);
    const existing = await tx.ticket.findUnique({
      where: { rsvpId },
      select: { id: true, status: true },
    });
    let ticketId: string;
    if (!existing) {
      ticketId = randomUUID();
      await tx.ticket.create({
        data: {
          id: ticketId,
          rsvpId,
          ticketIdHash: TicketSigningService.hashTicketId(ticketId),
          expiresAt,
        },
      });
    } else {
      const updated = await tx.ticket.updateMany({
        where: { id: existing.id, status: { not: TicketStatus.USED } },
        data: {
          ticketIdHash: TicketSigningService.hashTicketId(existing.id),
          expiresAt,
          status: TicketStatus.ISSUED,
          revokedAt: null,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('This ticket has already been used.');
      }
      ticketId = existing.id;
    }

    return this.ticketSigning.issue({ ticketId, eventId, rsvpId }, expiresAt);
  }

  private assertRsvpOpen(startAt: Date, endAt: Date): void {
    if (startAt <= new Date() || endAt <= new Date()) {
      throw new ConflictException('This event is no longer accepting RSVPs.');
    }
  }

  private assertBeforeEventStart(startAt: Date): void {
    if (startAt <= new Date()) {
      throw new ConflictException('RSVP cancellation is not allowed after the event starts.');
    }
  }
}
