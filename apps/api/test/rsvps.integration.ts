import { ConfigService } from '@nestjs/config';
import {
  Module,
  ValidationPipe,
  type INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import type { Job } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { EventStatus, RsvpStatus, TicketStatus } from '../generated/prisma/client';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import type { AuthPrincipal } from '../src/auth/auth.types';
import { AuthService } from '../src/auth/auth.service';
import { GlobalApiRateLimitGuard } from '../src/auth/global-api-rate-limit.guard';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { HttpExceptionFilter } from '../src/http-exception.filter';
import { PrismaService } from '../src/database/prisma.service';
import { CreateRsvpDto } from '../src/rsvps/dto/create-rsvp.dto';
import { ListEventAttendeesDto } from '../src/rsvps/dto/list-event-attendees.dto';
import { MyRsvpsController } from '../src/rsvps/my-rsvps.controller';
import { RSVP_PROMOTION_JOB } from '../src/rsvps/rsvp-queue.constants';
import { RsvpPromotionProcessor } from '../src/rsvps/rsvp-promotion.processor';
import { RsvpsController } from '../src/rsvps/rsvps.controller';
import { RsvpsRepository } from '../src/rsvps/rsvps.repository';
import { RsvpsService } from '../src/rsvps/rsvps.service';
import { validateEnvironment, type Environment } from '../src/config/environment';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const appDatabaseUrl = process.env.TEST_DATABASE_URL;
const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

if (!appDatabaseUrl || !migrationDatabaseUrl || !redisUrl) {
  throw new Error(
    'TEST_DATABASE_URL, TEST_MIGRATION_DATABASE_URL, and TEST_REDIS_URL are required for RSVP integration tests.',
  );
}

function configFor(databaseUrl: string, rateLimit = 10): ConfigService<Environment, true> {
  const environment = validateEnvironment({
    NODE_ENV: 'test',
    PORT: 3001,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    RSVP_RATE_LIMIT_PER_MINUTE: rateLimit,
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
let rateLimitService: AuthRateLimitService;
let httpApp: INestApplication | undefined;
let httpBaseUrl: string;
let organizerId: string;
let otherOrganizerId: string;
let adminId: string;
let studentIds: string[] = [];
let userIds: string[] = [];
let eventIds: string[] = [];
let primaryEventId: string;
let clubId: string;
let otherClubId: string;
let clubIds: string[] = [];
let categoryId: string;
let startAt: Date;
let endAt: Date;
let activePrisma: PrismaService;
const principals = new Map<string, AuthPrincipal>();

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, CreateRsvpDto],
  RsvpsController.prototype,
  'rsvp',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, ListEventAttendeesDto],
  RsvpsController.prototype,
  'listAttendees',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [RsvpsService, AuthRateLimitService, ConfigService],
  RsvpsController,
);

const authStub = {
  authenticateAccessToken: async (token: string): Promise<AuthPrincipal> => {
    const principal = principals.get(token);
    if (!principal) {
      throw new UnauthorizedException('Unknown RSVP integration-test bearer token.');
    }
    return principal;
  },
};

@Module({
  controllers: [RsvpsController, MyRsvpsController],
  providers: [
    {
      provide: RsvpsRepository,
      useFactory: () => new RsvpsRepository(activePrisma),
    },
    {
      provide: RsvpsService,
      useFactory: (repo: RsvpsRepository) => new RsvpsService(repo),
      inject: [RsvpsRepository],
    },
    { provide: AuthRateLimitService, useFactory: () => rateLimitService },
    { provide: AuthService, useValue: authStub },
    { provide: ConfigService, useFactory: () => configFor(appDatabaseUrl!) },
  ],
})
class RsvpHttpIntegrationModule {}

describe('RSVP PostgreSQL concurrency integration', () => {
  beforeAll(async () => {
    appPrisma = new PrismaService(configFor(appDatabaseUrl!));
    migrationPrisma = new PrismaService(configFor(migrationDatabaseUrl!));
    await Promise.all([appPrisma.$connect(), migrationPrisma.$connect()]);
    repository = new RsvpsRepository(appPrisma);
    activePrisma = appPrisma;

    const redis = new Redis(redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    await redis.ping();
    rateLimitService = new AuthRateLimitService(redis);

    httpApp = await NestFactory.create(RsvpHttpIntegrationModule, { logger: false });
    httpApp.setGlobalPrefix('api/v1');
    httpApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    httpApp.useGlobalFilters(new HttpExceptionFilter());
    const reflector = httpApp.get(Reflector);
    httpApp.useGlobalGuards(
      new JwtAuthGuard(
        reflector,
        httpApp.get(AuthService),
        rateLimitService,
        configFor(appDatabaseUrl!),
      ),
      new GlobalApiRateLimitGuard(rateLimitService, reflector, configFor(appDatabaseUrl!)),
      new RolesGuard(reflector),
    );
    await httpApp.listen(0, '127.0.0.1');
    const address = httpApp.getHttpServer().address();
    if (!address || typeof address === 'string') {
      throw new Error('Could not determine RSVP integration server address.');
    }
    httpBaseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  });

  beforeEach(async () => {
    adminId = randomUUID();
    organizerId = randomUUID();
    otherOrganizerId = randomUUID();
    studentIds = Array.from({ length: 200 }, () => randomUUID());
    userIds = [adminId, organizerId, otherOrganizerId, ...studentIds];
    principals.clear();
    principals.set(adminId, { id: adminId, role: 'ADMIN', tokenVersion: 0 });
    principals.set(organizerId, { id: organizerId, role: 'ORGANIZER', tokenVersion: 0 });
    principals.set(otherOrganizerId, {
      id: otherOrganizerId,
      role: 'ORGANIZER',
      tokenVersion: 0,
    });
    for (const id of studentIds) {
      principals.set(id, { id, role: 'STUDENT', tokenVersion: 0 });
    }
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
    await appPrisma.user.create({
      data: {
        id: otherOrganizerId,
        email: `${otherOrganizerId}@example.edu`,
        googleSubject: otherOrganizerId,
        firstName: 'Other',
        lastName: 'Organizer',
        role: 'ORGANIZER',
      },
    });
    await appPrisma.user.create({
      data: {
        id: organizerId,
        email: `${organizerId}@example.edu`,
        googleSubject: organizerId,
        firstName: 'RSVP',
        lastName: 'Organizer',
        role: 'ORGANIZER',
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
    otherClubId = randomUUID();
    clubIds = [clubId, otherClubId];
    categoryId = randomUUID();
    await appPrisma.club.create({
      data: {
        id: clubId,
        name: `RSVP Integration ${clubId}`,
        slug: `rsvp-${clubId}`,
        createdById: adminId,
      },
    });
    await appPrisma.club.create({
      data: {
        id: otherClubId,
        name: `Other RSVP Integration ${otherClubId}`,
        slug: `other-rsvp-${otherClubId}`,
        createdById: adminId,
      },
    });
    await appPrisma.clubMembership.create({
      data: {
        clubId: otherClubId,
        userId: otherOrganizerId,
        role: 'PRESIDENT',
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
    });
    await appPrisma.clubMembership.create({
      data: {
        clubId,
        userId: organizerId,
        role: 'PRESIDENT',
        status: 'ACTIVE',
        joinedAt: new Date(),
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
      await migrationPrisma.clubMembership.deleteMany({ where: { clubId: { in: clubIds } } });
      await migrationPrisma.club.deleteMany({ where: { id: { in: clubIds } } });
      await migrationPrisma.user.deleteMany({
        where: {
          id: { in: userIds, notIn: [adminId, organizerId] },
        },
      });
    }
    eventIds = [];
    userIds = [];
    studentIds = [];
  });

  afterAll(async () => {
    await httpApp?.close();
    rateLimitService?.onModuleDestroy();
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

  it('retries an interrupted promotion after worker restart without double-promoting or skipping waiters', async () => {
    await appPrisma.event.update({
      where: { id: primaryEventId },
      data: { capacity: 1 },
    });
    await repository.rsvp(primaryEventId, studentId(0), false);
    const firstWaiter = await repository.rsvp(primaryEventId, studentId(1), false);
    const secondWaiter = await repository.rsvp(primaryEventId, studentId(2), false);
    await repository.cancel(primaryEventId, studentId(0));
    const outbox = await appPrisma.rsvpPromotionOutbox.findFirstOrThrow({
      where: { eventId: primaryEventId },
    });

    await migrationPrisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_interrupt_rsvp_promotion_notification()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."dedupe_key" LIKE 'rsvp-promoted:%' THEN
          RAISE EXCEPTION 'simulated worker interruption';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await migrationPrisma.$executeRawUnsafe(`
      CREATE TRIGGER test_interrupt_rsvp_promotion_notification
      BEFORE INSERT ON "notifications"
      FOR EACH ROW
      EXECUTE FUNCTION test_interrupt_rsvp_promotion_notification()
    `);

    const job = {
      name: RSVP_PROMOTION_JOB,
      data: { eventId: primaryEventId, outboxId: outbox.id },
    } as Job<{ eventId: string; outboxId: string }>;
    const workerBeforeRestart = new RsvpPromotionProcessor(repository);
    try {
      await expect(workerBeforeRestart.process(job)).rejects.toThrow(
        'simulated worker interruption',
      );
    } finally {
      await migrationPrisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS test_interrupt_rsvp_promotion_notification ON "notifications"',
      );
      await migrationPrisma.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS test_interrupt_rsvp_promotion_notification()',
      );
    }

    expect(
      await appPrisma.rsvp.findUniqueOrThrow({
        where: { id: firstWaiter.id },
      }),
    ).toMatchObject({ status: RsvpStatus.WAITLISTED, waitlistPosition: 1 });
    expect(
      await appPrisma.rsvp.findUniqueOrThrow({
        where: { id: secondWaiter.id },
      }),
    ).toMatchObject({ status: RsvpStatus.WAITLISTED, waitlistPosition: 2 });
    expect(await appPrisma.ticket.count({ where: { rsvpId: firstWaiter.id } })).toBe(0);
    expect(
      await appPrisma.rsvpPromotionOutbox.findUniqueOrThrow({
        where: { id: outbox.id },
      }),
    ).toMatchObject({ processedAt: null });

    const restartedWorker = new RsvpPromotionProcessor(new RsvpsRepository(appPrisma));
    await restartedWorker.process(job);
    await restartedWorker.process(job);

    expect(await appPrisma.rsvp.findUniqueOrThrow({ where: { id: firstWaiter.id } })).toMatchObject(
      { status: RsvpStatus.GOING, waitlistPosition: null },
    );
    expect(
      await appPrisma.rsvp.findUniqueOrThrow({ where: { id: secondWaiter.id } }),
    ).toMatchObject({ status: RsvpStatus.WAITLISTED, waitlistPosition: 2 });
    expect(
      await appPrisma.rsvp.count({
        where: {
          eventId: primaryEventId,
          status: { in: [RsvpStatus.GOING, RsvpStatus.CHECKED_IN] },
        },
      }),
    ).toBe(1);
    const promotedTicket = await appPrisma.ticket.findUniqueOrThrow({
      where: { rsvpId: firstWaiter.id },
    });
    expect(promotedTicket).toMatchObject({ status: TicketStatus.ISSUED });
    expect(promotedTicket.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await appPrisma.notification.count({
        where: { dedupeKey: `rsvp-promoted:${outbox.id}` },
      }),
    ).toBe(1);
  });

  it('serializes a concurrent cancellation and RSVP without exceeding capacity or stranding the oldest waiter', async () => {
    await appPrisma.event.update({
      where: { id: primaryEventId },
      data: { capacity: 1 },
    });
    await repository.rsvp(primaryEventId, studentId(0), false);
    await repository.rsvp(primaryEventId, studentId(1), false);

    const [cancelled, newcomer] = await Promise.all([
      repository.cancel(primaryEventId, studentId(0)),
      repository.rsvp(primaryEventId, studentId(2), false),
    ]);

    expect(cancelled.status).toBe(RsvpStatus.CANCELLED);
    expect(newcomer.status).toBe(RsvpStatus.WAITLISTED);
    const outboxes = await appPrisma.rsvpPromotionOutbox.findMany({
      where: { eventId: primaryEventId, processedAt: null },
    });
    expect(outboxes).toHaveLength(1);
    for (const outbox of outboxes) {
      await repository.promoteNextWaitlisted(primaryEventId, outbox.id);
    }

    const goingCount = await appPrisma.rsvp.count({
      where: {
        eventId: primaryEventId,
        status: { in: [RsvpStatus.GOING, RsvpStatus.CHECKED_IN] },
      },
    });
    expect(goingCount).toBe(1);
    expect(
      await appPrisma.rsvp.findUniqueOrThrow({
        where: { eventId_userId: { eventId: primaryEventId, userId: studentId(1) } },
      }),
    ).toMatchObject({ status: RsvpStatus.GOING, waitlistPosition: null });
    expect(
      await appPrisma.rsvp.findUniqueOrThrow({
        where: { eventId_userId: { eventId: primaryEventId, userId: studentId(2) } },
      }),
    ).toMatchObject({ status: RsvpStatus.WAITLISTED });
    expect(goingCount).toBeLessThanOrEqual(1);
  });

  it('reuses the RSVP row and assigns GOING when open or the FIFO tail when full', async () => {
    await appPrisma.event.update({
      where: { id: primaryEventId },
      data: { capacity: 2 },
    });
    const originalGoing = await repository.rsvp(primaryEventId, studentId(0), false);
    await repository.cancel(primaryEventId, studentId(0));
    const reRsvpGoing = await repository.rsvp(primaryEventId, studentId(0), false);

    expect(reRsvpGoing.id).toBe(originalGoing.id);
    expect(reRsvpGoing.status).toBe(RsvpStatus.GOING);
    expect(
      await appPrisma.rsvp.count({
        where: { eventId: primaryEventId, userId: studentId(0) },
      }),
    ).toBe(1);

    const fullEventId = await createEvent(1);
    const originalFullRsvp = await repository.rsvp(fullEventId, studentId(3), false);
    const firstWaiter = await repository.rsvp(fullEventId, studentId(4), false);
    await repository.cancel(fullEventId, studentId(3));
    const returningWaiter = await repository.rsvp(fullEventId, studentId(3), false);

    expect(firstWaiter).toMatchObject({
      status: RsvpStatus.WAITLISTED,
      waitlistPosition: 1,
    });
    expect(returningWaiter.id).toBe(originalFullRsvp.id);
    expect(returningWaiter).toMatchObject({
      status: RsvpStatus.WAITLISTED,
      waitlistPosition: 2,
    });
    expect(
      await appPrisma.rsvp.count({
        where: { eventId: fullEventId, userId: studentId(3) },
      }),
    ).toBe(1);
  });

  it('masks hidden and unknown RSVP targets identically across create, cancel, and status', async () => {
    const pastStart = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    const pastEnd = new Date(Date.now() - 60 * 60 * 1_000);
    const hiddenIds = [
      await createEvent(5, EventStatus.DRAFT),
      await createEvent(5, EventStatus.PENDING_APPROVAL),
      await createEvent(5, EventStatus.REJECTED),
      await createEvent(5, EventStatus.APPROVED, startAt, endAt, false),
    ];
    const privateEventWithExistingRsvp = await createEvent(5);
    await repository.rsvp(privateEventWithExistingRsvp, studentId(9), false);
    await appPrisma.event.update({
      where: { id: privateEventWithExistingRsvp },
      data: { isPublic: false },
    });
    hiddenIds.push(privateEventWithExistingRsvp);

    const routeCases = [
      {
        method: 'POST' as const,
        path: (eventId: string) => `/events/${eventId}/rsvp`,
        firstUserIndex: 0,
      },
      {
        method: 'DELETE' as const,
        path: (eventId: string) => `/events/${eventId}/rsvp`,
        firstUserIndex: 10,
      },
      {
        method: 'GET' as const,
        path: (eventId: string) => `/events/${eventId}/rsvp/status`,
        firstUserIndex: 20,
      },
    ];

    for (const route of routeCases) {
      const eventIds = [...hiddenIds, randomUUID()];
      const responses = await Promise.all(
        eventIds.map(async (eventId, index) => {
          const userId =
            route.method === 'DELETE' && eventId === privateEventWithExistingRsvp
              ? studentId(9)
              : studentId(route.firstUserIndex + index);
          const startedAt = performance.now();
          const response = await requestAs(
            userId,
            route.method,
            route.path(eventId),
            route.method === 'POST' ? {} : undefined,
          );
          const durationMs = performance.now() - startedAt;
          const body = await response.json();
          const headers = Object.fromEntries(
            [...response.headers.entries()]
              .filter(([name]) => name.toLowerCase() !== 'date')
              .sort(([left], [right]) => left.localeCompare(right)),
          );
          return { status: response.status, body, headers, durationMs };
        }),
      );

      const unknownResponse = responses[responses.length - 1]!;
      expect(unknownResponse).toMatchObject({
        status: 404,
        body: { statusCode: 404, code: 'NOT_FOUND', message: 'Event not found.' },
      });
      for (const hiddenResponse of responses.slice(0, -1)) {
        expect({
          status: hiddenResponse.status,
          body: hiddenResponse.body,
          headers: hiddenResponse.headers,
        }).toEqual({
          status: unknownResponse.status,
          body: unknownResponse.body,
          headers: unknownResponse.headers,
        });
        expect(Math.abs(hiddenResponse.durationMs - unknownResponse.durationMs)).toBeLessThan(150);
      }
    }

    const memberPrivateEvent = await createEvent(5, EventStatus.APPROVED, startAt, endAt, false);
    await appPrisma.clubMembership.create({
      data: {
        clubId,
        userId: studentId(30),
        role: 'MEMBER',
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
    });
    const memberRsvp = await requestAs(
      studentId(30),
      'POST',
      `/events/${memberPrivateEvent}/rsvp`,
      {},
    );
    expect(memberRsvp.status).toBe(201);

    const visiblePastEvent = await createEvent(5, EventStatus.APPROVED, pastStart, endAt);
    const pastCreate = await requestAs(
      studentId(31),
      'POST',
      `/events/${visiblePastEvent}/rsvp`,
      {},
    );
    expect(pastCreate.status).toBe(409);
    await expect(pastCreate.json()).resolves.toMatchObject({
      statusCode: 409,
      message: 'This event is no longer accepting RSVPs.',
    });

    const endedEvent = await createEvent(5, EventStatus.APPROVED, pastStart, pastEnd);
    const pastStatus = await requestAs(studentId(32), 'GET', `/events/${endedEvent}/rsvp/status`);
    expect(pastStatus.status).toBe(409);
    await expect(pastStatus.json()).resolves.toMatchObject({
      statusCode: 409,
      message: 'This event is no longer accepting RSVPs.',
    });

    const cancelEvent = await createEvent(5);
    await repository.rsvp(cancelEvent, studentId(33), false);
    await appPrisma.event.update({
      where: { id: cancelEvent },
      data: { startAt: pastStart },
    });
    const pastCancel = await requestAs(studentId(33), 'DELETE', `/events/${cancelEvent}/rsvp`);
    expect(pastCancel.status).toBe(409);
    await expect(pastCancel.json()).resolves.toMatchObject({
      statusCode: 409,
      message: 'RSVP cancellation is not allowed after the event starts.',
    });
  });

  it('lets a club organizer list and filter attendee display names with the allowlisted fields', async () => {
    await appPrisma.event.update({
      where: { id: primaryEventId },
      data: { capacity: 1 },
    });
    await repository.rsvp(primaryEventId, studentId(0), false);
    await repository.rsvp(primaryEventId, studentId(1), false);

    const response = await requestAs(organizerId, 'GET', `/events/${primaryEventId}/attendees`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body).toMatchObject({
      page: 1,
      limit: 20,
      total: 2,
      data: [
        { displayName: 'Student0 Integration', status: RsvpStatus.GOING, waitlistPosition: null },
        {
          displayName: 'Student1 Integration',
          status: RsvpStatus.WAITLISTED,
          waitlistPosition: 1,
        },
      ],
    });
    for (const attendee of body.data) {
      expect(Object.keys(attendee).sort()).toEqual(['displayName', 'status', 'waitlistPosition']);
    }
    expect(JSON.stringify(body)).not.toMatch(
      /@example\.edu|userId|tokenVersion|ticketToken|tokenHash|rsvpId|"id"/i,
    );

    const filtered = await requestAs(
      organizerId,
      'GET',
      `/events/${primaryEventId}/attendees?status=WAITLISTED`,
    );
    expect(filtered.status).toBe(200);
    await expect(filtered.json()).resolves.toMatchObject({
      total: 1,
      data: [
        {
          displayName: 'Student1 Integration',
          status: RsvpStatus.WAITLISTED,
          waitlistPosition: 1,
        },
      ],
    });
  });

  it('masks attendee access from organizers who are not members of the event club', async () => {
    const response = await requestAs(
      otherOrganizerId,
      'GET',
      `/events/${primaryEventId}/attendees`,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Event not found.',
    });
  });

  it('masks attendee access from students', async () => {
    const response = await requestAs(studentId(0), 'GET', `/events/${primaryEventId}/attendees`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Event not found.',
    });
  });

  it('revokes attendee-list access immediately after club membership removal', async () => {
    const beforeRemoval = await requestAs(
      organizerId,
      'GET',
      `/events/${primaryEventId}/attendees`,
    );
    expect(beforeRemoval.status).toBe(200);

    await appPrisma.clubMembership.delete({
      where: { clubId_userId: { clubId, userId: organizerId } },
    });

    const afterRemoval = await requestAs(organizerId, 'GET', `/events/${primaryEventId}/attendees`);
    expect(afterRemoval.status).toBe(404);
    await expect(afterRemoval.json()).resolves.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Event not found.',
    });
  });

  it('returns identical masked responses for hidden and unknown attendee event IDs', async () => {
    const hiddenEvent = await createEvent(
      5,
      EventStatus.APPROVED,
      startAt,
      endAt,
      true,
      otherClubId,
    );
    const [hidden, unknown] = await Promise.all([
      requestAs(organizerId, 'GET', `/events/${hiddenEvent}/attendees`),
      requestAs(organizerId, 'GET', `/events/${randomUUID()}/attendees`),
    ]);

    const hiddenBody = await hidden.json();
    const unknownBody = await unknown.json();
    const responseHeaders = (response: Response) =>
      Object.fromEntries(
        [...response.headers.entries()]
          .filter(([name]) => name.toLowerCase() !== 'date')
          .sort(([left], [right]) => left.localeCompare(right)),
      );
    expect(hidden.status).toBe(404);
    expect(hiddenBody).toEqual(unknownBody);
    expect(responseHeaders(hidden)).toEqual(responseHeaders(unknown));
  });

  it('caps attendee page size at 100 and keeps pages stable', async () => {
    const eventId = await createEvent(150);
    await appPrisma.rsvp.createMany({
      data: studentIds.slice(0, 105).map((userId, index) => ({
        eventId,
        userId,
        status: RsvpStatus.GOING,
        createdAt: new Date(Date.now() + index),
      })),
    });

    const firstPage = await requestAs(
      organizerId,
      'GET',
      `/events/${eventId}/attendees?limit=1000`,
    );
    expect(firstPage.status).toBe(200);
    const firstBody = await firstPage.json();
    expect(firstBody).toMatchObject({ page: 1, limit: 100, total: 105 });
    expect(firstBody.data).toHaveLength(100);

    const secondPage = await requestAs(
      organizerId,
      'GET',
      `/events/${eventId}/attendees?page=2&limit=1000`,
    );
    expect(secondPage.status).toBe(200);
    await expect(secondPage.json()).resolves.toMatchObject({
      page: 2,
      limit: 100,
      total: 105,
      data: expect.arrayContaining([
        expect.objectContaining({ displayName: 'Student104 Integration' }),
      ]),
    });
  });

  it('returns 429 with Retry-After when attendee requests exceed the per-user limit', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await requestAs(organizerId, 'GET', `/events/${primaryEventId}/attendees`);
      expect(response.status).toBe(200);
    }

    const limited = await requestAs(organizerId, 'GET', `/events/${primaryEventId}/attendees`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  });

  it('audits attendee-list reads with the actor, event, and timestamp', async () => {
    const response = await requestAs(organizerId, 'GET', `/events/${primaryEventId}/attendees`);
    expect(response.status).toBe(200);

    const audit = await migrationPrisma.auditLog.findFirstOrThrow({
      where: {
        actorId: organizerId,
        action: 'EVENT_ATTENDEES_VIEWED',
        entityType: 'Event',
        entityId: primaryEventId,
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.actorId).toBe(organizerId);
    expect(audit.entityId).toBe(primaryEventId);
    expect(audit.createdAt).toBeInstanceOf(Date);
  });

  it('hides cancelled attendees from organizers and includes them only for an admin filter', async () => {
    const rsvp = await repository.rsvp(primaryEventId, studentId(0), false);
    await repository.cancel(primaryEventId, studentId(0));

    const organizerDefault = await requestAs(
      organizerId,
      'GET',
      `/events/${primaryEventId}/attendees`,
    );
    await expect(organizerDefault.json()).resolves.toMatchObject({ data: [], total: 0 });

    const organizerCancelled = await requestAs(
      organizerId,
      'GET',
      `/events/${primaryEventId}/attendees?status=CANCELLED`,
    );
    await expect(organizerCancelled.json()).resolves.toMatchObject({ data: [], total: 0 });

    const adminCancelled = await requestAs(
      adminId,
      'GET',
      `/events/${primaryEventId}/attendees?status=CANCELLED`,
    );
    expect(adminCancelled.status).toBe(200);
    await expect(adminCancelled.json()).resolves.toMatchObject({
      total: 1,
      data: [
        {
          displayName: 'Student0 Integration',
          status: RsvpStatus.CANCELLED,
          waitlistPosition: null,
        },
      ],
    });
    expect(rsvp.status).toBe(RsvpStatus.GOING);
  });

  it('prevents one student from reading, cancelling, or changing another student RSVP', async () => {
    const owned = await repository.rsvp(primaryEventId, studentId(0), false);

    const otherStatusResponse = await requestAs(
      studentId(1),
      'GET',
      `/events/${primaryEventId}/rsvp/status`,
    );
    expect(otherStatusResponse.status).toBe(200);
    const otherStatus = await otherStatusResponse.json();
    expect(otherStatus).toMatchObject({ status: null, waitlistPosition: null });
    expect(JSON.stringify(otherStatus)).not.toContain(studentId(0));
    expect(JSON.stringify(otherStatus)).not.toContain(owned.id);

    const otherCancel = await requestAs(studentId(1), 'DELETE', `/events/${primaryEventId}/rsvp`);
    expect(otherCancel.status).toBe(404);
    expect(
      await appPrisma.rsvp.findUniqueOrThrow({
        where: { eventId_userId: { eventId: primaryEventId, userId: studentId(0) } },
      }),
    ).toMatchObject({ id: owned.id, status: RsvpStatus.GOING });

    const ownRsvpResponse = await requestAs(
      studentId(1),
      'POST',
      `/events/${primaryEventId}/rsvp`,
      {},
    );
    expect(ownRsvpResponse.status).toBe(201);
    const ownRsvp = await ownRsvpResponse.json();
    expect(ownRsvp).toMatchObject({ status: RsvpStatus.GOING });
    expect(ownRsvp.id).not.toBe(owned.id);
    expect(
      await appPrisma.rsvp.findUniqueOrThrow({
        where: { eventId_userId: { eventId: primaryEventId, userId: studentId(0) } },
      }),
    ).toMatchObject({ id: owned.id, status: RsvpStatus.GOING });
  });

  it('keeps other attendees out of student RSVP read responses', async () => {
    const attendee = await repository.rsvp(primaryEventId, studentId(0), false);
    const response = await requestAs(studentId(1), 'GET', '/rsvps/me');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(studentId(0));
    expect(JSON.stringify(body)).not.toContain(attendee.id);

    const organizerResponse = await requestAs(organizerId, 'GET', '/rsvps/me');
    expect(organizerResponse.status).toBe(403);
  });

  it('rejects RSVP mass assignment of status, user, ticket, and waitlist fields', async () => {
    const response = await requestAs(studentId(0), 'POST', `/events/${primaryEventId}/rsvp`, {
      checkConflicts: false,
      status: 'GOING',
      userId: studentId(1),
      ticket: { tokenHash: 'attacker-controlled' },
      ticketToken: 'attacker-controlled',
      waitlistPosition: 1,
    });

    expect(response.status).toBe(400);
    expect(
      await appPrisma.rsvp.count({
        where: { eventId: primaryEventId, userId: { in: [studentId(0), studentId(1)] } },
      }),
    ).toBe(0);
    expect(
      await appPrisma.ticket.count({
        where: { rsvp: { eventId: primaryEventId } },
      }),
    ).toBe(0);
  });

  it('returns 429 with Retry-After when the per-user RSVP limit is exceeded over HTTP', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await requestAs(studentId(0), 'POST', `/events/${primaryEventId}/rsvp`, {});
      expect(response.status).toBe(attempt === 0 ? 201 : 409);
    }

    const limited = await requestAs(studentId(0), 'POST', `/events/${primaryEventId}/rsvp`, {});
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  });

  it('allows cancellation immediately before the event starts', async () => {
    const justBeforeStart = new Date(Date.now() + 5_000);
    await appPrisma.event.update({
      where: { id: primaryEventId },
      data: { startAt: justBeforeStart },
    });
    const going = await repository.rsvp(primaryEventId, studentId(0), false);

    const response = await requestAs(studentId(0), 'DELETE', `/events/${primaryEventId}/rsvp`);

    expect(response.status).toBe(200);
    expect(
      await appPrisma.rsvp.findUniqueOrThrow({
        where: { eventId_userId: { eventId: primaryEventId, userId: studentId(0) } },
      }),
    ).toMatchObject({ id: going.id, status: RsvpStatus.CANCELLED });
    expect(await appPrisma.ticket.findUniqueOrThrow({ where: { rsvpId: going.id } })).toMatchObject(
      { status: TicketStatus.REVOKED },
    );
    expect(await appPrisma.rsvpPromotionOutbox.count({ where: { eventId: primaryEventId } })).toBe(
      1,
    );
  });

  it('rejects cancellation at or after start without state or side effects', async () => {
    await appPrisma.event.update({
      where: { id: primaryEventId },
      data: { capacity: 1 },
    });
    const going = await repository.rsvp(primaryEventId, studentId(0), false);
    const waiter = await repository.rsvp(primaryEventId, studentId(1), false);
    const notificationsBefore = await appPrisma.notification.count({
      where: { eventId: primaryEventId },
    });
    const auditEntriesBefore = await migrationPrisma.auditLog.count({
      where: { entityId: { in: [going.id, primaryEventId] } },
    });
    const exactStart = new Date(Date.now() + 5_000);
    await appPrisma.event.update({
      where: { id: primaryEventId },
      data: {
        startAt: exactStart,
        endAt: new Date(exactStart.getTime() + 60 * 60 * 1_000),
      },
    });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(exactStart);
    try {
      const response = await requestAs(studentId(0), 'DELETE', `/events/${primaryEventId}/rsvp`);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 409,
        message: 'RSVP cancellation is not allowed after the event starts.',
      });
    } finally {
      vi.useRealTimers();
    }
    expect(
      await appPrisma.rsvp.findUniqueOrThrow({
        where: { eventId_userId: { eventId: primaryEventId, userId: studentId(0) } },
      }),
    ).toMatchObject({ id: going.id, status: RsvpStatus.GOING, waitlistPosition: null });
    expect(
      await appPrisma.rsvp.findUniqueOrThrow({
        where: { eventId_userId: { eventId: primaryEventId, userId: studentId(1) } },
      }),
    ).toMatchObject({ id: waiter.id, status: RsvpStatus.WAITLISTED, waitlistPosition: 1 });
    expect(await appPrisma.ticket.findUniqueOrThrow({ where: { rsvpId: going.id } })).toMatchObject(
      { status: TicketStatus.ISSUED, revokedAt: null },
    );
    expect(await appPrisma.rsvpPromotionOutbox.count({ where: { eventId: primaryEventId } })).toBe(
      0,
    );
    expect(await appPrisma.notification.count({ where: { eventId: primaryEventId } })).toBe(
      notificationsBefore,
    );
    expect(
      await migrationPrisma.auditLog.count({
        where: { entityId: { in: [going.id, primaryEventId] } },
      }),
    ).toBe(auditEntriesBefore);
  });

  it('skips and closes promotion jobs for events that have started', async () => {
    await appPrisma.event.update({
      where: { id: primaryEventId },
      data: { capacity: 1 },
    });
    await repository.rsvp(primaryEventId, studentId(0), false);
    const waiter = await repository.rsvp(primaryEventId, studentId(1), false);
    await repository.cancel(primaryEventId, studentId(0));
    const outbox = await appPrisma.rsvpPromotionOutbox.findFirstOrThrow({
      where: { eventId: primaryEventId },
    });
    const notificationsBefore = await appPrisma.notification.count({
      where: { eventId: primaryEventId },
    });
    await appPrisma.event.update({
      where: { id: primaryEventId },
      data: { startAt: new Date(Date.now() - 1_000) },
    });

    const worker = new RsvpPromotionProcessor(repository);
    await worker.process({
      name: RSVP_PROMOTION_JOB,
      data: { eventId: primaryEventId, outboxId: outbox.id },
    } as Job<{ eventId: string; outboxId: string }>);

    expect(await appPrisma.rsvp.findUniqueOrThrow({ where: { id: waiter.id } })).toMatchObject({
      status: RsvpStatus.WAITLISTED,
      waitlistPosition: 1,
    });
    expect(await appPrisma.ticket.count({ where: { rsvpId: waiter.id } })).toBe(0);
    expect(await appPrisma.notification.count({ where: { eventId: primaryEventId } })).toBe(
      notificationsBefore,
    );
    expect(
      await appPrisma.rsvpPromotionOutbox.findUniqueOrThrow({ where: { id: outbox.id } }),
    ).toMatchObject({ processedAt: expect.any(Date) });
  });
});

async function createEvent(
  capacity: number,
  status: (typeof EventStatus)[keyof typeof EventStatus] = EventStatus.APPROVED,
  eventStartAt = startAt,
  eventEndAt = endAt,
  isPublic = true,
  eventClubId = clubId,
): Promise<string> {
  const id = randomUUID();
  await appPrisma.event.create({
    data: {
      id,
      title: `RSVP Fixture ${id}`,
      slug: `rsvp-fixture-${id}`,
      description: 'RSVP integration fixture',
      status,
      startAt: eventStartAt,
      endAt: eventEndAt,
      timeZone: 'UTC',
      capacity,
      isPublic,
      clubId: eventClubId,
      categoryId,
      createdById: adminId,
      approvedById: adminId,
      approvedAt: new Date(),
    },
  });
  eventIds.push(id);
  return id;
}

function requestAs(
  userId: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${httpBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${userId}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function studentId(index: number): string {
  const id = studentIds.find((_studentId, studentIndex) => studentIndex === index);
  if (!id) {
    throw new Error(`Missing RSVP integration student at index ${index}.`);
  }
  return id;
}
