import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EventStatus, Prisma } from '../../generated/prisma/client';
import { isIP } from 'node:net';
import { PrismaService } from '../database/prisma.service';
import type { CreateVenueDto } from './dto/create-venue.dto';
import type { UpdateVenueDto } from './dto/update-venue.dto';

const venueInclude = {
  availability: {
    select: { weekday: true, opensAt: true, closesAt: true },
    orderBy: { weekday: 'asc' },
  },
} satisfies Prisma.VenueInclude;

export type VenueRecord = Prisma.VenueGetPayload<{ include: typeof venueInclude }>;

interface AdminVenueAuditContext {
  reason: string;
  actorIp: string;
}

function validActorIp(value: string | undefined): string | null {
  return value && isIP(value) ? value.slice(0, 45) : null;
}

function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 170);
  return `${slug || 'venue'}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

@Injectable()
export class VenuesRepository {
  constructor(private readonly prisma: PrismaService) {}

  listActive(): Promise<VenueRecord[]> {
    return this.prisma.venue.findMany({
      where: { isActive: true, deletedAt: null },
      include: venueInclude,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  findById(id: string): Promise<VenueRecord | null> {
    return this.prisma.venue.findUnique({ where: { id }, include: venueInclude });
  }

  findVisibleEventClub(eventId: string): Promise<{ clubId: string } | null> {
    return this.prisma.event.findFirst({
      where: { id: eventId, deletedAt: null },
      select: { clubId: true },
    });
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

  async create(
    dto: CreateVenueDto,
    actorId: string,
    auditContext?: AdminVenueAuditContext,
  ): Promise<VenueRecord> {
    return this.prisma.$transaction(async (transaction) => {
      const venue = await transaction.venue.create({
        data: {
          name: dto.name.trim(),
          slug: slugify(dto.name),
          building: dto.building?.trim() || null,
          capacity: dto.capacity,
          bufferMinutes: dto.bufferMinutes,
          availability: {
            create: dto.availabilityHours.map(({ weekday, opensAt, closesAt }) => ({
              weekday,
              opensAt,
              closesAt,
            })),
          },
        },
        include: venueInclude,
      });
      await this.audit(
        transaction,
        actorId,
        'VENUE_CREATED',
        venue.id,
        {
          fields: ['name', 'building', 'capacity', 'bufferMinutes', 'availabilityHours'],
        },
        auditContext,
        undefined,
        {
          name: venue.name,
          capacity: venue.capacity,
          bufferMinutes: venue.bufferMinutes,
          isActive: venue.isActive,
        },
      );
      return venue;
    });
  }

  async update(
    id: string,
    dto: UpdateVenueDto,
    actorId: string,
    auditContext?: AdminVenueAuditContext,
  ): Promise<VenueRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "venues" WHERE "id" = ${id}::uuid FOR UPDATE
      `;
      const current = await transaction.venue.findFirst({
        where: { id, deletedAt: null },
        include: venueInclude,
      });
      if (!current) {
        return null;
      }

      const availability = dto.availabilityHours;
      if (availability !== undefined) {
        await transaction.venueAvailability.deleteMany({ where: { venueId: id } });
      }
      const venue = await transaction.venue.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim(), slug: slugify(dto.name) } : {}),
          ...(dto.building !== undefined ? { building: dto.building?.trim() || null } : {}),
          ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
          ...(dto.bufferMinutes !== undefined ? { bufferMinutes: dto.bufferMinutes } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(availability !== undefined
            ? {
                availability: {
                  create: availability.map(({ weekday, opensAt, closesAt }) => ({
                    weekday,
                    opensAt,
                    closesAt,
                  })),
                },
              }
            : {}),
        },
        include: venueInclude,
      });
      await this.audit(
        transaction,
        actorId,
        'VENUE_UPDATED',
        venue.id,
        { fields: Object.keys(dto).sort() },
        auditContext,
        {
          name: current.name,
          building: current.building,
          capacity: current.capacity,
          bufferMinutes: current.bufferMinutes,
          isActive: current.isActive,
        },
        {
          name: venue.name,
          building: venue.building,
          capacity: venue.capacity,
          bufferMinutes: venue.bufferMinutes,
          isActive: venue.isActive,
        },
      );
      return venue;
    });
  }

  async retire(
    id: string,
    actorId: string,
    auditContext?: AdminVenueAuditContext,
  ): Promise<VenueRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "venues" WHERE "id" = ${id}::uuid FOR UPDATE
      `;
      const venue = await transaction.venue.findFirst({
        where: { id, deletedAt: null },
        include: venueInclude,
      });
      if (!venue) {
        return null;
      }
      const futureApprovedBookings = await transaction.event.count({
        where: {
          venueId: id,
          status: EventStatus.APPROVED,
          deletedAt: null,
          startAt: { gt: new Date() },
        },
      });
      if (futureApprovedBookings > 0) {
        throw new ConflictException(
          'The venue cannot be retired while it has future approved events.',
        );
      }
      const updated = await transaction.venue.update({
        where: { id },
        data: { isActive: false },
        include: venueInclude,
      });
      await this.audit(
        transaction,
        actorId,
        'VENUE_RETIRED',
        id,
        { isActive: false },
        auditContext,
        { isActive: venue.isActive },
        { isActive: false },
      );
      return updated;
    });
  }

  async withTransaction<T>(
    work: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(work);
  }

  private audit(
    transaction: Prisma.TransactionClient,
    actorId: string,
    action: string,
    venueId: string,
    metadata: Prisma.InputJsonValue,
    auditContext?: AdminVenueAuditContext,
    beforeValues?: Prisma.InputJsonObject,
    afterValues?: Prisma.InputJsonObject,
  ): Promise<unknown> {
    return transaction.auditLog.create({
      data: {
        actorId,
        action,
        entityType: 'Venue',
        entityId: venueId,
        metadata,
        ...(auditContext
          ? {
              reason: auditContext.reason.trim(),
              actorIp: validActorIp(auditContext.actorIp),
              ...(beforeValues ? { beforeValues } : {}),
              ...(afterValues ? { afterValues } : {}),
            }
          : {}),
      },
    });
  }
}
