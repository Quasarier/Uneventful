import { EventStatus, RsvpStatus, TicketStatus } from '../generated/prisma/client';
import { PrismaService } from '../src/database/prisma.service';
import { RsvpsRepository } from '../src/rsvps/rsvps.repository';
import { validateEnvironment, type Environment } from '../src/config/environment';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const appDatabaseUrl = process.env.TEST_DATABASE_URL;
const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;

if (!appDatabaseUrl || !migrationDatabaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL and TEST_MIGRATION_DATABASE_URL are required for RSVP integration tests.',
  );
}

function configFor(databaseUrl: string): ConfigService<Environment, true> {
  const environment = validateEnvironment({
    NODE_ENV: 'test',
    PORT: 3001,
    DATABASE_URL: databaseUrl,
    REDIS_URL: 'redis://localhost:6379',
    GOOGLE_CLIENT_ID: 'rsvp-integration-client',
    GOOGLE_CLIENT_SECRET: 'rsvp-integration-secret',
    GOOGLE_CALLBACK_URL: 'http://localhost:3001/api/v1/auth/google/callback',
    UNIVERSITY_EMAIL_DOMAIN: 'example.edu',
    WEB_ORIGIN: 'http://localhost:3000',
    SESSION_SECRET: `${randomUUID()}${randomUUID()}`,
    JWT_PRIVATE_KEY_B64: Buffer.from('unused-private-key').toString('base64'),
    JWT_PUBLIC_KEY_B64: Buffer.from('unused-public-key').toString('base64'),
    JWT_KEY_ID: 'rsvp-integration-key',
    JWT_ISSUER: 'https://api.uneventful.test',
    JWT_AUDIENCE: 'uneventful-api',
    REFRESH_TOKEN_TTL_DAYS: 30,
    OBJECT_STORAGE_BUCKET: 'rsvp-integration',
    OBJECT_STORAGE_REGION: 'us-east-1',
  });
  return new ConfigService<Environment, true>(environment);
}

let appPrisma: PrismaService;
let migrationPrisma: PrismaService;
let repository: RsvpsRepository;
let adminId: string;
let studentIds: string[] = [];
let userIds: string[] = [];
let eventIds: string[] = [];
let primaryEventId: string;
let clubId: string;
let categoryId: string;
let startAt: Date;
let endAt: Date;

