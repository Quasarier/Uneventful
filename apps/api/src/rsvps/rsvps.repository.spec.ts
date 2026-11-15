import { describe, expect, it, vi } from 'vitest';
import { RsvpStatus, TicketStatus } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { RsvpsRepository } from './rsvps.repository';

describe('RsvpsRepository', () => {
  it('returns only the caller RSVP details and safe ticket metadata', async () => {
    const userId = 'cdd0fb75-9e83-4c49-8a02-15bf8e1ae2ae';
    const eventId = 'b3a3345c-6450-4c36-9bb4-440e07b65bce';
    const rsvpId = 'f5866ad7-0929-48e8-92c7-948e262b9192';
    const createdAt = new Date('2026-02-01T10:00:00.000Z');
    const expiresAt = new Date('2026-04-02T20:00:00.000Z');
    const database = {
      rsvp: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: rsvpId,
            status: RsvpStatus.GOING,
            waitlistPosition: null,
            createdAt,
            event: {
              id: eventId,
              title: 'Campus Showcase',
              slug: 'campus-showcase',
              description: 'Meet the campus clubs.',
              status: 'APPROVED',
              startAt: new Date('2026-04-02T18:00:00.000Z'),
              endAt: expiresAt,
              timeZone: 'UTC',
              capacity: 50,
              isPublic: true,
              clubId: '4ea0f280-2d60-4a56-a4cf-18b44349269f',
              categoryId: 'c138c747-06dc-4dcf-a24f-0533639e689c',
              rejectionReason: null,
              imageKey: null,
              createdAt,
              updatedAt: createdAt,
              club: { name: 'Student Union', slug: 'student-union' },
              category: { name: 'Community', slug: 'community' },
            },
            ticket: {
              status: TicketStatus.ISSUED,
              expiresAt,
              tokenHash: 'never-return-this-hash',
            },
          },
        ]),
      },
    };
    const repository = new RsvpsRepository(database as unknown as PrismaService);

    const result = await repository.listMine(userId);

    expect(database.rsvp.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId,
          status: { in: [RsvpStatus.GOING, RsvpStatus.WAITLISTED] },
          event: { deletedAt: null },
        },
        include: expect.objectContaining({
          ticket: { select: { status: true, expiresAt: true } },
        }),
      }),
    );
    expect(result.data[0]).toMatchObject({
      id: rsvpId,
      status: RsvpStatus.GOING,
      event: { id: eventId, title: 'Campus Showcase', rejectionReason: null, hasImage: false },
      ticket: { status: TicketStatus.ISSUED, expiresAt },
    });
    expect(JSON.stringify(result)).not.toContain('never-return-this-hash');
  });
});
