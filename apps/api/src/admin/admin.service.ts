import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminRoleGrantStatus,
  ClubMembershipRole,
  ClubMembershipStatus,
  ClubVerificationStatus,
  EventStatus,
  ModerationAction,
  ModerationReportStatus,
  ModerationTargetType,
  NotificationType,
  Prisma,
  RsvpStatus,
  UserRole,
} from '../../generated/prisma/client';
import { isIP } from 'node:net';
import type { AuthPrincipal } from '../auth/auth.types';
import { AuthRateLimitService } from '../auth/auth-rate-limit.service';
import { AnalyticsCacheService } from '../analytics/analytics-cache.service';
import { PrismaService } from '../database/prisma.service';
import { VenueBookingsService } from '../venues/venue-bookings.service';
import {
  buildRsvpReminderNotifications,
  cancelPendingRsvpReminders,
  enqueueNotifications,
} from '../notifications/notification-outbox';
import type { AdminAuditQueryDto, AdminPageDto } from './dto/admin-page.dto';
import type { ChangeClubVerificationDto } from './dto/change-club-verification.dto';
import type { CreateModerationReportDto } from './dto/create-moderation-report.dto';
import type { ResolveModerationReportDto } from './dto/resolve-moderation-report.dto';

const ADMIN_ROLE_GRANT_WINDOW_MS = 15 * 60_000;
const RECENT_GOOGLE_SIGN_IN_WINDOW_MS = 5 * 60_000;
const ADMIN_MUTATION_LOCK = 7_412_065_121n;

interface AuditInput {
  actorId: string;
  actorIp: string;
  action: string;
  entityType: string;
  entityId?: string;
  reason: string;
  beforeValues?: Prisma.InputJsonObject;
  afterValues?: Prisma.InputJsonObject;
}

function cleanReason(reason: string): string {
  const cleaned = reason.trim();
  if (!cleaned || cleaned.length > 1000) {
    throw new BadRequestException('A reason between 1 and 1000 characters is required.');
  }
  return cleaned;
}

function safeIpAddress(value: string): string | null {
  return isIP(value) ? value.slice(0, 45) : null;
}

