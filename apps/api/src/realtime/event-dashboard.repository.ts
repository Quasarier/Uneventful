import { Injectable } from '@nestjs/common';
import { RsvpStatus } from '../../generated/prisma/client';
import type { AuthPrincipal } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';
import type { EventDashboardSnapshot } from './event-dashboard.types';

@Injectable()
export class EventDashboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  async canJoin(eventId: string, actor: AuthPrincipal): Promise<boolean> {
    if (actor.role !== 'ADMIN' && actor.role !== 'ORGANIZER') {
      return false;
    }

    const event = await this.prisma.event.findFirst({
      where: { id: eventId, deletedAt: null },
      select: { id: true, clubId: true },
    });
    if (!event) {
      return false;
    }
    if (actor.role === 'ADMIN') {
      return true;
    }

    const membership = await this.prisma.clubMembership.findFirst({
      where: {
        userId: actor.id,
        clubId: event.clubId,
        status: 'ACTIVE',
        club: { deletedAt: null },
        user: { isActive: true, deletedAt: null },
      },
      select: { id: true },
    });
    return membership !== null;
  }

  async snapshot(eventId: string): Promise<EventDashboardSnapshot | null> {
    return this.prisma.$transaction(async (transaction) => {
      const event = await transaction.event.findFirst({
        where: { id: eventId, deletedAt: null },
        select: { capacity: true },
      });
      if (!event) {
        return null;
      }

      const [rsvpCount, checkInCount, recent] = await Promise.all([
        transaction.rsvp.count({
          where: { eventId, status: { in: [RsvpStatus.GOING, RsvpStatus.CHECKED_IN] } },
        }),
        transaction.checkIn.count({
          where: { ticket: { is: { rsvp: { is: { eventId } } } } },
        }),
        transaction.checkIn.findMany({
          where: { ticket: { is: { rsvp: { is: { eventId } } } } },
          orderBy: [{ checkedInAt: 'desc' }, { id: 'desc' }],
          take: 10,
          select: {
            checkedInAt: true,
            ticket: {
              select: {
                rsvp: {
                  select: {
                    user: { select: { firstName: true, lastName: true } },
                  },
                },
              },
            },
          },
        }),
      ]);

      return {
        eventId,
        checkInCount,
        rsvpCount,
        attendanceRatio: rsvpCount === 0 ? 0 : checkInCount / rsvpCount,
        capacity: event.capacity,
        recentCheckIns: recent.map((record) => ({
          displayName:
            `${record.ticket.rsvp.user.firstName} ${record.ticket.rsvp.user.lastName}`.trim(),
          checkedInAt: record.checkedInAt.toISOString(),
        })),
      };
    });
  }
}