describe('RSVP PostgreSQL concurrency integration', () => {
  beforeAll(async () => {
    appPrisma = new PrismaService(configFor(appDatabaseUrl!));
    migrationPrisma = new PrismaService(configFor(migrationDatabaseUrl!));
    await Promise.all([appPrisma.$connect(), migrationPrisma.$connect()]);
    repository = new RsvpsRepository(appPrisma);
  });

  beforeEach(async () => {
    adminId = randomUUID();
    studentIds = Array.from({ length: 200 }, () => randomUUID());
    userIds = [adminId, ...studentIds];
    await appPrisma.user.create({
      data: {
        id: adminId,
        email: `${adminId}@example.edu`,
        googleSubject: adminId,
        firstName: 'RSVP',
        lastName: 'Admin',
        role: 'ADMIN',
      },
    });
    await appPrisma.user.createMany({
      data: studentIds.map((id, index) => ({
        id,
        email: `${id}@example.edu`,
        googleSubject: id,
        firstName: `Student${index}`,
        lastName: 'Integration',
        role: 'STUDENT',
      })),
    });

    clubId = randomUUID();
    categoryId = randomUUID();
    await appPrisma.club.create({
      data: {
        id: clubId,
        name: `RSVP Integration ${clubId}`,
        slug: `rsvp-${clubId}`,
        createdById: adminId,
      },
    });
    await appPrisma.eventCategory.create({
      data: {
        id: categoryId,
        name: `RSVP Category ${categoryId}`,
        slug: `rsvp-category-${categoryId}`,
      },
    });

    startAt = new Date(Date.now() + 60 * 60 * 1_000);
    endAt = new Date(startAt.getTime() + 2 * 60 * 60 * 1_000);
    eventIds = [];
    primaryEventId = await createEvent(50);
  });

  afterEach(async () => {
    if (eventIds.length > 0) {
      await migrationPrisma.rsvpPromotionOutbox.deleteMany({
        where: { eventId: { in: eventIds } },
      });
      await migrationPrisma.notification.deleteMany({
        where: { eventId: { in: eventIds } },
      });
      const rsvps = await migrationPrisma.rsvp.findMany({
        where: { eventId: { in: eventIds } },
        select: { id: true },
      });
      const rsvpIds = rsvps.map((rsvp) => rsvp.id);
      if (rsvpIds.length > 0) {
        await migrationPrisma.ticket.deleteMany({ where: { rsvpId: { in: rsvpIds } } });
        await migrationPrisma.rsvp.deleteMany({ where: { id: { in: rsvpIds } } });
      }
      await migrationPrisma.event.deleteMany({ where: { id: { in: eventIds } } });
      await migrationPrisma.eventCategory.deleteMany({ where: { id: categoryId } });
      await migrationPrisma.club.deleteMany({ where: { id: clubId } });
      await migrationPrisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    eventIds = [];
    userIds = [];
    studentIds = [];
  });

  afterAll(async () => {
    await Promise.all([appPrisma?.$disconnect(), migrationPrisma?.$disconnect()]);
  });

  it('admits exactly 50 of 200 simultaneous RSVPs at capacity 50', async () => {
    const responses = await Promise.allSettled(
      studentIds.map((userId) => repository.rsvp(primaryEventId, userId, false)),
    );

    expect(responses.filter((response) => response.status === 'fulfilled')).toHaveLength(200);
    expect(
      await appPrisma.rsvp.count({ where: { eventId: primaryEventId, status: 'GOING' } }),
    ).toBe(50);
    expect(
      await appPrisma.rsvp.count({ where: { eventId: primaryEventId, status: 'WAITLISTED' } }),
    ).toBe(150);
    const positions = await appPrisma.rsvp.findMany({
      where: { eventId: primaryEventId, status: 'WAITLISTED' },
      select: { waitlistPosition: true },
      orderBy: { waitlistPosition: 'asc' },
    });
    expect(positions.map((entry) => entry.waitlistPosition)).toEqual(
      Array.from({ length: 150 }, (_, index) => index + 1),
    );
  }, 60_000);

  it('rejects duplicate RSVPs, blocks opted-in conflicts, and rejects ended events', async () => {
    await repository.rsvp(primaryEventId, studentId(0), false);
    await expect(repository.rsvp(primaryEventId, studentId(0), false)).rejects.toThrow(
      'already have an RSVP',
    );

    const overlapId = await createEvent(10);
    const overlap = await appPrisma.event.update({
      where: { id: overlapId },
      data: {
        startAt: new Date(startAt.getTime() + 30 * 60 * 1_000),
        endAt: new Date(endAt.getTime() + 30 * 60 * 1_000),
      },
    });
    expect(overlap.status).toBe(EventStatus.APPROVED);
    await expect(repository.rsvp(overlapId, studentId(0), true)).rejects.toThrow(
      'overlaps another event',
    );
    await expect(repository.rsvp(overlapId, studentId(0), false)).resolves.toMatchObject({
      status: RsvpStatus.GOING,
    });

    await appPrisma.event.update({
      where: { id: primaryEventId },
      data: {
        startAt: new Date(Date.now() - 2 * 60 * 60 * 1_000),
        endAt: new Date(Date.now() - 60 * 60 * 1_000),
      },
    });
    await expect(repository.rsvp(primaryEventId, studentId(1), false)).rejects.toThrow(
      'no longer accepting RSVPs',
    );
  });

  it('cancels a confirmed RSVP and promotes the oldest waiter with a ticket and notification', async () => {
    await appPrisma.event.update({
      where: { id: primaryEventId },
      data: { capacity: 2 },
    });
    const first = await repository.rsvp(primaryEventId, studentId(0), false);
    const second = await repository.rsvp(primaryEventId, studentId(1), false);
    const firstWaiter = await repository.rsvp(primaryEventId, studentId(2), false);
    const secondWaiter = await repository.rsvp(primaryEventId, studentId(3), false);
    expect(first.status).toBe(RsvpStatus.GOING);
    expect(second.status).toBe(RsvpStatus.GOING);
    expect(firstWaiter).toMatchObject({ status: RsvpStatus.WAITLISTED, waitlistPosition: 1 });
    expect(secondWaiter).toMatchObject({ status: RsvpStatus.WAITLISTED, waitlistPosition: 2 });

    const firstTicket = await appPrisma.ticket.findUniqueOrThrow({
      where: { rsvpId: first.id },
    });
    expect(firstTicket.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await repository.cancel(primaryEventId, studentId(0))).toMatchObject({
      status: RsvpStatus.CANCELLED,
    });
    expect(await repository.cancel(primaryEventId, studentId(1))).toMatchObject({
      status: RsvpStatus.CANCELLED,
    });
    expect((await appPrisma.ticket.findUniqueOrThrow({ where: { rsvpId: first.id } })).status).toBe(
      TicketStatus.REVOKED,
    );
    expect(
      (await appPrisma.ticket.findUniqueOrThrow({ where: { rsvpId: second.id } })).status,
    ).toBe(TicketStatus.REVOKED);
    const later = await repository.rsvp(primaryEventId, studentId(4), false);
    expect(later).toMatchObject({ status: RsvpStatus.WAITLISTED, waitlistPosition: 3 });

    const outboxes = await appPrisma.rsvpPromotionOutbox.findMany({
      where: { eventId: primaryEventId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(outboxes).toHaveLength(2);
    const firstOutbox = outboxes[0];
    const secondOutbox = outboxes[1];
    if (!firstOutbox || !secondOutbox) {
      throw new Error('Expected two RSVP promotion outbox records.');
    }

    await repository.promoteNextWaitlisted(primaryEventId, firstOutbox.id);
    await repository.promoteNextWaitlisted(primaryEventId, firstOutbox.id);

    const cancelledRsvp = await appPrisma.rsvp.findUniqueOrThrow({
      where: { eventId_userId: { eventId: primaryEventId, userId: studentId(1) } },
    });
    expect(cancelledRsvp.status).toBe(RsvpStatus.CANCELLED);
    const promotedWaiter = await appPrisma.rsvp.findUniqueOrThrow({
      where: { eventId_userId: { eventId: primaryEventId, userId: studentId(2) } },
    });
    expect(promotedWaiter.status).toBe(RsvpStatus.GOING);
    expect(promotedWaiter.waitlistPosition).toBeNull();
    const promotedTicket = await appPrisma.ticket.findUniqueOrThrow({
      where: { rsvpId: promotedWaiter.id },
    });
    expect(promotedTicket.status).toBe(TicketStatus.ISSUED);
    expect(promotedTicket.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await appPrisma.rsvp.findUniqueOrThrow({
        where: { eventId_userId: { eventId: primaryEventId, userId: studentId(3) } },
      }),
    ).toMatchObject({ status: RsvpStatus.WAITLISTED, waitlistPosition: 2 });
    expect(
      await appPrisma.notification.count({
        where: { dedupeKey: `rsvp-promoted:${firstOutbox.id}` },
      }),
    ).toBe(1);

    await repository.promoteNextWaitlisted(primaryEventId, secondOutbox.id);
    expect(
      await appPrisma.rsvp.findUniqueOrThrow({
        where: { eventId_userId: { eventId: primaryEventId, userId: studentId(3) } },
      }),
    ).toMatchObject({ status: RsvpStatus.GOING, waitlistPosition: null });
    expect(
      await appPrisma.notification.count({
        where: { userId: studentId(3), eventId: primaryEventId, type: 'RSVP_CONFIRMED' },
      }),
    ).toBe(1);
  });
});

async function createEvent(capacity: number): Promise<string> {
  const id = randomUUID();
  await appPrisma.event.create({
    data: {
      id,
      title: `RSVP Fixture ${id}`,
      slug: `rsvp-fixture-${id}`,
      description: 'RSVP integration fixture',
      status: EventStatus.APPROVED,
      startAt,
      endAt,
      timeZone: 'UTC',
      capacity,
      isPublic: true,
      clubId,
      categoryId,
      createdById: adminId,
      approvedById: adminId,
      approvedAt: new Date(),
    },
  });
  eventIds.push(id);
  return id;
}

function studentId(index: number): string {
  const id = studentIds.find((_studentId, studentIndex) => studentIndex === index);
  if (!id) {
    throw new Error(`Missing RSVP integration student at index ${index}.`);
  }
  return id;
}