function reportOpenKey(reporterId: string, targetType: ModerationTargetType, targetId: string) {
  return `${reporterId}:${targetType}:${targetId}`;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: AuthRateLimitService,
    private readonly analyticsCache: AnalyticsCacheService,
    private readonly venueBookings: VenueBookingsService,
  ) {}

  async listApprovalQueue(query: AdminPageDto) {
    const where: Prisma.EventWhereInput = {
      status: EventStatus.PENDING_APPROVAL,
      deletedAt: null,
      ...(query.search ? { title: { contains: query.search.trim(), mode: 'insensitive' } } : {}),
    };
    const [events, total] = await this.prisma.$transaction([
      this.prisma.event.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          title: true,
          status: true,
          startAt: true,
          endAt: true,
          expectedAttendance: true,
          createdAt: true,
          club: { select: { id: true, name: true } },
          createdBy: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.event.count({ where }),
    ]);
    return {
      data: events.map((event) => ({
        id: event.id,
        title: event.title,
        status: event.status,
        startAt: event.startAt,
        endAt: event.endAt,
        expectedAttendance: event.expectedAttendance,
        createdAt: event.createdAt,
        club: event.club,
        creator: {
          id: event.createdBy.id,
          displayName: `${event.createdBy.firstName} ${event.createdBy.lastName}`.trim(),
        },
      })),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async approveEvent(actor: AuthPrincipal, eventId: string, reasonInput: string, actorIp: string) {
    const reason = cleanReason(reasonInput);
    const event = await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "events"
        WHERE "id" = ${eventId}::uuid AND "deleted_at" IS NULL
        FOR UPDATE
      `;
      const current = await transaction.event.findFirst({
        where: { id: eventId, deletedAt: null },
        select: {
          id: true,
          title: true,
          status: true,
          startAt: true,
          endAt: true,
          venueId: true,
          expectedAttendance: true,
          createdById: true,
          clubId: true,
          updatedAt: true,
        },
      });
      if (!current) throw new NotFoundException('Event not found.');
      if (current.status !== EventStatus.PENDING_APPROVAL) {
        throw new ConflictException('Only pending events can be approved.');
      }
      if (current.createdById === actor.id) {
        throw new NotFoundException('Event not found.');
      }

      if (current.venueId) {
        await this.venueBookings.lockVenueForEventWrite(transaction, current.venueId, true);
      }
      const approvedAt = new Date();
      const result = await transaction.event.updateMany({
        where: {
          id: eventId,
          status: EventStatus.PENDING_APPROVAL,
          deletedAt: null,
          updatedAt: current.updatedAt,
        },
        data: {
          status: EventStatus.APPROVED,
          approvedById: actor.id,
          approvedAt,
          rejectionReason: null,
        },
      });
      if (result.count !== 1) {
        throw new ConflictException('The event changed while it was being approved.');
      }
      await this.venueBookings.syncEventBooking(transaction, {
        eventId,
        venueId: current.venueId,
        startAt: current.startAt,
        endAt: current.endAt,
        expectedAttendance: current.expectedAttendance,
        eventStatus: EventStatus.APPROVED,
        requestedById: current.createdById,
        actorId: actor.id,
      });
      const updated = await transaction.event.findUniqueOrThrow({
        where: { id: eventId },
        select: { id: true, title: true, status: true, updatedAt: true },
      });
      await this.audit(transaction, {
        actorId: actor.id,
        actorIp,
        action: 'EVENT_APPROVED',
        entityType: 'Event',
        entityId: eventId,
        reason,
        beforeValues: { status: EventStatus.PENDING_APPROVAL },
        afterValues: { status: EventStatus.APPROVED, approvedById: actor.id },
      });
      const going = await transaction.rsvp.findMany({
        where: { eventId, status: RsvpStatus.GOING },
        select: { id: true, userId: true },
      });
      await enqueueNotifications(transaction, [
        {
          userId: current.createdById,
          eventId,
          type: NotificationType.EVENT_APPROVED,
          title: 'Event approved',
          body: `Your event ${current.title} has been approved.`,
          dedupeKey: `event-approved:${eventId}:${updated.updatedAt.getTime()}`,
        },
        ...going.flatMap((rsvp) =>
          buildRsvpReminderNotifications({
            userId: rsvp.userId,
            eventId,
            rsvpId: rsvp.id,
            eventTitle: current.title,
            startAt: current.startAt,
          }),
        ),
      ]);
      return updated;
    });
    await this.analyticsCache.invalidateEvent(event.id);
    return event;
  }

  async rejectEvent(actor: AuthPrincipal, eventId: string, reasonInput: string, actorIp: string) {
    const reason = cleanReason(reasonInput);
    const rejected = await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "events"
        WHERE "id" = ${eventId}::uuid AND "deleted_at" IS NULL
        FOR UPDATE
      `;
      const current = await transaction.event.findFirst({
        where: { id: eventId, deletedAt: null },
        select: {
          id: true,
          title: true,
          status: true,
          startAt: true,
          endAt: true,
          venueId: true,
          expectedAttendance: true,
          createdById: true,
          updatedAt: true,
        },
      });
      if (!current) throw new NotFoundException('Event not found.');
      if (current.status !== EventStatus.PENDING_APPROVAL) {
        throw new ConflictException('Only pending events can be rejected.');
      }
      if (current.createdById === actor.id) {
        throw new NotFoundException('Event not found.');
      }

      const result = await transaction.event.updateMany({
        where: {
          id: eventId,
          status: EventStatus.PENDING_APPROVAL,
          deletedAt: null,
          updatedAt: current.updatedAt,
        },
        data: { status: EventStatus.REJECTED, rejectionReason: reason },
      });
      if (result.count !== 1) {
        throw new ConflictException('The event changed while it was being rejected.');
      }
      await this.venueBookings.syncEventBooking(transaction, {
        eventId,
        venueId: current.venueId,
        startAt: current.startAt,
        endAt: current.endAt,
        expectedAttendance: current.expectedAttendance,
        eventStatus: EventStatus.REJECTED,
        requestedById: current.createdById,
        actorId: actor.id,
      });
      const updated = await transaction.event.findUniqueOrThrow({
        where: { id: eventId },
        select: { id: true, title: true, status: true },
      });
      await this.audit(transaction, {
        actorId: actor.id,
        actorIp,
        action: 'EVENT_REJECTED',
        entityType: 'Event',
        entityId: eventId,
        reason,
        beforeValues: { status: EventStatus.PENDING_APPROVAL },
        afterValues: { status: EventStatus.REJECTED, rejectionReason: reason },
      });
      await enqueueNotifications(transaction, [
        {
          userId: current.createdById,
          eventId,
          type: NotificationType.EVENT_REJECTED,
          title: 'Event not approved',
          body: `Your event ${current.title} was not approved.`,
          dedupeKey: `event-rejected:${eventId}:${updated.status}:${Date.now()}`,
        },
      ]);
      return updated;
    });
    await this.analyticsCache.invalidateEvent(rejected.id);
    return rejected;
  }

  async listClubs(query: AdminPageDto) {
    const where: Prisma.ClubWhereInput = {
      deletedAt: null,
      ...(query.search ? { name: { contains: query.search.trim(), mode: 'insensitive' } } : {}),
    };
    const [clubs, total] = await this.prisma.$transaction([
      this.prisma.club.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          name: true,
          slug: true,
          verificationStatus: true,
          verificationReason: true,
          suspendedAt: true,
          createdAt: true,
        },
      }),
      this.prisma.club.count({ where }),
    ]);
    return {
      data: clubs,
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async changeClubVerification(
    actor: AuthPrincipal,
    clubId: string,
    dto: ChangeClubVerificationDto,
    actorIp: string,
  ) {
    const reason = cleanReason(dto.reason);
    const updated = await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "clubs" WHERE "id" = ${clubId}::uuid AND "deleted_at" IS NULL FOR UPDATE
      `;
      const current = await transaction.club.findFirst({
        where: { id: clubId, deletedAt: null },
        select: {
          id: true,
          verificationStatus: true,
          verificationReason: true,
          suspendedAt: true,
        },
      });
      if (!current) throw new NotFoundException('Club not found.');
      const suspendedAt = dto.status === ClubVerificationStatus.SUSPENDED ? new Date() : null;
      const updated = await transaction.club.update({
        where: { id: clubId },
        data: {
          verificationStatus: dto.status,
          verificationReason: reason,
          suspendedAt,
        },
        select: {
          id: true,
          name: true,
          verificationStatus: true,
          verificationReason: true,
          suspendedAt: true,
        },
      });
      await this.audit(transaction, {
        actorId: actor.id,
        actorIp,
        action: 'CLUB_VERIFICATION_CHANGED',
        entityType: 'Club',
        entityId: clubId,
        reason,
        beforeValues: {
          verificationStatus: current.verificationStatus,
          verificationReason: current.verificationReason,
          suspendedAt: current.suspendedAt?.toISOString() ?? null,
        },
        afterValues: {
          verificationStatus: updated.verificationStatus,
          verificationReason: updated.verificationReason,
          suspendedAt: updated.suspendedAt?.toISOString() ?? null,
        },
      });
      if (dto.status === ClubVerificationStatus.SUSPENDED) {
        await this.cancelClubEvents(transaction, actor, clubId, reason, actorIp);
      }
      return updated;
    });
    await this.analyticsCache.invalidateClub(clubId);
    return updated;
  }

  async listVenues() {
    const venues = await this.prisma.venue.findMany({
      where: { deletedAt: null },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 500,
      include: {
        availability: {
          select: { weekday: true, opensAt: true, closesAt: true },
          orderBy: { weekday: 'asc' },
        },
      },
    });
    return {
      data: venues.map((venue) => ({
        id: venue.id,
        name: venue.name,
        slug: venue.slug,
        building: venue.building,
        room: venue.room,
        capacity: venue.capacity,
        bufferMinutes: venue.bufferMinutes,
        isActive: venue.isActive,
        isAccessible: venue.isAccessible,
        availabilityHours: venue.availability.map(({ weekday, opensAt, closesAt }) => ({
          weekday,
          opensAt,
          closesAt,
        })),
      })),
    };
  }

  async searchUsers(query: AdminPageDto) {
    if (!query.search || query.search.trim().length < 2) {
      throw new BadRequestException('A search term of at least two characters is required.');
    }
    const search = query.search.trim();
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      OR: [
        { email: { contains: search, mode: 'insensitive' } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
      ],
    };
    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: [{ email: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          isActive: true,
          createdAt: true,
          memberships: {
            where: { status: ClubMembershipStatus.ACTIVE },
            select: { clubId: true, role: true, club: { select: { name: true } } },
            orderBy: { clubId: 'asc' },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      data: users.map((user) => ({
        id: user.id,
        email: user.email,
        displayName: `${user.firstName} ${user.lastName}`.trim(),
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
        organizerClubs: user.memberships.map(({ clubId, role, club }) => ({
          clubId,
          clubName: club.name,
          membershipRole: role,
        })),
      })),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async grantOrganizerMembership(
    actor: AuthPrincipal,
    userId: string,
    clubId: string,
    reasonInput: string,
    actorIp: string,
  ) {
    if (actor.id === userId) throw new NotFoundException('User not found.');
    const reason = cleanReason(reasonInput);
    const sessionsRevoked = await this.prisma.$transaction(async (transaction) => {
      const user = await transaction.user.findFirst({
        where: { id: userId, isActive: true, deletedAt: null },
        select: { id: true, role: true, tokenVersion: true },
      });
      const club = await transaction.club.findFirst({
        where: {
          id: clubId,
          deletedAt: null,
          verificationStatus: { not: ClubVerificationStatus.SUSPENDED },
        },
        select: { id: true },
      });
      if (!user || !club) throw new NotFoundException('User or club not found.');
      const previous = await transaction.clubMembership.findUnique({
        where: { clubId_userId: { clubId, userId } },
        select: { status: true, role: true },
      });
      await transaction.clubMembership.upsert({
        where: { clubId_userId: { clubId, userId } },
        create: {
          clubId,
          userId,
          role: ClubMembershipRole.OFFICER,
          status: ClubMembershipStatus.ACTIVE,
          joinedAt: new Date(),
          leftAt: null,
        },
        update: {
          role: ClubMembershipRole.OFFICER,
          status: ClubMembershipStatus.ACTIVE,
          joinedAt: new Date(),
          leftAt: null,
        },
      });
      await this.audit(transaction, {
        actorId: actor.id,
        actorIp,
        action: 'ORGANIZER_MEMBERSHIP_GRANTED',
        entityType: 'ClubMembership',
        entityId: clubId,
        reason,
        beforeValues: {
          userId,
          clubId,
          status: previous?.status ?? null,
          role: previous?.role ?? null,
        },
        afterValues: {
          userId,
          clubId,
          status: ClubMembershipStatus.ACTIVE,
          role: ClubMembershipRole.OFFICER,
        },
      });
      if (user.role === UserRole.STUDENT) {
        const updated = await transaction.user.update({
          where: { id: userId },
          data: { role: UserRole.ORGANIZER, tokenVersion: { increment: 1 } },
          select: { tokenVersion: true },
        });
        await transaction.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.audit(transaction, {
          actorId: actor.id,
          actorIp,
          action: 'USER_ROLE_CHANGED',
          entityType: 'User',
          entityId: userId,
          reason,
          beforeValues: { role: user.role, tokenVersion: user.tokenVersion },
          afterValues: { role: UserRole.ORGANIZER, tokenVersion: updated.tokenVersion },
        });
        await this.enqueueAccountNotification(
          transaction,
          userId,
          NotificationType.ACCOUNT_ROLE_CHANGED,
          'Account role changed',
          'Your account now has organizer access.',
          `admin-role:${userId}:${updated.tokenVersion}`,
        );
      } else {
        const updated = await transaction.user.update({
          where: { id: userId },
          data: { tokenVersion: { increment: 1 } },
          select: { tokenVersion: true },
        });
        await transaction.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.audit(transaction, {
          actorId: actor.id,
          actorIp,
          action: 'USER_SESSION_VERSION_CHANGED',
          entityType: 'User',
          entityId: userId,
          reason,
          beforeValues: { tokenVersion: user.tokenVersion },
          afterValues: { tokenVersion: updated.tokenVersion },
        });
      }
      return true;
    });
    if (sessionsRevoked) {
      await this.rateLimit.publishSessionRevocation({ userId });
    }
    return { userId, clubId, status: ClubMembershipStatus.ACTIVE };
  }

  async revokeOrganizerMembership(
    actor: AuthPrincipal,
    userId: string,
    clubId: string,
    reasonInput: string,
    actorIp: string,
  ) {
    if (actor.id === userId) throw new NotFoundException('User not found.');
    const reason = cleanReason(reasonInput);
    const sessionsRevoked = await this.prisma.$transaction(async (transaction) => {
      const user = await transaction.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { id: true, role: true, tokenVersion: true },
      });
      const membership = await transaction.clubMembership.findUnique({
        where: { clubId_userId: { clubId, userId } },
        select: { id: true, role: true, status: true },
      });
      if (!user || !membership) throw new NotFoundException('Organizer membership not found.');
      if (membership.status !== ClubMembershipStatus.ACTIVE) {
        throw new ConflictException('The organizer membership is already inactive.');
      }
      await transaction.clubMembership.update({
        where: { id: membership.id },
        data: { status: ClubMembershipStatus.LEFT, leftAt: new Date() },
      });
      await this.audit(transaction, {
        actorId: actor.id,
        actorIp,
        action: 'ORGANIZER_MEMBERSHIP_REVOKED',
        entityType: 'ClubMembership',
        entityId: clubId,
        reason,
        beforeValues: {
          userId,
          clubId,
          status: membership.status,
          role: membership.role,
        },
        afterValues: {
          userId,
          clubId,
          status: ClubMembershipStatus.LEFT,
          role: membership.role,
        },
      });
      const remainingMemberships = await transaction.clubMembership.count({
        where: {
          userId,
          status: ClubMembershipStatus.ACTIVE,
          clubId: { not: clubId },
        },
      });
      if (user.role === UserRole.ORGANIZER && remainingMemberships === 0) {
        const updated = await transaction.user.update({
          where: { id: userId },
          data: { role: UserRole.STUDENT, tokenVersion: { increment: 1 } },
          select: { tokenVersion: true },
        });
        await transaction.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.audit(transaction, {
          actorId: actor.id,
          actorIp,
          action: 'USER_ROLE_CHANGED',
          entityType: 'User',
          entityId: userId,
          reason,
          beforeValues: { role: user.role, tokenVersion: user.tokenVersion },
          afterValues: { role: UserRole.STUDENT, tokenVersion: updated.tokenVersion },
        });
        await this.enqueueAccountNotification(
          transaction,
          userId,
          NotificationType.ACCOUNT_ROLE_CHANGED,
          'Account role changed',
          'Your organizer access has ended.',
          `admin-role:${userId}:${updated.tokenVersion}`,
        );
      } else {
        const updated = await transaction.user.update({
          where: { id: userId },
          data: { tokenVersion: { increment: 1 } },
          select: { tokenVersion: true },
        });
        await transaction.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.audit(transaction, {
          actorId: actor.id,
          actorIp,
          action: 'USER_SESSION_VERSION_CHANGED',
          entityType: 'User',
          entityId: userId,
          reason,
          beforeValues: { tokenVersion: user.tokenVersion },
          afterValues: { tokenVersion: updated.tokenVersion },
        });
      }
      return true;
    });
    if (sessionsRevoked) {
      await this.rateLimit.publishSessionRevocation({ userId });
    }
    return { userId, clubId, status: ClubMembershipStatus.LEFT };
  }

  async requestAdminRoleGrant(
    actor: AuthPrincipal,
    userId: string,
    familyId: string,
    reasonInput: string,
    actorIp: string,
  ) {
    if (userId === actor.id) throw new NotFoundException('User not found.');
    const reason = cleanReason(reasonInput);
    const now = new Date();
    const authentication = await this.prisma.refreshToken.findFirst({
      where: { userId: actor.id, familyId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { googleAuthenticatedAt: true },
    });
    if (
      !authentication ||
      now.getTime() - authentication.googleAuthenticatedAt.getTime() >
        RECENT_GOOGLE_SIGN_IN_WINDOW_MS
    ) {
      throw new ConflictException('A recent Google sign-in is required.');
    }
    const request = await this.prisma.$transaction(async (transaction) => {
      const target = await transaction.user.findFirst({
        where: { id: userId, isActive: true, deletedAt: null },
        select: { id: true, role: true },
      });
      if (!target || target.role === UserRole.ADMIN) {
        throw new NotFoundException('User not found.');
      }
      await transaction.adminRoleGrantRequest.updateMany({
        where: {
          targetUserId: userId,
          status: AdminRoleGrantStatus.PENDING,
          expiresAt: { lte: now },
        },
        data: { status: AdminRoleGrantStatus.EXPIRED, resolvedAt: now },
      });
      const created = await transaction.adminRoleGrantRequest.create({
        data: {
          targetUserId: userId,
          requestedById: actor.id,
          reason,
          expiresAt: new Date(now.getTime() + ADMIN_ROLE_GRANT_WINDOW_MS),
        },
        select: { id: true, targetUserId: true, status: true, expiresAt: true },
      });
      await this.audit(transaction, {
        actorId: actor.id,
        actorIp,
        action: 'ADMIN_ROLE_GRANT_REQUESTED',
        entityType: 'AdminRoleGrantRequest',
        entityId: created.id,
        reason,
        beforeValues: { role: target.role },
        afterValues: {
          status: created.status,
          targetUserId: created.targetUserId,
          expiresAt: created.expiresAt.toISOString(),
        },
      });
      return created;
    });
    return request;
  }

  async listAdminRoleGrantRequests(query: AdminPageDto) {
    const now = new Date();
    const where: Prisma.AdminRoleGrantRequestWhereInput = {
      status: AdminRoleGrantStatus.PENDING,
      expiresAt: { gt: now },
    };
    const [requests, total] = await this.prisma.$transaction([
      this.prisma.adminRoleGrantRequest.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          reason: true,
          expiresAt: true,
          createdAt: true,
          target: { select: { id: true, email: true, firstName: true, lastName: true } },
          requestedBy: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.adminRoleGrantRequest.count({ where }),
    ]);
    return {
      data: requests.map((request) => ({
        id: request.id,
        reason: request.reason,
        expiresAt: request.expiresAt,
        createdAt: request.createdAt,
        target: {
          id: request.target.id,
          email: request.target.email,
          displayName: `${request.target.firstName} ${request.target.lastName}`.trim(),
        },
        requestedBy: {
          id: request.requestedBy.id,
          displayName: `${request.requestedBy.firstName} ${request.requestedBy.lastName}`.trim(),
        },
      })),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async approveAdminRoleGrant(
    actor: AuthPrincipal,
    requestId: string,
    reasonInput: string,
    actorIp: string,
  ) {
    const reason = cleanReason(reasonInput);
    const result = await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ lock: number }>>`
        SELECT 1 AS lock FROM pg_advisory_xact_lock(${ADMIN_MUTATION_LOCK}::bigint)
      `;
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "admin_role_grant_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE
      `;
      const grant = await transaction.adminRoleGrantRequest.findUnique({
        where: { id: requestId },
        select: {
          id: true,
          targetUserId: true,
          requestedById: true,
          status: true,
          reason: true,
          expiresAt: true,
        },
      });
      if (!grant) throw new NotFoundException('Role grant request not found.');
      if (
        grant.requestedById === actor.id ||
        grant.targetUserId === actor.id ||
        grant.status !== AdminRoleGrantStatus.PENDING
      ) {
        throw new NotFoundException('Role grant request not found.');
      }
      const now = new Date();
      if (grant.expiresAt <= now) {
        await transaction.adminRoleGrantRequest.update({
          where: { id: requestId },
          data: { status: AdminRoleGrantStatus.EXPIRED, resolvedAt: now },
        });
        await this.audit(transaction, {
          actorId: actor.id,
          actorIp,
          action: 'ADMIN_ROLE_GRANT_EXPIRED',
          entityType: 'AdminRoleGrantRequest',
          entityId: requestId,
          reason,
          beforeValues: { status: grant.status },
          afterValues: { status: AdminRoleGrantStatus.EXPIRED },
        });
        return { expired: true as const };
      }

      const target = await transaction.user.findFirst({
        where: { id: grant.targetUserId, isActive: true, deletedAt: null },
        select: { id: true, role: true, tokenVersion: true },
      });
      if (!target || target.role === UserRole.ADMIN) {
        throw new ConflictException('The target account can no longer receive this role.');
      }
      const updated = await transaction.user.update({
        where: { id: target.id },
        data: { role: UserRole.ADMIN, tokenVersion: { increment: 1 } },
        select: { id: true, role: true, tokenVersion: true },
      });
      await transaction.refreshToken.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await transaction.adminRoleGrantRequest.update({
        where: { id: requestId },
        data: {
          status: AdminRoleGrantStatus.APPROVED,
          approvedById: actor.id,
          approvalReason: reason,
          resolvedAt: now,
        },
      });
      await this.audit(transaction, {
        actorId: actor.id,
        actorIp,
        action: 'ADMIN_ROLE_GRANT_APPROVED',
        entityType: 'AdminRoleGrantRequest',
        entityId: requestId,
        reason,
        beforeValues: { status: grant.status, requestedById: grant.requestedById },
        afterValues: { status: AdminRoleGrantStatus.APPROVED, approvedById: actor.id },
      });
      await this.audit(transaction, {
        actorId: actor.id,
        actorIp,
        action: 'USER_ROLE_CHANGED',
        entityType: 'User',
        entityId: target.id,
        reason,
        beforeValues: { role: target.role, tokenVersion: target.tokenVersion },
        afterValues: { role: updated.role, tokenVersion: updated.tokenVersion },
      });
      await this.enqueueAccountNotification(
        transaction,
        target.id,
        NotificationType.ACCOUNT_ROLE_CHANGED,
        'Account role changed',
        'Your account now has administrator access.',
        `admin-role:${target.id}:${updated.tokenVersion}`,
      );
      return { expired: false as const, userId: target.id, role: updated.role };
    });
    if (result.expired) {
      throw new ConflictException('The administrator grant request has expired.');
    }
    await this.rateLimit.publishSessionRevocation({ userId: result.userId });
    return result;
  }

  async revokeAdminRole(
    actor: AuthPrincipal,
    userId: string,
    reasonInput: string,
    actorIp: string,
  ) {
    if (actor.id === userId) throw new NotFoundException('User not found.');
    const reason = cleanReason(reasonInput);
    const updated = await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ lock: number }>>`
        SELECT 1 AS lock FROM pg_advisory_xact_lock(${ADMIN_MUTATION_LOCK}::bigint)
      `;
      await this.lockActiveAdministrators(transaction);
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE
      `;
      const target = await transaction.user.findFirst({
        where: { id: userId, role: UserRole.ADMIN, deletedAt: null },
        select: { id: true, role: true, tokenVersion: true, isActive: true },
      });
      if (!target) throw new NotFoundException('User not found.');
      const activeAdmins = await transaction.user.count({
        where: { role: UserRole.ADMIN, isActive: true, deletedAt: null },
      });
      if (target.isActive && activeAdmins <= 1) {
        throw new ConflictException('The last active administrator cannot be demoted.');
      }
      const result = await transaction.user.update({
        where: { id: userId },
        data: { role: UserRole.STUDENT, tokenVersion: { increment: 1 } },
        select: { id: true, role: true, tokenVersion: true },
      });
      await transaction.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit(transaction, {
        actorId: actor.id,
        actorIp,
        action: 'USER_ROLE_CHANGED',
        entityType: 'User',
        entityId: userId,
        reason,
        beforeValues: { role: target.role, tokenVersion: target.tokenVersion },
        afterValues: { role: result.role, tokenVersion: result.tokenVersion },
      });
      await this.enqueueAccountNotification(
        transaction,
        userId,
        NotificationType.ACCOUNT_ROLE_CHANGED,
        'Account role changed',
        'Your administrator access has ended.',
        `admin-role:${userId}:${result.tokenVersion}`,
      );
      return result;
    });
    await this.rateLimit.publishSessionRevocation({ userId });
    return updated;
  }

  async setUserActive(
    actor: AuthPrincipal,
    userId: string,
    active: boolean,
    reasonInput: string,
    actorIp: string,
  ) {
    if (actor.id === userId) throw new NotFoundException('User not found.');
    const reason = cleanReason(reasonInput);
    const updated = await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ lock: number }>>`
        SELECT 1 AS lock FROM pg_advisory_xact_lock(${ADMIN_MUTATION_LOCK}::bigint)
      `;
      await this.lockActiveAdministrators(transaction);
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE
      `;
      const target = await transaction.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { id: true, role: true, isActive: true, tokenVersion: true },
      });
      if (!target) throw new NotFoundException('User not found.');
      if (target.isActive === active) {
        throw new ConflictException(
          active ? 'The account is already active.' : 'The account is already suspended.',
        );
      }
      if (!active && target.role === UserRole.ADMIN) {
        const activeAdmins = await transaction.user.count({
          where: { role: UserRole.ADMIN, isActive: true, deletedAt: null },
        });
        if (activeAdmins <= 1) {
          throw new ConflictException('The last active administrator cannot be suspended.');
        }
      }
      const result = await transaction.user.update({
        where: { id: userId },
        data: { isActive: active, tokenVersion: { increment: 1 } },
        select: { id: true, isActive: true, tokenVersion: true },
      });
      await transaction.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit(transaction, {
        actorId: actor.id,
        actorIp,
        action: active ? 'USER_REACTIVATED' : 'USER_SUSPENDED',
        entityType: 'User',
        entityId: userId,
        reason,
        beforeValues: { isActive: target.isActive, tokenVersion: target.tokenVersion },
        afterValues: { isActive: result.isActive, tokenVersion: result.tokenVersion },
      });
      await this.enqueueAccountNotification(
        transaction,
        userId,
        active ? NotificationType.ACCOUNT_REACTIVATED : NotificationType.ACCOUNT_SUSPENDED,
        active ? 'Account reactivated' : 'Account suspended',
        active
          ? 'Your account access has been restored.'
          : 'Your account has been suspended. Contact campus support for assistance.',
        `admin-account:${userId}:${result.tokenVersion}`,
      );
      return result;
    });
    await this.rateLimit.publishSessionRevocation({ userId });
    return updated;
  }

  async createReport(actor: AuthPrincipal, dto: CreateModerationReportDto, actorIp: string) {
    const reasonText = dto.note?.trim() || null;
    if (dto.note && !reasonText) {
      throw new BadRequestException('The report note cannot contain only whitespace.');
    }
    const target = await this.findReportableTarget(actor, dto.targetType, dto.targetId);
    if (!target) throw new NotFoundException('Report target not found.');
    const openKey = reportOpenKey(actor.id, dto.targetType, dto.targetId);
    try {
      const report = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.moderationReport.create({
          data: {
            reporterId: actor.id,
            targetType: dto.targetType,
            targetId: dto.targetId,
            openKey,
            reason: dto.reason,
            note: reasonText,
          },
          select: { id: true, status: true, createdAt: true },
        });
        await this.audit(transaction, {
          actorId: actor.id,
          actorIp,
          action: 'MODERATION_REPORT_SUBMITTED',
          entityType: 'ModerationReport',
          entityId: created.id,
          reason: dto.reason,
          afterValues: { targetType: dto.targetType, targetId: dto.targetId },
        });
        return created;
      });
      return report;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A report is already open for this item.');
      }
      throw error;
    }
  }

  async listReports(query: AdminPageDto & { status?: ModerationReportStatus }) {
    const where: Prisma.ModerationReportWhereInput = {
      ...(query.status ? { status: query.status } : {}),
    };
    const [reports, total] = await this.prisma.$transaction([
      this.prisma.moderationReport.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          targetType: true,
          targetId: true,
          reason: true,
          note: true,
          status: true,
          resolutionAction: true,
          resolutionReason: true,
          createdAt: true,
          resolvedAt: true,
          reporter: { select: { id: true, email: true, firstName: true, lastName: true } },
          resolvedById: true,
        },
      }),
      this.prisma.moderationReport.count({ where }),
    ]);
    return {
      data: reports.map((report) => ({
        id: report.id,
        targetType: report.targetType,
        targetId: report.targetId,
        reason: report.reason,
        note: report.note,
        status: report.status,
        resolutionAction: report.resolutionAction,
        resolutionReason: report.resolutionReason,
        createdAt: report.createdAt,
        resolvedAt: report.resolvedAt,
        reporter: {
          id: report.reporter.id,
          email: report.reporter.email,
          displayName: `${report.reporter.firstName} ${report.reporter.lastName}`.trim(),
        },
        resolvedById: report.resolvedById,
      })),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async resolveReport(
    actor: AuthPrincipal,
    reportId: string,
    dto: ResolveModerationReportDto,
    actorIp: string,
  ) {
    const reason = cleanReason(dto.reason);
    const result = await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "moderation_reports" WHERE "id" = ${reportId}::uuid FOR UPDATE
      `;
      const report = await transaction.moderationReport.findUnique({
        where: { id: reportId },
        select: {
          id: true,
          targetType: true,
          targetId: true,
          status: true,
          reporterId: true,
        },
      });
      if (!report || report.status !== ModerationReportStatus.OPEN) {
        throw new NotFoundException('Report not found.');
      }
      if (
        (dto.action === ModerationAction.HIDE_EVENT ||
          dto.action === ModerationAction.CANCEL_EVENT) &&
        report.targetType !== ModerationTargetType.EVENT
      ) {
        throw new BadRequestException('The selected action does not match this report target.');
      }
      if (
        dto.action === ModerationAction.SUSPEND_CLUB &&
        report.targetType !== ModerationTargetType.CLUB
      ) {
        throw new BadRequestException('The selected action does not match this report target.');
      }

      let affectedEventId: string | null = null;
      let affectedClubId: string | null = null;
      if (
        report.targetType === ModerationTargetType.EVENT &&
        (dto.action === ModerationAction.HIDE_EVENT || dto.action === ModerationAction.CANCEL_EVENT)
      ) {
        affectedEventId = await this.takedownEvent(
          transaction,
          actor,
          report.targetId,
          report.id,
          dto.action,
          reason,
          actorIp,
        );
      } else if (
        report.targetType === ModerationTargetType.CLUB &&
        dto.action === ModerationAction.SUSPEND_CLUB
      ) {
        const club = await transaction.club.findFirst({
          where: { id: report.targetId, deletedAt: null },
          select: {
            id: true,
            verificationStatus: true,
            verificationReason: true,
            suspendedAt: true,
          },
        });
        if (!club) throw new NotFoundException('Report not found.');
        await transaction.club.update({
          where: { id: club.id },
          data: {
            verificationStatus: ClubVerificationStatus.SUSPENDED,
            verificationReason: reason,
            suspendedAt: new Date(),
          },
        });
        await this.cancelClubEvents(transaction, actor, club.id, reason, actorIp);
        affectedClubId = club.id;
        await this.audit(transaction, {
          actorId: actor.id,
          actorIp,
          action: 'CLUB_SUSPENDED_BY_MODERATION',
          entityType: 'Club',
          entityId: club.id,
          reason,
          beforeValues: {
            verificationStatus: club.verificationStatus,
            verificationReason: club.verificationReason,
            suspendedAt: club.suspendedAt?.toISOString() ?? null,
          },
          afterValues: {
            verificationStatus: ClubVerificationStatus.SUSPENDED,
            verificationReason: reason,
          },
        });
      } else if (dto.action !== ModerationAction.DISMISS) {
        throw new BadRequestException('The selected moderation action is invalid.');
      }

      await transaction.moderationReport.update({
        where: { id: report.id },
        data: {
          status: ModerationReportStatus.RESOLVED,
          openKey: null,
          resolutionAction: dto.action,
          resolutionReason: reason,
          resolvedById: actor.id,
          resolvedAt: new Date(),
        },
      });
      await this.audit(transaction, {
        actorId: actor.id,
        actorIp,
        action: 'MODERATION_REPORT_RESOLVED',
        entityType: 'ModerationReport',
        entityId: report.id,
        reason,
        beforeValues: { status: report.status },
        afterValues: { status: ModerationReportStatus.RESOLVED, action: dto.action },
      });
      return {
        id: report.id,
        status: ModerationReportStatus.RESOLVED,
        affectedEventId,
        affectedClubId,
      };
    });
    if (result.affectedEventId) {
      await this.analyticsCache.invalidateEvent(result.affectedEventId);
    }
    if (result.affectedClubId) {
      await this.analyticsCache.invalidateClub(result.affectedClubId);
    }
    return { id: result.id, status: result.status, action: dto.action };
  }

  async listAuditLogs(actor: AuthPrincipal, query: AdminAuditQueryDto, actorIp: string) {
    return this.prisma.$transaction(async (transaction) => {
      await this.audit(transaction, {
        actorId: actor.id,
        actorIp,
        action: 'ADMIN_AUDIT_LOG_READ',
        entityType: 'AuditLog',
        reason: 'Administrator reviewed the audit log.',
        afterValues: {
          cursor: query.cursor ?? null,
          limit: query.limit,
        },
      });
      const rows = await transaction.auditLog.findMany({
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        select: {
          id: true,
          actorId: true,
          action: true,
          entityType: true,
          entityId: true,
          reason: true,
          beforeValues: true,
          afterValues: true,
          actorIp: true,
          createdAt: true,
        },
      });
      const hasMore = rows.length > query.limit;
      const data = rows.slice(0, query.limit).map((row) => ({
        id: row.id,
        actorId: row.actorId,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        reason: row.reason,
        beforeValues: row.beforeValues,
        afterValues: row.afterValues,
        actorIp: row.actorIp,
        createdAt: row.createdAt,
      }));
      return {
        data,
        nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null,
      };
    });
  }

  async enforceReportRateLimit(userId: string, perHour: number): Promise<void> {
    await this.rateLimit.consume('moderation-report-user', userId, perHour, 60 * 60_000, {
      exceeded: 'Too many reports. Try again later.',
      unavailable: 'Reports are temporarily unavailable.',
    });
  }

  private async findReportableTarget(
    actor: AuthPrincipal,
    targetType: ModerationTargetType,
    targetId: string,
  ): Promise<boolean> {
    if (targetType === ModerationTargetType.EVENT) {
      const event = await this.prisma.event.findFirst({
        where: {
          id: targetId,
          deletedAt: null,
          OR: [
            { status: EventStatus.APPROVED, isPublic: true },
            ...(actor.role === UserRole.ORGANIZER
              ? [
                  {
                    club: {
                      memberships: {
                        some: {
                          userId: actor.id,
                          status: ClubMembershipStatus.ACTIVE,
                        },
                      },
                    },
                  },
                ]
              : []),
          ],
        },
        select: { id: true },
      });
      return Boolean(event);
    }
    const club = await this.prisma.club.findFirst({
      where: { id: targetId, deletedAt: null },
      select: { id: true },
    });
    return Boolean(club);
  }

  private async takedownEvent(
    transaction: Prisma.TransactionClient,
    actor: AuthPrincipal,
    eventId: string,
    reportId: string,
    action: ModerationAction,
    reason: string,
    actorIp: string,
  ): Promise<string> {
    await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "events" WHERE "id" = ${eventId}::uuid AND "deleted_at" IS NULL FOR UPDATE
    `;
    const event = await transaction.event.findFirst({
      where: { id: eventId, deletedAt: null },
      select: {
        id: true,
        title: true,
        status: true,
        venueId: true,
        startAt: true,
        endAt: true,
        expectedAttendance: true,
        createdById: true,
        clubId: true,
        updatedAt: true,
      },
    });
    if (!event) throw new NotFoundException('Report not found.');
    if (event.venueId) {
      await this.venueBookings.lockVenueForEventWrite(transaction, event.venueId, false);
    }
    const now = new Date();
    await transaction.event.update({
      where: { id: event.id },
      data: {
        status: EventStatus.CANCELLED,
        deletedAt: now,
        approvedById: null,
        approvedAt: null,
      },
    });
    await this.venueBookings.syncEventBooking(transaction, {
      eventId: event.id,
      venueId: event.venueId,
      startAt: event.startAt,
      endAt: event.endAt,
      expectedAttendance: event.expectedAttendance,
      eventStatus: EventStatus.CANCELLED,
      requestedById: event.createdById,
      actorId: actor.id,
    });
    await cancelPendingRsvpReminders(transaction, event.id);
    const recipients = await transaction.rsvp.findMany({
      where: {
        eventId: event.id,
        status: {
          in: [RsvpStatus.GOING, RsvpStatus.WAITLISTED, RsvpStatus.CHECKED_IN],
        },
      },
      select: { userId: true },
    });
    const recipientIds = new Set([event.createdById, ...recipients.map(({ userId }) => userId)]);
    await enqueueNotifications(
      transaction,
      [...recipientIds].map((userId) => ({
        userId,
        eventId: event.id,
        type: NotificationType.EVENT_CANCELLED,
        title: 'Event unavailable',
        body: `${event.title} has been cancelled.`,
        dedupeKey: `moderation-event:${reportId}:${userId}`,
      })),
    );
    await this.audit(transaction, {
      actorId: actor.id,
      actorIp,
      action:
        action === ModerationAction.HIDE_EVENT
          ? 'EVENT_HIDDEN_BY_MODERATION'
          : 'EVENT_CANCELLED_BY_MODERATION',
      entityType: 'Event',
      entityId: event.id,
      reason,
      beforeValues: { status: event.status, deletedAt: null },
      afterValues: { status: EventStatus.CANCELLED, deletedAt: now.toISOString() },
    });
    return event.id;
  }

  private async cancelClubEvents(
    transaction: Prisma.TransactionClient,
    actor: AuthPrincipal,
    clubId: string,
    reason: string,
    actorIp: string,
  ): Promise<void> {
    const now = new Date();
    const events = await transaction.event.findMany({
      where: {
        clubId,
        status: EventStatus.APPROVED,
        deletedAt: null,
        startAt: { gt: now },
      },
      select: {
        id: true,
        title: true,
        venueId: true,
        startAt: true,
        endAt: true,
        expectedAttendance: true,
        createdById: true,
        status: true,
      },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    });

    for (const event of events) {
      if (event.venueId) {
        await this.venueBookings.lockVenueForEventWrite(transaction, event.venueId, false);
      }
      const deletedAt = new Date();
      const changed = await transaction.event.updateMany({
        where: { id: event.id, status: EventStatus.APPROVED, deletedAt: null },
        data: { status: EventStatus.CANCELLED, deletedAt, approvedById: null, approvedAt: null },
      });
      if (changed.count !== 1) continue;
      await this.venueBookings.syncEventBooking(transaction, {
        eventId: event.id,
        venueId: event.venueId,
        startAt: event.startAt,
        endAt: event.endAt,
        expectedAttendance: event.expectedAttendance,
        eventStatus: EventStatus.CANCELLED,
        requestedById: event.createdById,
        actorId: actor.id,
      });
      await cancelPendingRsvpReminders(transaction, event.id);
      const rsvps = await transaction.rsvp.findMany({
        where: {
          eventId: event.id,
          status: {
            in: [RsvpStatus.GOING, RsvpStatus.WAITLISTED, RsvpStatus.CHECKED_IN],
          },
        },
        select: { userId: true },
      });
      const recipients = new Set([event.createdById, ...rsvps.map(({ userId }) => userId)]);
      await enqueueNotifications(
        transaction,
        [...recipients].map((userId) => ({
          userId,
          eventId: event.id,
          type: NotificationType.EVENT_CANCELLED,
          title: 'Event unavailable',
          body: `${event.title} has been cancelled.`,
          dedupeKey: `club-suspension:${clubId}:${event.id}:${userId}`,
        })),
      );
      await this.audit(transaction, {
        actorId: actor.id,
        actorIp,
        action: 'EVENT_CANCELLED_BY_CLUB_SUSPENSION',
        entityType: 'Event',
        entityId: event.id,
        reason,
        beforeValues: { status: event.status, deletedAt: null },
        afterValues: { status: EventStatus.CANCELLED, deletedAt: deletedAt.toISOString() },
      });
    }
  }

  private async enqueueAccountNotification(
    transaction: Prisma.TransactionClient,
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    dedupeKey: string,
  ): Promise<void> {
    await enqueueNotifications(transaction, [
      { userId, eventId: null, type, title, body, dedupeKey },
    ]);
  }

  private async lockActiveAdministrators(transaction: Prisma.TransactionClient): Promise<void> {
    await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "users"
      WHERE "role" = ${UserRole.ADMIN} AND "is_active" = true AND "deleted_at" IS NULL
      ORDER BY "id"
      FOR UPDATE
    `;
  }

  private audit(transaction: Prisma.TransactionClient, input: AuditInput): Promise<unknown> {
    return transaction.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        entityType: input.entityType,
        ...(input.entityId ? { entityId: input.entityId } : {}),
        reason: cleanReason(input.reason),
        ...(input.beforeValues ? { beforeValues: input.beforeValues } : {}),
        ...(input.afterValues ? { afterValues: input.afterValues } : {}),
        actorIp: safeIpAddress(input.actorIp),
      },
    });
  }
}
