import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CheckInMethod,
  EventStatus,
  RsvpStatus,
  TicketStatus,
  type Prisma,
} from '../../generated/prisma/client';
import type { AuthPrincipal } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';
import {
  CheckinManifestQueryDto,
  MAX_CHECKIN_MANIFEST_PAGE_SIZE,
} from './dto/checkin-manifest-query.dto';
import type { CheckinTicketDto } from './dto/checkin-ticket.dto';
import {
  ManualCheckinLookupDto,
  MAX_MANUAL_CHECKIN_PAGE_SIZE,
} from './dto/manual-checkin-lookup.dto';
import type { ManualCheckinDto } from './dto/manual-checkin.dto';
import type { OfflineCheckinDto } from './dto/sync-checkins.dto';
import { TicketSigningService, type TicketClaims } from './ticket-signing.service';
import {
  EVENT_DASHBOARD_PUBLISHER,
  type EventDashboardPublisher,
} from '../realtime/event-dashboard.types';

const ticketWithRsvp = {
  rsvp: {
    select: {
      id: true,
      eventId: true,
      status: true,
      userId: true,
      event: {
        select: {
          id: true,
          endAt: true,
          isPublic: true,
          status: true,
          deletedAt: true,
        },
      },
    },
  },
} satisfies Prisma.TicketInclude;

type TicketWithRsvp = Prisma.TicketGetPayload<{ include: typeof ticketWithRsvp }>;
type AuthorizedEvent = { id: string; endAt: Date };
type CheckinResult = {
  ticketIdHash: string;
  status: 'VALID' | 'DUPLICATE' | 'INVALID' | 'WRONG_EVENT';
  checkedInAt?: Date;
};

@Injectable()
export class CheckinsRepository {
  private readonly logger = new Logger(CheckinsRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ticketSigning: TicketSigningService,
    @Inject(EVENT_DASHBOARD_PUBLISHER)
    private readonly dashboard: EventDashboardPublisher,
  ) {}

  async getManifest(eventId: string, actor: AuthPrincipal, query: CheckinManifestQueryDto) {
    const limit = Math.min(query.limit, MAX_CHECKIN_MANIFEST_PAGE_SIZE);
    return this.prisma.$transaction(async (tx) => {
      const event = await this.authorizeEvent(tx, eventId, actor);
      const tickets = await tx.ticket.findMany({
        where: { rsvp: { is: { eventId } }, ...(query.cursor ? { id: { gt: query.cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: limit + 1,
        select: { id: true, ticketIdHash: true, status: true },
      });
      const hasMore = tickets.length > limit;
      const page = tickets.slice(0, limit);
      const nextCursor = hasMore ? page.at(-1)?.id : undefined;
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: 'CHECKIN_MANIFEST_DOWNLOADED',
          entityType: 'Event',
          entityId: eventId,
          metadata: { limit, hasMore },
        },
      });

      return {
        eventId,
        eventEndAt: event.endAt,
        publicKeys: this.ticketSigning.publicKeySet(),
        data: page.map((ticket) => ({
          ticketIdHash: ticket.ticketIdHash,
          status: ticket.status,
        })),
        ...(nextCursor ? { nextCursor } : {}),
      };
    });
  }

  async checkIn(eventId: string, actor: AuthPrincipal, dto: CheckinTicketDto) {
    let claims: TicketClaims;
    try {
      claims = this.ticketSigning.verify(dto.ticket);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw new NotFoundException('Event not found.');
      }
      throw error;
    }
    if (claims.eventId !== eventId) {
      throw new NotFoundException('Event not found.');
    }
    const ticketIdHash = TicketSigningService.hashTicketId(claims.ticketId);

    const result = await this.prisma.$transaction(async (tx) => {
      await this.authorizeEvent(tx, eventId, actor);
      const ticket = await tx.ticket.findUnique({
        where: { ticketIdHash },
        include: { ...ticketWithRsvp, checkIn: { select: { checkedInAt: true } } },
      });
      if (!this.isValidTicket(ticket, eventId, claims)) {
        throw new NotFoundException('Event not found.');
      }
      if (ticket.status === TicketStatus.USED) {
        const checkedInAt = await this.findCheckedInAt(tx, ticket.id);
        if (!checkedInAt) {
          throw new NotFoundException('Event not found.');
        }
        await tx.auditLog.create({
          data: {
            actorId: actor.id,
            action: 'CHECKIN_QR_DUPLICATE',
            entityType: 'Ticket',
            entityId: ticket.id,
            metadata: { method: CheckInMethod.QR, deviceId: dto.deviceId, result: 'ALREADY_USED' },
          },
        });
        return { status: 'ALREADY_USED' as const, checkedInAt };
      }

      const checkedInAt = await this.consumeTicket(
        tx,
        ticket,
        actor.id,
        CheckInMethod.QR,
        dto.deviceId,
        new Date(),
      );
      return { status: 'VALID' as const, checkedInAt };
    });
    if (result.status === 'VALID') {
      await this.publishDashboardUpdate(eventId);
    }
    return result;
  }

