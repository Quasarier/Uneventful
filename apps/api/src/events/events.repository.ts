import { Injectable } from '@nestjs/common';
import { EventStatus, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';

const eventInclude = {
  club: { select: { name: true, slug: true } },
  category: { select: { name: true, slug: true } },
} satisfies Prisma.EventInclude;

export type EventRecord = Prisma.EventGetPayload<{ include: typeof eventInclude }>;

@Injectable()
export class EventsRepository {
  constructor(private readonly prisma: PrismaService) {}

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
      const event = await transaction.event.create({ data, include: eventInclude });
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
    });
  }

  async updateEvent(
    id: string,
    expectedStatus: EventStatus,
    data: Prisma.EventUncheckedUpdateInput,
    actorId: string,
    audit?: { action: string; metadata: Prisma.InputJsonValue },
  ): Promise<EventRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const result = await transaction.event.updateMany({
        where: { id, deletedAt: null, status: expectedStatus },
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
    });
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
