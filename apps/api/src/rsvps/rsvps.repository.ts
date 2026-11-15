import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  EventStatus,
  NotificationType,
  RsvpStatus,
  TicketStatus,
  type Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { toEventResponseDto } from '../events/event-response.dto';

type LockedUser = { id: string; role: string; is_active: boolean; deleted_at: Date | null };

const myRsvpEventInclude = {
  club: { select: { name: true, slug: true } },
  category: { select: { name: true, slug: true } },
} satisfies Prisma.EventInclude;

@Injectable()
export class RsvpsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listMine(userId: string) {
    const rsvps = await this.prisma.rsvp.findMany({
      where: {
        userId,
        status: { in: [RsvpStatus.GOING, RsvpStatus.WAITLISTED] },
        event: { deletedAt: null },
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

  async getStatus(eventId: string, userId: string) {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        status: EventStatus.APPROVED,
        isPublic: true,
        deletedAt: null,
      },
      select: { capacity: true },
    });
    if (!event) {
      throw new NotFoundException('Event not found.');
    }

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

        await this.lockEvent(tx, eventId);
        const event = await tx.event.findUnique({ where: { id: eventId } });
        if (!event || event.deletedAt || !event.isPublic) {
          throw new NotFoundException('Event not found.');
        }
        this.assertRsvpOpen(event.status, event.startAt, event.endAt);

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
          ? await this.issueTicketInTransaction(tx, rsvp.id, event.endAt)
          : null;
        await this.createNotification(
          tx,
          userId,
          eventId,
          going ? NotificationType.RSVP_CONFIRMED : NotificationType.WAITLISTED,
          going ? 'RSVP confirmed' : 'Added to waitlist',
          going
            ? `Your RSVP for ${event.title} is confirmed.`
            : `You are on the waitlist for ${event.title}.`,
          `rsvp-${randomUUID()}`,
        );

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
      await this.lockEvent(tx, eventId);
      const event = await tx.event.findUnique({ where: { id: eventId } });
      if (!event || event.deletedAt) {
        throw new NotFoundException('Event not found.');
      }

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

      await tx.rsvp.update({
        where: { id: rsvp.id },
        data: { status: RsvpStatus.CANCELLED, waitlistPosition: null },
      });
      if (rsvp.ticket && rsvp.ticket.status !== TicketStatus.REVOKED) {
        await tx.ticket.update({
          where: { id: rsvp.ticket.id },
          data: { status: TicketStatus.REVOKED, revokedAt: new Date() },
        });
      }

      const promoteWaitlist =
        rsvp.status === RsvpStatus.GOING &&
        event.status === EventStatus.APPROVED &&
        event.startAt > new Date() &&
        event.endAt > new Date() &&
        event.capacity !== null;
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
      if (event.status !== EventStatus.APPROVED || event.endAt <= new Date()) {
        throw new ConflictException('A ticket is not available for this event.');
      }

      const rsvp = await tx.rsvp.findUnique({
        where: { eventId_userId: { eventId, userId } },
        include: { ticket: true },
      });
      if (!rsvp || rsvp.status !== RsvpStatus.GOING) {
        throw new ConflictException('Only confirmed RSVPs have tickets.');
      }
      if (rsvp.ticket?.status === TicketStatus.REDEEMED) {
        throw new ConflictException('This ticket has already been used.');
      }

      const token = await this.issueTicketInTransaction(tx, rsvp.id, event.endAt);
      return { eventId, rsvpId: rsvp.id, token, expiresAt: event.endAt };
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
      await this.issueTicketInTransaction(tx, next.id, event.endAt);
      await this.createNotification(
        tx,
        next.userId,
        eventId,
        NotificationType.RSVP_CONFIRMED,
        'Waitlist spot available',
        `A spot opened for ${event.title}; your RSVP is confirmed.`,
        `rsvp-promoted:${outboxId}`,
      );
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
    expiresAt: Date,
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await tx.ticket.upsert({
      where: { rsvpId },
      create: { rsvpId, tokenHash, expiresAt },
      update: {
        tokenHash,
        expiresAt,
        status: TicketStatus.ISSUED,
        revokedAt: null,
      },
    });
    return token;
  }

  private async createNotification(
    tx: Prisma.TransactionClient,
    userId: string,
    eventId: string,
    type: NotificationType,
    title: string,
    body: string,
    dedupeKey: string,
  ): Promise<void> {
    await tx.notification.create({
      data: { userId, eventId, type, title, body, dedupeKey },
    });
  }

  private assertRsvpOpen(status: EventStatus, startAt: Date, endAt: Date): void {
    if (status !== EventStatus.APPROVED) {
      throw new ConflictException('Only approved events can accept RSVPs.');
    }
    if (startAt <= new Date() || endAt <= new Date()) {
      throw new ConflictException('This event is no longer accepting RSVPs.');
    }
  }
}