  async syncCheckins(
    eventId: string,
    actor: AuthPrincipal,
    scans: OfflineCheckinDto[],
  ): Promise<{ data: CheckinResult[] }> {
    const result = await this.prisma.$transaction(async (tx) => {
      await this.authorizeEvent(tx, eventId, actor);
      const data: CheckinResult[] = [];
      for (const scan of scans) {
        data.push(await this.syncOne(tx, eventId, actor.id, scan));
      }
      return { data };
    });
    if (result.data.some((item) => item.status === 'VALID')) {
      await this.publishDashboardUpdate(eventId);
    }
    return result;
  }

  async lookup(eventId: string, actor: AuthPrincipal, query: ManualCheckinLookupDto) {
    const page = query.page;
    const limit = Math.min(query.limit, MAX_MANUAL_CHECKIN_PAGE_SIZE);
    return this.prisma.$transaction(async (tx) => {
      await this.authorizeEvent(tx, eventId, actor);
      const where: Prisma.RsvpWhereInput = {
        eventId,
        status: { in: [RsvpStatus.GOING, RsvpStatus.CHECKED_IN] },
        user: {
          is: {
            OR: [
              { firstName: { contains: query.q, mode: 'insensitive' } },
              { lastName: { contains: query.q, mode: 'insensitive' } },
              {
                AND: [
                  { firstName: { contains: query.q.split(/\s+/)[0], mode: 'insensitive' } },
                  {
                    lastName: {
                      contains: query.q.split(/\s+/).slice(1).join(' '),
                      mode: 'insensitive',
                    },
                  },
                ],
              },
            ],
          },
        },
      };
      const [total, rsvps] = await Promise.all([
        tx.rsvp.count({ where }),
        tx.rsvp.findMany({
          where,
          orderBy: [{ user: { lastName: 'asc' } }, { user: { firstName: 'asc' } }, { id: 'asc' }],
          skip: (page - 1) * limit,
          take: limit,
          select: {
            id: true,
            status: true,
            checkedInAt: true,
            user: { select: { firstName: true, lastName: true } },
          },
        }),
      ]);
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: 'CHECKIN_ATTENDEE_LOOKUP',
          entityType: 'Event',
          entityId: eventId,
          metadata: { page, limit, resultCount: rsvps.length },
        },
      });
      return {
        data: rsvps.map((rsvp) => ({
          rsvpId: rsvp.id,
          displayName: `${rsvp.user.firstName} ${rsvp.user.lastName}`.trim(),
          status: rsvp.status,
          checkedInAt: rsvp.checkedInAt,
        })),
        page,
        limit,
        total,
      };
    });
  }

  async manualCheckIn(eventId: string, actor: AuthPrincipal, dto: ManualCheckinDto) {
    const result = await this.prisma.$transaction(async (tx) => {
      await this.authorizeEvent(tx, eventId, actor);
      const rsvp = await tx.rsvp.findFirst({
        where: { id: dto.rsvpId, eventId, status: RsvpStatus.GOING },
        select: { id: true, ticket: { select: { id: true, status: true, expiresAt: true } } },
      });
      if (
        !rsvp?.ticket ||
        rsvp.ticket.status !== TicketStatus.ISSUED ||
        rsvp.ticket.expiresAt <= new Date()
      ) {
        throw new NotFoundException('Event not found.');
      }
      return {
        status: 'VALID' as const,
        checkedInAt: await this.consumeTicket(
          tx,
          { id: rsvp.ticket.id, rsvpId: rsvp.id },
          actor.id,
          CheckInMethod.MANUAL,
          dto.deviceId,
          new Date(),
        ),
      };
    });
    await this.publishDashboardUpdate(eventId);
    return result;
  }

  private async publishDashboardUpdate(eventId: string): Promise<void> {
    try {
      await this.dashboard.publishCheckIn(eventId);
    } catch {
      this.logger.error('A committed check-in dashboard update could not be published.');
    }
  }

  private async syncOne(
    tx: Prisma.TransactionClient,
    eventId: string,
    actorId: string,
    scan: OfflineCheckinDto,
  ): Promise<CheckinResult> {
    const ticket = await tx.ticket.findUnique({
      where: { ticketIdHash: scan.ticketIdHash.toLowerCase() },
      include: ticketWithRsvp,
    });
    let result: CheckinResult;
    if (!ticket) {
      result = { ticketIdHash: scan.ticketIdHash, status: 'INVALID' };
    } else if (ticket.rsvp.eventId !== eventId) {
      result = { ticketIdHash: scan.ticketIdHash, status: 'WRONG_EVENT' };
    } else if (
      ticket.status === TicketStatus.REVOKED ||
      ticket.rsvp.status === RsvpStatus.CANCELLED ||
      ticket.rsvp.status === RsvpStatus.WAITLISTED ||
      !ticket.rsvp.event.isPublic ||
      ticket.rsvp.event.deletedAt ||
      ticket.rsvp.event.status !== EventStatus.APPROVED ||
      new Date(scan.scannedAt) > ticket.expiresAt ||
      new Date(scan.scannedAt).getTime() > Date.now() + 60_000
    ) {
      result = { ticketIdHash: scan.ticketIdHash, status: 'INVALID' };
    } else if (ticket.status === TicketStatus.USED) {
      const checkedInAt = await this.findCheckedInAt(tx, ticket.id);
      result = checkedInAt
        ? { ticketIdHash: scan.ticketIdHash, status: 'DUPLICATE', checkedInAt }
        : { ticketIdHash: scan.ticketIdHash, status: 'INVALID' };
    } else if (ticket.rsvp.status !== RsvpStatus.GOING) {
      result = { ticketIdHash: scan.ticketIdHash, status: 'INVALID' };
    } else {
      const checkedInAt = await this.consumeTicket(
        tx,
        ticket,
        actorId,
        CheckInMethod.QR,
        scan.deviceId,
        new Date(scan.scannedAt),
      );
      result = { ticketIdHash: scan.ticketIdHash, status: 'VALID', checkedInAt };
    }

    await tx.auditLog.create({
      data: {
        actorId,
        action: 'CHECKIN_OFFLINE_SCAN_SYNCED',
        entityType: 'Event',
        entityId: eventId,
        ...(ticket
          ? { metadata: { ticketId: ticket.id, deviceId: scan.deviceId, result: result.status } }
          : { metadata: { deviceId: scan.deviceId, result: result.status } }),
      },
    });
    return result;
  }

  private async consumeTicket(
    tx: Prisma.TransactionClient,
    ticket: { id: string; rsvpId: string },
    actorId: string,
    method: CheckInMethod,
    deviceId: string,
    scannedAt: Date,
  ): Promise<Date> {
    const checkedInAt = new Date();
    const changed = await tx.ticket.updateMany({
      where: { id: ticket.id, status: TicketStatus.ISSUED },
      data: { status: TicketStatus.USED },
    });
    if (changed.count !== 1) {
      const existing = await this.findCheckedInAt(tx, ticket.id);
      if (existing) {
        return existing;
      }
      throw new NotFoundException('Event not found.');
    }
    const changedRsvp = await tx.rsvp.updateMany({
      where: { id: ticket.rsvpId, status: RsvpStatus.GOING },
      data: { status: RsvpStatus.CHECKED_IN, checkedInAt },
    });
    if (changedRsvp.count !== 1) {
      throw new NotFoundException('Event not found.');
    }
    await tx.checkIn.create({
      data: {
        ticketId: ticket.id,
        checkedInById: actorId,
        method,
        deviceId,
        scannedAt,
        checkedInAt,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: method === CheckInMethod.QR ? 'CHECKIN_QR' : 'CHECKIN_MANUAL',
        entityType: 'Ticket',
        entityId: ticket.id,
        metadata: { method, deviceId, scannedAt: scannedAt.toISOString() },
      },
    });
    return checkedInAt;
  }

  private async findCheckedInAt(
    tx: Prisma.TransactionClient,
    ticketId: string,
  ): Promise<Date | null> {
    const record = await tx.checkIn.findUnique({
      where: { ticketId },
      select: { checkedInAt: true },
    });
    return record?.checkedInAt ?? null;
  }

  private isValidTicket(
    ticket: TicketWithRsvp | null,
    eventId: string,
    claims: TicketClaims,
  ): ticket is TicketWithRsvp {
    return Boolean(
      ticket &&
      ticket.id === claims.ticketId &&
      ticket.rsvp.id === claims.rsvpId &&
      ticket.rsvp.eventId === eventId &&
      ticket.status !== TicketStatus.REVOKED &&
      (ticket.status === TicketStatus.USED
        ? ticket.rsvp.status === RsvpStatus.CHECKED_IN
        : ticket.rsvp.status === RsvpStatus.GOING) &&
      ticket.rsvp.event.isPublic &&
      !ticket.rsvp.event.deletedAt &&
      ticket.rsvp.event.status === EventStatus.APPROVED &&
      ticket.expiresAt.getTime() === claims.expiresAt,
    );
  }

  private async authorizeEvent(
    tx: Prisma.TransactionClient,
    eventId: string,
    actor: AuthPrincipal,
  ): Promise<AuthorizedEvent> {
    if (actor.role !== 'ADMIN' && actor.role !== 'ORGANIZER') {
      throw new NotFoundException('Event not found.');
    }
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "events" WHERE "id" = ${eventId}::uuid FOR UPDATE
    `;
    const event = await tx.event.findFirst({
      where: {
        id: eventId,
        deletedAt: null,
        isPublic: true,
        status: EventStatus.APPROVED,
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
      select: { id: true, endAt: true },
    });
    if (!event) {
      throw new NotFoundException('Event not found.');
    }
    return event;
  }
}
