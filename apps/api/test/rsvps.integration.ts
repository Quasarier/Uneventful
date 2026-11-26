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
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { importPKCS8, SignJWT } from 'jose';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { EventStatus, RsvpStatus, TicketStatus } from '../generated/prisma/client';
import { AuthRepository } from '../src/auth/auth.repository';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthController } from '../src/auth/auth.controller';
import type { AuthPrincipal } from '../src/auth/auth.types';
import { AuthService } from '../src/auth/auth.service';
import { GlobalApiRateLimitGuard } from '../src/auth/global-api-rate-limit.guard';
import { GoogleOidcService } from '../src/auth/google-oidc.service';
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
import { TicketSigningService } from '../src/rsvps/ticket-signing.service';
import { CheckinsController } from '../src/rsvps/checkins.controller';
import { CheckinsRepository } from '../src/rsvps/checkins.repository';
import { CheckinsService } from '../src/rsvps/checkins.service';
import { CheckinManifestQueryDto } from '../src/rsvps/dto/checkin-manifest-query.dto';
import { CheckinTicketDto } from '../src/rsvps/dto/checkin-ticket.dto';
import { ManualCheckinLookupDto } from '../src/rsvps/dto/manual-checkin-lookup.dto';
import { ManualCheckinDto } from '../src/rsvps/dto/manual-checkin.dto';
import { SyncCheckinsDto } from '../src/rsvps/dto/sync-checkins.dto';
import { EventDashboardGateway } from '../src/realtime/event-dashboard.gateway';
import { EventDashboardRepository } from '../src/realtime/event-dashboard.repository';
import { RealtimeIoAdapter } from '../src/realtime/realtime-io.adapter';
import { validateEnvironment, type Environment } from '../src/config/environment';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsCacheService } from '../src/analytics/analytics-cache.service';
import { AnalyticsController } from '../src/analytics/analytics.controller';
import { AnalyticsService } from '../src/analytics/analytics.service';

const appDatabaseUrl = process.env.TEST_DATABASE_URL;
const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const ticketSigningKeys = generateKeyPairSync('ed25519');
const previousTicketSigningKeys = generateKeyPairSync('ed25519');
const accessTokenSigningKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

interface TicketKeyConfiguration {
  current: typeof ticketSigningKeys;
  currentKeyId: string;
  previous?: typeof ticketSigningKeys;
  previousKeyId?: string;
}

if (!appDatabaseUrl || !migrationDatabaseUrl || !redisUrl) {
  throw new Error(
    'TEST_DATABASE_URL, TEST_MIGRATION_DATABASE_URL, and TEST_REDIS_URL are required for RSVP integration tests.',
  );
}

function configFor(
  databaseUrl: string,
  rateLimit = 10,
  ticketKeys: TicketKeyConfiguration = {
    current: ticketSigningKeys,
    currentKeyId: 'rsvp-integration-ticket-key',
    previous: previousTicketSigningKeys,
    previousKeyId: 'rsvp-integration-previous-key',
  },
): ConfigService<Environment, true> {
  const previousKeyConfig =
    ticketKeys.previous && ticketKeys.previousKeyId
      ? {
          TICKET_SIGNING_PREVIOUS_KEY_ID: ticketKeys.previousKeyId,
          TICKET_SIGNING_PREVIOUS_PUBLIC_KEY_B64: Buffer.from(
            ticketKeys.previous.publicKey.export({ format: 'der', type: 'spki' }),
          ).toString('base64'),
        }
      : {};
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
    CAMPUS_TIME_ZONE: 'America/New_York',
    WEB_ORIGIN: 'http://localhost:3000',
    SESSION_SECRET: `${randomUUID()}${randomUUID()}`,
    JWT_PRIVATE_KEY_B64: Buffer.from(
      accessTokenSigningKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    ).toString('base64'),
    JWT_PUBLIC_KEY_B64: Buffer.from(
      accessTokenSigningKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    ).toString('base64'),
    JWT_KEY_ID: 'rsvp-integration-key',
    TICKET_SIGNING_PRIVATE_KEY_B64: Buffer.from(
      ticketKeys.current.privateKey.export({ format: 'der', type: 'pkcs8' }),
    ).toString('base64'),
    TICKET_SIGNING_PUBLIC_KEY_B64: Buffer.from(
      ticketKeys.current.publicKey.export({ format: 'der', type: 'spki' }),
    ).toString('base64'),
    TICKET_SIGNING_KEY_ID: ticketKeys.currentKeyId,
    ...previousKeyConfig,
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
let redisClient: Redis;
let analyticsCache: AnalyticsCacheService;
let httpApp: INestApplication | undefined;
let httpBaseUrl: string;
let realtimeApps: INestApplication[] = [];
let realtimeBaseUrls: string[] = [];
let realtimeGateways: EventDashboardGateway[] = [];
let realtimeSockets: ClientSocket[] = [];
let realAuthRealtimeApp: INestApplication | undefined;
let realAuthRealtimeBaseUrl: string;
const socketFamiliesByToken = new Map<string, string>();
const activeSocketFamilies = new Set<string>();
const socketTokenExpiries = new Map<string, number>();
const eventAnalyticsResponseFields = [
  'checkInsByTime',
  'eventId',
  'noShowRate',
  'peakSignupHours',
  'period',
  'repeatAttendeeRate',
  'rsvps',
  'rsvpsOverTime',
];
const clubAnalyticsResponseFields = [
  'checkInsByTime',
  'clubId',
  'followerGrowth',
  'memberGrowth',
  'noShowRate',
  'peakSignupHours',
  'period',
  'repeatAttendeeRate',
  'rsvps',
  'rsvpsOverTime',
];
let publishDashboardCheckIn = async (eventId: string): Promise<void> => {
  if (!eventId) {
    throw new Error('Dashboard event ID is required.');
  }
};

function expectAnalyticsFieldAllowlist(value: unknown, fields: readonly string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Analytics response must be a JSON object.');
  }
  expect(Object.keys(value).sort()).toEqual([...fields].sort());
}

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
let additionalCategoryIds: string[] = [];
let startAt: Date;
let endAt: Date;
let activePrisma: PrismaService;
let ticketSigner: TicketSigningService;
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
  [AuthService, GoogleOidcService, ConfigService, AuthRateLimitService],
  AuthController,
);
Reflect.defineMetadata(
  'design:paramtypes',
  [RsvpsService, AuthRateLimitService, ConfigService],
  RsvpsController,
);
Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, CheckinManifestQueryDto],
  CheckinsController.prototype,
  'getManifest',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, CheckinTicketDto],
  CheckinsController.prototype,
  'checkIn',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, SyncCheckinsDto],
  CheckinsController.prototype,
  'syncCheckins',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, ManualCheckinLookupDto],
  CheckinsController.prototype,
  'lookup',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, ManualCheckinDto],
  CheckinsController.prototype,
  'manualCheckIn',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [CheckinsService, AuthRateLimitService, ConfigService, AnalyticsCacheService],
  CheckinsController,
);
Reflect.defineMetadata(
  'design:paramtypes',
  [AnalyticsService, AuthRateLimitService, ConfigService],
  AnalyticsController,
);
Reflect.defineMetadata(
  'design:paramtypes',
  [AuthService, AuthRateLimitService, ConfigService, EventDashboardRepository],
  EventDashboardGateway,
);
Reflect.defineMetadata('design:paramtypes', [PrismaService], EventDashboardRepository);

const authStub = {
  authenticateAccessToken: async (token: string): Promise<AuthPrincipal> => {
    const principal = principals.get(token);
    if (!principal) {
      throw new UnauthorizedException('Unknown RSVP integration-test bearer token.');
    }
    return principal;
  },
  getProfile: async (userId: string) => {
    const user = await activePrisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        deletedAt: true,
      },
    });
    if (!user || !user.isActive || user.deletedAt) {
      throw new UnauthorizedException('This account is unavailable.');
    }
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl,
      role: user.role,
    };
  },
};

const realtimeAuthStub = {
  authenticateAccessTokenSession: async (token: string) => {
    const principal = principals.get(token);
    if (!principal) {
      throw new UnauthorizedException('Unknown real-time integration-test token.');
    }
    let familyId = socketFamiliesByToken.get(token);
    if (!familyId) {
      familyId = randomUUID();
      socketFamiliesByToken.set(token, familyId);
    }
    activeSocketFamilies.add(familyId);
    return {
      principal,
      familyId,
      expiresAt: socketTokenExpiries.get(token) ?? Date.now() + 15 * 60_000,
    };
  },
  isAccessSessionActive: async (session: { familyId: string }) =>
    activeSocketFamilies.has(session.familyId),
};

@Module({
  controllers: [
    AuthController,
    RsvpsController,
    MyRsvpsController,
    CheckinsController,
    AnalyticsController,
  ],
  providers: [
    { provide: AnalyticsCacheService, useFactory: () => analyticsCache },
    {
      provide: AnalyticsService,
      useFactory: (config: ConfigService<Environment, true>) =>
        new AnalyticsService(activePrisma, config, analyticsCache),
      inject: [ConfigService],
    },
    {
      provide: RsvpsRepository,
      useFactory: (ticketSigning: TicketSigningService) =>
        new RsvpsRepository(activePrisma, ticketSigning),
      inject: [TicketSigningService],
    },
    {
      provide: RsvpsService,
      useFactory: (repo: RsvpsRepository) => new RsvpsService(repo, analyticsCache),
      inject: [RsvpsRepository],
    },
    {
      provide: CheckinsRepository,
      useFactory: (ticketSigning: TicketSigningService) =>
        new CheckinsRepository(activePrisma, ticketSigning, {
          publishCheckIn: (eventId: string) => publishDashboardCheckIn(eventId),
        }),
      inject: [TicketSigningService],
    },
    {
      provide: CheckinsService,
      useFactory: (repo: CheckinsRepository) => new CheckinsService(repo),
      inject: [CheckinsRepository],
    },
    { provide: AuthRateLimitService, useFactory: () => rateLimitService },
    { provide: AuthService, useValue: authStub },
    { provide: GoogleOidcService, useValue: {} },
    { provide: ConfigService, useFactory: () => configFor(appDatabaseUrl!) },
    {
      provide: TicketSigningService,
      useFactory: (config: ConfigService<Environment, true>) => new TicketSigningService(config),
      inject: [ConfigService],
    },
  ],
})
class RsvpHttpIntegrationModule {}

@Module({
  providers: [
    EventDashboardGateway,
    EventDashboardRepository,
    { provide: PrismaService, useFactory: () => activePrisma },
    { provide: AuthService, useValue: realtimeAuthStub },
    { provide: AuthRateLimitService, useFactory: () => rateLimitService },
    { provide: ConfigService, useFactory: () => configFor(appDatabaseUrl!) },
  ],
})
class RealtimeIntegrationModule {}

@Module({
  controllers: [AuthController],
  providers: [
    EventDashboardGateway,
    EventDashboardRepository,
    { provide: PrismaService, useFactory: () => activePrisma },
    {
      provide: AuthRepository,
      useFactory: () => new AuthRepository(activePrisma),
    },
    {
      provide: AuthService,
      useFactory: (config: ConfigService<Environment, true>, repository: AuthRepository) =>
        new AuthService(config, repository),
      inject: [ConfigService, AuthRepository],
    },
    { provide: AuthRateLimitService, useFactory: () => rateLimitService },
    { provide: GoogleOidcService, useValue: {} },
    { provide: ConfigService, useFactory: () => configFor(appDatabaseUrl!) },
  ],
})
class RealAuthRealtimeIntegrationModule {}

describe('RSVP PostgreSQL concurrency integration', () => {
  beforeAll(async () => {
    appPrisma = new PrismaService(configFor(appDatabaseUrl!));
    migrationPrisma = new PrismaService(configFor(migrationDatabaseUrl!));
    await Promise.all([appPrisma.$connect(), migrationPrisma.$connect()]);
    ticketSigner = new TicketSigningService(configFor(appDatabaseUrl!));
    repository = new RsvpsRepository(appPrisma, ticketSigner);
    activePrisma = appPrisma;

    redisClient = new Redis(redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redisClient.connect();
    await redisClient.ping();
    rateLimitService = new AuthRateLimitService(redisClient);
    analyticsCache = new AnalyticsCacheService(redisClient, appPrisma);

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

    realtimeApps = [];
    realtimeBaseUrls = [];
    realtimeGateways = [];
    for (let index = 0; index < 2; index += 1) {
      const realtimeApp = await NestFactory.create(RealtimeIntegrationModule, { logger: false });
      realtimeApp.useWebSocketAdapter(new RealtimeIoAdapter(realtimeApp, 'http://localhost:3000'));
      await realtimeApp.listen(0, '127.0.0.1');
      const realtimeAddress = realtimeApp.getHttpServer().address();
      if (!realtimeAddress || typeof realtimeAddress === 'string') {
        throw new Error('Could not determine real-time integration server address.');
      }
      realtimeApps.push(realtimeApp);
      realtimeBaseUrls.push(`http://127.0.0.1:${realtimeAddress.port}`);
      realtimeGateways.push(realtimeApp.get(EventDashboardGateway));
    }
    await Promise.all(realtimeGateways.map(waitForGatewayReady));
    const firstGateway = realtimeGateways[0];
    if (!firstGateway) {
      throw new Error('The first real-time integration gateway did not start.');
    }
    publishDashboardCheckIn = (eventId) => firstGateway.publishCheckIn(eventId);

    realAuthRealtimeApp = await NestFactory.create(RealAuthRealtimeIntegrationModule, {
      logger: false,
    });
    realAuthRealtimeApp.useWebSocketAdapter(
      new RealtimeIoAdapter(realAuthRealtimeApp, 'http://localhost:3000'),
    );
    realAuthRealtimeApp.setGlobalPrefix('api/v1');
    realAuthRealtimeApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    realAuthRealtimeApp.useGlobalFilters(new HttpExceptionFilter());
    const realAuthReflector = realAuthRealtimeApp.get(Reflector);
    const realAuthConfig = configFor(appDatabaseUrl!);
    const realAuthService = realAuthRealtimeApp.get(AuthService);
    realAuthRealtimeApp.useGlobalGuards(
      new JwtAuthGuard(realAuthReflector, realAuthService, rateLimitService, realAuthConfig),
      new GlobalApiRateLimitGuard(rateLimitService, realAuthReflector, realAuthConfig),
      new RolesGuard(realAuthReflector),
    );
    await realAuthRealtimeApp.listen(0, '127.0.0.1');
    const realAuthAddress = realAuthRealtimeApp.getHttpServer().address();
    if (!realAuthAddress || typeof realAuthAddress === 'string') {
      throw new Error('Could not determine the real-auth integration server address.');
    }
    realAuthRealtimeBaseUrl = `http://127.0.0.1:${realAuthAddress.port}/api/v1`;
    await waitForGatewayReady(realAuthRealtimeApp.get(EventDashboardGateway));
  });

  beforeEach(async () => {
    socketFamiliesByToken.clear();
    activeSocketFamilies.clear();
    socketTokenExpiries.clear();
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
    additionalCategoryIds = [];
    primaryEventId = await createEvent(50);
  });

  afterEach(async () => {
    for (const socket of realtimeSockets) {
      socket.disconnect();
    }
    realtimeSockets = [];
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
        const tickets = await migrationPrisma.ticket.findMany({
          where: { rsvpId: { in: rsvpIds } },
          select: { id: true },
        });
        await migrationPrisma.checkIn.deleteMany({
          where: { ticketId: { in: tickets.map((ticket) => ticket.id) } },
        });
        await migrationPrisma.ticket.deleteMany({ where: { rsvpId: { in: rsvpIds } } });
        await migrationPrisma.rsvp.deleteMany({ where: { id: { in: rsvpIds } } });
      }
      await migrationPrisma.clubFollow.deleteMany({
        where: { OR: [{ userId: { in: userIds } }, { clubId: { in: clubIds } }] },
      });
      await migrationPrisma.recommendationConsent.deleteMany({
        where: { userId: { in: userIds } },
      });
      await migrationPrisma.recommendationPreference.deleteMany({
        where: { userId: { in: userIds } },
      });
      await migrationPrisma.event.deleteMany({ where: { id: { in: eventIds } } });
      await migrationPrisma.eventCategory.deleteMany({
        where: { id: { in: [categoryId, ...additionalCategoryIds] } },
      });
      await migrationPrisma.clubMembership.deleteMany({ where: { clubId: { in: clubIds } } });
      await migrationPrisma.club.deleteMany({ where: { id: { in: clubIds } } });
      const auditActors = await migrationPrisma.auditLog.findMany({
        where: { actorId: { in: userIds } },
        select: { actorId: true },
      });
      const preservedActorIds = auditActors.flatMap((audit) =>
        audit.actorId ? [audit.actorId] : [],
      );
      await migrationPrisma.user.deleteMany({
        where: {
          id: { in: userIds, notIn: [adminId, organizerId, ...preservedActorIds] },
        },
      });
    }
    eventIds = [];
    userIds = [];
    studentIds = [];
  });

  afterAll(async () => {
    await Promise.all(realtimeApps.map((app) => app.close()));
    realtimeApps = [];
    await realAuthRealtimeApp?.close();
    realAuthRealtimeApp = undefined;
    await httpApp?.close();
    rateLimitService?.onModuleDestroy();
    await Promise.all([appPrisma?.$disconnect(), migrationPrisma?.$disconnect()]);
  });

  it('masks analytics and attendee exports from anonymous, student, and other-club callers', async () => {
    const eventPath = `/events/${primaryEventId}/analytics`;
    const exportPath = `/events/${primaryEventId}/attendees/export`;
    const eventResponses = await Promise.all([
      fetch(`${httpBaseUrl}${eventPath}`),
      requestAs(studentId(0), 'GET', eventPath),
      requestAs(otherOrganizerId, 'GET', eventPath),
      fetch(`${httpBaseUrl}${exportPath}`),
      requestAs(studentId(0), 'GET', exportPath),
      requestAs(otherOrganizerId, 'GET', exportPath),
    ]);
    const eventBodies = await Promise.all(eventResponses.map((response) => response.json()));

    expect(eventResponses.map((response) => response.status)).toEqual([
      404, 404, 404, 404, 404, 404,
    ]);
    expect(eventBodies.slice(1, 3)).toEqual([eventBodies[0], eventBodies[0]]);
    expect(eventBodies.slice(4, 6)).toEqual([eventBodies[3], eventBodies[3]]);
    expect(Object.keys(eventBodies[0]).sort()).toEqual(['code', 'message', 'path', 'statusCode']);
    expect(eventBodies[0]).toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Event not found.',
      path: '/api/v1/events/:id/analytics',
    });
    expect(eventBodies[3]).toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Event not found.',
      path: '/api/v1/events/:id/attendees/export',
    });

    const clubPath = `/clubs/${clubId}/analytics`;
    const clubResponses = await Promise.all([
      fetch(`${httpBaseUrl}${clubPath}`),
      requestAs(studentId(0), 'GET', clubPath),
      requestAs(otherOrganizerId, 'GET', clubPath),
      requestAs(otherOrganizerId, 'GET', `/clubs/${randomUUID()}/analytics`),
    ]);
    const clubBodies = await Promise.all(clubResponses.map((response) => response.json()));
    expect(clubResponses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    expect(clubBodies.slice(1)).toEqual([clubBodies[0], clubBodies[0], clubBodies[0]]);
    expect(Object.keys(clubBodies[0]).sort()).toEqual(['code', 'message', 'path', 'statusCode']);
    expect(clubBodies[0]).toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Club not found.',
      path: '/api/v1/clubs/:id/analytics',
    });
  });

  it('rate-limits analytics and CSV export with Retry-After headers', async () => {
    const analyticsPath = `/events/${primaryEventId}/analytics`;
    const analyticsResponses: Response[] = [];
    for (let index = 0; index < 21; index += 1) {
      analyticsResponses.push(await requestAs(organizerId, 'GET', analyticsPath));
    }
    expect(analyticsResponses.slice(0, 20).every((response) => response.status === 200)).toBe(true);
    expect(analyticsResponses[20]?.status).toBe(429);
    expect(analyticsResponses[20]?.headers.get('retry-after')).toMatch(/^\d+$/);
    for (const response of analyticsResponses.slice(0, 20)) {
      expectAnalyticsFieldAllowlist(await response.clone().json(), eventAnalyticsResponseFields);
    }

    const exportResponses: Response[] = [];
    for (let index = 0; index < 4; index += 1) {
      exportResponses.push(
        await requestAs(organizerId, 'GET', `/events/${primaryEventId}/attendees/export`),
      );
    }
    expect(exportResponses.slice(0, 3).every((response) => response.status === 200)).toBe(true);
    expect(exportResponses[3]?.status).toBe(429);
    expect(exportResponses[3]?.headers.get('retry-after')).toMatch(/^\d+$/);
  });

  it('returns aggregate-only analytics with hand-checked counts and suppresses small values', async () => {
    const now = new Date();
    const statuses = [
      ...Array.from({ length: 5 }, () => RsvpStatus.GOING),
      ...Array.from({ length: 5 }, () => RsvpStatus.WAITLISTED),
      ...Array.from({ length: 5 }, () => RsvpStatus.CANCELLED),
      ...Array.from({ length: 10 }, () => RsvpStatus.CHECKED_IN),
    ];
    await appPrisma.rsvp.createMany({
      data: statuses.map((status, index) => ({
        eventId: primaryEventId,
        userId: studentId(index),
        status,
        waitlistPosition: status === RsvpStatus.WAITLISTED ? index - 4 : null,
        checkedInAt: status === RsvpStatus.CHECKED_IN ? now : null,
        createdAt: now,
      })),
    });
    await appPrisma.event.update({
      where: { id: primaryEventId },
      data: {
        startAt: new Date(now.getTime() - 3 * 86_400_000),
        endAt: new Date(now.getTime() - 2 * 86_400_000),
      },
    });
    const repeatHistoryEventId = await createEvent(
      50,
      EventStatus.APPROVED,
      new Date(now.getTime() - 6 * 86_400_000),
      new Date(now.getTime() - 5 * 86_400_000),
    );
    await appPrisma.rsvp.createMany({
      data: Array.from({ length: 5 }, (_value, index) => ({
        eventId: repeatHistoryEventId,
        userId: studentId(index + 15),
        status: RsvpStatus.CHECKED_IN,
        checkedInAt: new Date(now.getTime() - 5 * 86_400_000),
        createdAt: now,
      })),
    });

    const response = await requestAs(
      organizerId,
      'GET',
      `/events/${primaryEventId}/analytics?from=${encodeURIComponent(
        new Date(now.getTime() - 60_000).toISOString(),
      )}&to=${encodeURIComponent(new Date(now.getTime() + 60_000).toISOString())}`,
    );
    const result: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expectAnalyticsFieldAllowlist(result, eventAnalyticsResponseFields);
    expect(result).toMatchObject({
      eventId: primaryEventId,
      rsvps: { going: 5, waitlisted: 5, cancelled: 5, checkedIn: 10 },
      noShowRate: 33.33,
      repeatAttendeeRate: 50,
      rsvpsOverTime: [
        {
          total: 25,
          going: 5,
          waitlisted: 5,
          cancelled: 5,
          checkedIn: 10,
        },
      ],
    });
    const eventAnalyticsJson = JSON.stringify(result);
    for (const [index, id] of studentIds.slice(0, 25).entries()) {
      expect(eventAnalyticsJson).not.toContain(id);
      expect(eventAnalyticsJson).not.toContain(`${id}@example.edu`);
      expect(eventAnalyticsJson).not.toContain(`Student${index} Integration`);
    }

    const smallEventId = await createEvent(50);
    await appPrisma.rsvp.createMany({
      data: Array.from({ length: 4 }, (_value, index) => ({
        eventId: smallEventId,
        userId: studentId(index),
        status: RsvpStatus.GOING,
        createdAt: now,
      })),
    });
    const smallResponse = await requestAs(
      organizerId,
      'GET',
      `/events/${smallEventId}/analytics?from=${encodeURIComponent(
        new Date(now.getTime() - 60_000).toISOString(),
      )}&to=${encodeURIComponent(new Date(now.getTime() + 60_000).toISOString())}`,
    );
    const smallResult = await smallResponse.json();
    expectAnalyticsFieldAllowlist(smallResult, eventAnalyticsResponseFields);
    expect(smallResult).toMatchObject({
      rsvps: { going: null },
      rsvpsOverTime: [],
    });

    const clubResponse = await requestAs(
      organizerId,
      'GET',
      `/clubs/${clubId}/analytics?from=${encodeURIComponent(
        new Date(now.getTime() - 60_000).toISOString(),
      )}&to=${encodeURIComponent(new Date(now.getTime() + 60_000).toISOString())}`,
    );
    const clubResult = await clubResponse.json();
    expect(clubResponse.status).toBe(200);
    expectAnalyticsFieldAllowlist(clubResult, clubAnalyticsResponseFields);
    expect(clubResult).toMatchObject({
      clubId,
      rsvps: { going: 9, waitlisted: 5, cancelled: 5, checkedIn: 15 },
      noShowRate: 25,
      repeatAttendeeRate: 50,
      rsvpsOverTime: [
        {
          total: 34,
          going: 9,
          waitlisted: 5,
          cancelled: 5,
          checkedIn: 15,
        },
      ],
    });
    const clubAnalyticsJson = JSON.stringify(clubResult);
    for (const [index, id] of studentIds.slice(0, 25).entries()) {
      expect(clubAnalyticsJson).not.toContain(id);
      expect(clubAnalyticsJson).not.toContain(`${id}@example.edu`);
      expect(clubAnalyticsJson).not.toContain(`Student${index} Integration`);
    }
  });

  it('invalidates event analytics cache after successful check-ins', async () => {
    const now = new Date();
    const analyticsPath = `/events/${primaryEventId}/analytics?from=${encodeURIComponent(
      new Date(now.getTime() - 60_000).toISOString(),
    )}&to=${encodeURIComponent(new Date(now.getTime() + 60_000).toISOString())}`;
    const scanTickets = await Promise.all(
      Array.from({ length: 5 }, (_value, index) =>
        createRsvpWithTicket(primaryEventId, studentId(index)),
      ),
    );
    const before = await requestAs(organizerId, 'GET', analyticsPath);
    const beforeBody = await before.json();
    expectAnalyticsFieldAllowlist(beforeBody, eventAnalyticsResponseFields);
    expect(beforeBody).toMatchObject({ rsvps: { checkedIn: null } });

    for (const ticket of scanTickets) {
      const response = await requestAs(organizerId, 'POST', `/events/${primaryEventId}/checkins`, {
        ticket: ticket.ticketToken,
        deviceId: randomUUID(),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ status: 'VALID' });
    }

    const after = await requestAs(organizerId, 'GET', analyticsPath);
    const afterBody = await after.json();
    expectAnalyticsFieldAllowlist(afterBody, eventAnalyticsResponseFields);
    expect(afterBody).toMatchObject({
      rsvps: { checkedIn: 5 },
      checkInsByTime: [{ count: 5 }],
    });
  });

  it('scopes analytics cache keys to their club and event', async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 60_000).toISOString();
    const to = new Date(now.getTime() + 60_000).toISOString();
    const range = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

    const firstClubResponse = await requestAs(
      organizerId,
      'GET',
      `/clubs/${clubId}/analytics${range}`,
    );
    const secondClubResponse = await requestAs(
      otherOrganizerId,
      'GET',
      `/clubs/${otherClubId}/analytics${range}`,
    );
    expect(firstClubResponse.status).toBe(200);
    expect(secondClubResponse.status).toBe(200);
    expectAnalyticsFieldAllowlist(await firstClubResponse.json(), clubAnalyticsResponseFields);
    expectAnalyticsFieldAllowlist(await secondClubResponse.json(), clubAnalyticsResponseFields);

    const firstClubKeys = await redisClient.smembers(`analytics:club:index:${clubId}`);
    const secondClubKeys = await redisClient.smembers(`analytics:club:index:${otherClubId}`);
    expect(firstClubKeys).toEqual([`analytics:club:${clubId}:${from}:${to}:day`]);
    expect(secondClubKeys).toEqual([`analytics:club:${otherClubId}:${from}:${to}:day`]);
    expect(firstClubKeys.filter((key) => secondClubKeys.includes(key))).toEqual([]);

    const secondEventId = await createEvent(
      50,
      EventStatus.APPROVED,
      startAt,
      endAt,
      true,
      otherClubId,
    );
    const firstEventResponse = await requestAs(
      organizerId,
      'GET',
      `/events/${primaryEventId}/analytics${range}`,
    );
    const secondEventResponse = await requestAs(
      otherOrganizerId,
      'GET',
      `/events/${secondEventId}/analytics${range}`,
    );
    expect(firstEventResponse.status).toBe(200);
    expect(secondEventResponse.status).toBe(200);
    expectAnalyticsFieldAllowlist(await firstEventResponse.json(), eventAnalyticsResponseFields);
    expectAnalyticsFieldAllowlist(await secondEventResponse.json(), eventAnalyticsResponseFields);

    const firstEventKeys = await redisClient.smembers(`analytics:event:index:${primaryEventId}`);
    const secondEventKeys = await redisClient.smembers(`analytics:event:index:${secondEventId}`);
    expect(firstEventKeys).toEqual([
      `analytics:event:${clubId}:${primaryEventId}:${from}:${to}:day`,
    ]);
    expect(secondEventKeys).toEqual([
      `analytics:event:${otherClubId}:${secondEventId}:${from}:${to}:day`,
    ]);
    expect(firstEventKeys.filter((key) => secondEventKeys.includes(key))).toEqual([]);
  });

  it('streams a privacy-limited CSV with formula-safe cells and records the export audit', async () => {
    const hostileNames = [
      { firstName: '=HYPERLINK("https://bad.example")', lastName: 'Attendee,\r\nName' },
      { firstName: '+1+1', lastName: 'Fixture 1' },
      { firstName: '-1+1', lastName: 'Fixture 2' },
      { firstName: '@SUM(A1:A1)', lastName: 'Fixture 3' },
      { firstName: '\t1+1', lastName: 'Fixture 4' },
      { firstName: '\r1+1', lastName: 'Fixture 5' },
    ];
    await Promise.all([
      ...hostileNames.map((name, index) =>
        appPrisma.user.update({
          where: { id: studentId(index) },
          data: name,
        }),
      ),
      appPrisma.event.update({
        where: { id: primaryEventId },
        data: { slug: '../../Campus: Events\r\n' },
      }),
    ]);
    const storedNames = await Promise.all(
      hostileNames.map((_name, index) =>
        appPrisma.user.findUniqueOrThrow({
          where: { id: studentId(index) },
          select: { firstName: true, lastName: true },
        }),
      ),
    );
    expect(storedNames).toEqual(hostileNames);
    await Promise.all(
      hostileNames.map((_name, index) => createRsvpWithTicket(primaryEventId, studentId(index))),
    );
    const response = await requestAs(
      organizerId,
      'GET',
      `/events/${primaryEventId}/attendees/export`,
    );
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toContain('event-Campus-Events.csv');
    expect(csv).toContain('"\'=HYPERLINK(""https://bad.example"") Attendee, Name","GOING",""');
    expect(csv).toContain('"\'+1+1 Fixture 1","GOING",""');
    expect(csv).toContain('"\'-1+1 Fixture 2","GOING",""');
    expect(csv).toContain('"\'@SUM(A1:A1) Fixture 3","GOING",""');
    expect(csv).toContain(`"'\t1+1 Fixture 4","GOING",""`);
    expect(csv).toContain(`"' 1+1 Fixture 5","GOING",""`);
    for (const id of studentIds.slice(0, hostileNames.length)) {
      expect(csv).not.toContain(id);
    }
    const audit = await appPrisma.auditLog.findFirstOrThrow({
      where: {
        actorId: organizerId,
        action: 'EVENT_ATTENDEES_EXPORTED',
        entityId: primaryEventId,
      },
    });
    expect(audit.metadata).toMatchObject({ rowCount: hostileNames.length });
  });

  it('rejects attendee exports above the hard row cap', async () => {
    const additionalUserIds = Array.from({ length: 2_001 - studentIds.length }, () => randomUUID());
    userIds.push(...additionalUserIds);
    await appPrisma.user.createMany({
      data: additionalUserIds.map((id) => ({
        id,
        email: `${id}@example.edu`,
        googleSubject: id,
        firstName: 'Export',
        lastName: 'Fixture',
        role: 'STUDENT',
      })),
    });
    await appPrisma.rsvp.createMany({
      data: [...studentIds, ...additionalUserIds].map((userId) => ({
        eventId: primaryEventId,
        userId,
        status: RsvpStatus.GOING,
      })),
    });

    const response = await requestAs(
      organizerId,
      'GET',
      `/events/${primaryEventId}/attendees/export`,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ statusCode: 413 });
    expect(
      await appPrisma.auditLog.findFirst({
        where: {
          actorId: organizerId,
          action: 'EVENT_ATTENDEES_EXPORTED',
          entityId: primaryEventId,
        },
      }),
    ).toBeNull();
  });

  it('enforces collaborative support, hides student identities in reasons, and skips opt-out history', async () => {
    const now = new Date();
    const otherCategoryId = randomUUID();
    additionalCategoryIds.push(otherCategoryId);
    await appPrisma.eventCategory.create({
      data: {
        id: otherCategoryId,
        name: `Recommendation Category ${otherCategoryId}`,
        slug: `recommendation-category-${otherCategoryId}`,
      },
    });

    const pastEventId = await createEvent(
      50,
      EventStatus.APPROVED,
      new Date(now.getTime() - 3 * 86_400_000),
      new Date(now.getTime() - 2 * 86_400_000),
    );
    await appPrisma.event.update({
      where: { id: pastEventId },
      data: { title: 'Private attendance history', tags: ['past-topic'] },
    });
    await appPrisma.user.update({
      where: { id: studentId(10) },
      data: { firstName: 'SecretCollaborator', lastName: 'Identity' },
    });
    await appPrisma.rsvp.create({
      data: {
        eventId: pastEventId,
        userId: studentId(0),
        status: RsvpStatus.CHECKED_IN,
        checkedInAt: new Date(now.getTime() - 2 * 86_400_000),
      },
    });

    const collaborativeCandidateId = await createEvent(50);
    const belowSupportCandidateId = await createEvent(50);
    const popularityCandidateId = await createEvent(200);
    await appPrisma.event.updateMany({
      where: {
        id: {
          in: [collaborativeCandidateId, belowSupportCandidateId, popularityCandidateId],
        },
      },
      data: { categoryId: otherCategoryId, tags: [] },
    });
    await appPrisma.rsvp.createMany({
      data: Array.from({ length: 5 }, (_value, index) => {
        const attendeeId = studentId(index + 10);
        return [
          {
            eventId: pastEventId,
            userId: attendeeId,
            status: RsvpStatus.CHECKED_IN,
            checkedInAt: new Date(now.getTime() - 2 * 86_400_000),
          },
          {
            eventId: collaborativeCandidateId,
            userId: attendeeId,
            status: RsvpStatus.GOING,
          },
        ];
      }).flat(),
    });
    await appPrisma.rsvp.createMany({
      data: Array.from({ length: 4 }, (_value, index) => ({
        eventId: belowSupportCandidateId,
        userId: studentId(index + 10),
        status: RsvpStatus.GOING,
      })),
    });
    await appPrisma.rsvp.createMany({
      data: Array.from({ length: 100 }, (_value, index) => ({
        eventId: popularityCandidateId,
        userId: studentId(index + 50),
        status: RsvpStatus.GOING,
      })),
    });

    const preferredCandidateId = await createEvent(50);
    await appPrisma.event.update({
      where: { id: preferredCandidateId },
      data: {
        title: 'Tag-matched upcoming event',
        categoryId: otherCategoryId,
        tags: ['upcoming-topic'],
      },
    });
    const alreadyRsvpedId = await createEvent(50);
    await appPrisma.event.update({
      where: { id: alreadyRsvpedId },
      data: { categoryId: otherCategoryId },
    });
    await appPrisma.rsvp.create({
      data: {
        eventId: alreadyRsvpedId,
        userId: studentId(0),
        status: RsvpStatus.GOING,
      },
    });
    const cancelledId = await createEvent(50, EventStatus.CANCELLED);
    const pastCandidateId = await createEvent(
      50,
      EventStatus.APPROVED,
      new Date(now.getTime() - 3 * 86_400_000),
      new Date(now.getTime() - 2 * 86_400_000),
    );
    const hiddenId = await createEvent(
      50,
      EventStatus.APPROVED,
      startAt,
      endAt,
      false,
      otherClubId,
    );

    const personalizedResponse = await requestAs(studentId(0), 'GET', '/recommendations');
    expect(personalizedResponse.status, await personalizedResponse.clone().text()).toBe(200);
    const personalized: {
      data: Array<{ event: { id: string }; reason: string }>;
      personalized: boolean;
    } = await personalizedResponse.json();
    const personalizedIds = personalized.data.map(({ event }) => event.id);
    expect(personalized.personalized).toBe(true);
    expect(personalizedIds).toContain(preferredCandidateId);
    expect(personalizedIds.indexOf(collaborativeCandidateId)).toBeLessThan(
      personalizedIds.indexOf(popularityCandidateId),
    );
    expect(personalizedIds.indexOf(popularityCandidateId)).toBeLessThan(
      personalizedIds.indexOf(belowSupportCandidateId),
    );
    expect(personalizedIds).not.toContain(alreadyRsvpedId);
    expect(personalizedIds).not.toContain(cancelledId);
    expect(personalizedIds).not.toContain(pastCandidateId);
    expect(personalizedIds).not.toContain(hiddenId);
    expect(personalized.data.find(({ event }) => event.id === primaryEventId)?.reason).toBe(
      'Because you attended Private attendance history',
    );
    const personalizedJson = JSON.stringify(personalized);
    expect(personalizedJson).not.toContain('SecretCollaborator Identity');
    expect(personalizedJson).not.toContain(`${studentId(10)}@example.edu`);

    const recommendationIndex = `recommendations:user:index:${studentId(0)}`;
    const cachedRecommendationKeys = await redisClient.smembers(recommendationIndex);
    expect(cachedRecommendationKeys.length).toBeGreaterThan(0);
    const optOutResponse = await requestAs(studentId(0), 'PATCH', '/me/recommendation-preference', {
      personalized: false,
    });
    expect(optOutResponse.status).toBe(200);
    expect(
      await Promise.all(cachedRecommendationKeys.map((key) => redisClient.exists(key))),
    ).toEqual(cachedRecommendationKeys.map(() => 0));
    expect(await redisClient.smembers(recommendationIndex)).toEqual([]);
    const historyReadSpy = vi.spyOn(appPrisma.rsvp, 'findMany');
    const rawQuerySpy = vi.spyOn(appPrisma, '$queryRaw');
    try {
      const optedOutResponse = await requestAs(studentId(0), 'GET', '/recommendations');
      const optedOut: {
        data: Array<{ event: { id: string }; reason: string }>;
        personalized: boolean;
      } = await optedOutResponse.json();
      expect(optedOut.personalized).toBe(false);
      expect(
        optedOut.data.every(({ reason }) => !reason.includes('Private attendance history')),
      ).toBe(true);
      expect(historyReadSpy).not.toHaveBeenCalled();
      expect(rawQuerySpy.mock.calls.map(([template]) => String(template)).join('\n')).not.toContain(
        'WITH attended AS',
      );
    } finally {
      historyReadSpy.mockRestore();
      rawQuerySpy.mockRestore();
    }
    expect(
      await appPrisma.recommendationConsent.findFirst({
        where: { userId: studentId(0), action: 'OPTED_OUT' },
      }),
    ).toMatchObject({ source: 'settings' });
    expect(
      await appPrisma.auditLog.findFirst({
        where: { actorId: studentId(0), action: 'RECOMMENDATION_PREFERENCE_UPDATED' },
      }),
    ).not.toBeNull();

    const followingResponse = await requestAs(studentId(1), 'GET', '/recommendations');
    expect(followingResponse.status).toBe(200);
    const followResponse = await requestAs(studentId(1), 'POST', `/clubs/${clubId}/follow`);
    expect(followResponse.status).toBe(201);
    const followedRecommendations = await requestAs(studentId(1), 'GET', '/recommendations');
    const followed: { data: Array<{ event: { id: string }; reason: string }> } =
      await followedRecommendations.json();
    expect(followed.data.find(({ event }) => event.id === preferredCandidateId)?.reason).toBe(
      'Popular in clubs you follow',
    );

    const beforeRsvp = await requestAs(studentId(2), 'GET', '/recommendations');
    const beforeRsvpData: { data: Array<{ event: { id: string } }> } = await beforeRsvp.json();
    expect(beforeRsvpData.data.map(({ event }) => event.id)).toContain(preferredCandidateId);
    expect(
      (await requestAs(studentId(2), 'POST', `/events/${preferredCandidateId}/rsvp`, {})).status,
    ).toBe(201);
    const afterRsvp = await requestAs(studentId(2), 'GET', '/recommendations');
    const afterRsvpData: { data: Array<{ event: { id: string } }> } = await afterRsvp.json();
    expect(afterRsvpData.data.map(({ event }) => event.id)).not.toContain(preferredCandidateId);

    const cancellationCandidateId = await createEvent(50);
    const initialForCancellation = await requestAs(studentId(3), 'GET', '/recommendations');
    const initialForCancellationData: { data: Array<{ event: { id: string } }> } =
      await initialForCancellation.json();
    expect(initialForCancellationData.data.map(({ event }) => event.id)).toContain(
      cancellationCandidateId,
    );
    expect(
      (await requestAs(studentId(3), 'POST', `/events/${cancellationCandidateId}/rsvp`, {})).status,
    ).toBe(201);
    const afterConfirmation = await requestAs(studentId(3), 'GET', '/recommendations');
    const afterConfirmationData: { data: Array<{ event: { id: string } }> } =
      await afterConfirmation.json();
    expect(afterConfirmationData.data.map(({ event }) => event.id)).not.toContain(
      cancellationCandidateId,
    );
    expect(
      (await requestAs(studentId(3), 'DELETE', `/events/${cancellationCandidateId}/rsvp`)).status,
    ).toBe(200);
    const afterCancellation = await requestAs(studentId(3), 'GET', '/recommendations');
    const afterCancellationData: { data: Array<{ event: { id: string } }> } =
      await afterCancellation.json();
    expect(afterCancellationData.data.map(({ event }) => event.id)).toContain(
      cancellationCandidateId,
    );

    expect(await requestAs(studentId(0), 'DELETE', '/me/recommendation-data')).toMatchObject({
      status: 200,
    });
    expect(
      await appPrisma.auditLog.findFirst({
        where: { actorId: studentId(0), action: 'RECOMMENDATION_DATA_DELETED' },
      }),
    ).not.toBeNull();
  });

  it('issues signed ticket IDs and does not reset a USED ticket during regeneration', async () => {
    const rsvp = await createRsvpWithTicket(primaryEventId, studentId(0));
    const claims = ticketSigner.verify(rsvp.ticketToken);
    expect(claims).toMatchObject({
      eventId: primaryEventId,
      rsvpId: rsvp.id,
      expiresAt: TicketSigningService.expiresAt(endAt).getTime(),
    });
    const ticket = await appPrisma.ticket.findUniqueOrThrow({ where: { rsvpId: rsvp.id } });
    expect(ticket.ticketIdHash).toBe(TicketSigningService.hashTicketId(claims.ticketId));
    expect(ticket.ticketIdHash).not.toBe(
      createHash('sha256').update(rsvp.ticketToken).digest('hex'),
    );

    const issued = await requestAs(studentId(0), 'POST', `/events/${primaryEventId}/rsvp/ticket`);
    expect(issued.status).toBe(201);
    expect(issued.headers.get('cache-control')).toBe('private, no-store');
    const regenerated: { token: string } = await issued.json();
    expect(ticketSigner.verify(regenerated.token).ticketId).toBe(claims.ticketId);

    const checkin = await requestAs(organizerId, 'POST', `/events/${primaryEventId}/checkins`, {
      ticket: regenerated.token,
      deviceId: randomUUID(),
    });
    expect(checkin.status).toBe(201);
    await expect(checkin.json()).resolves.toMatchObject({ status: 'VALID' });
    expect(await appPrisma.ticket.findUniqueOrThrow({ where: { rsvpId: rsvp.id } })).toMatchObject({
      status: TicketStatus.USED,
    });

    const afterUse = await requestAs(studentId(0), 'POST', `/events/${primaryEventId}/rsvp/ticket`);
    expect(afterUse.status).toBe(404);
    expect(await appPrisma.ticket.findUniqueOrThrow({ where: { rsvpId: rsvp.id } })).toMatchObject({
      status: TicketStatus.USED,
    });
  });

  it('masks cancelled, waitlisted and unknown ticket requests identically', async () => {
    const cancelledEventId = await createEvent(2);
    await repository.rsvp(cancelledEventId, studentId(0), false);
    await repository.cancel(cancelledEventId, studentId(0));
    const waitlistedEventId = await createEvent(1);
    await repository.rsvp(waitlistedEventId, studentId(2), false);
    await repository.rsvp(waitlistedEventId, studentId(1), false);

    const responses = await Promise.all([
      requestAs(studentId(0), 'POST', `/events/${cancelledEventId}/rsvp/ticket`),
      requestAs(studentId(1), 'POST', `/events/${waitlistedEventId}/rsvp/ticket`),
      requestAs(studentId(2), 'POST', `/events/${randomUUID()}/rsvp/ticket`),
    ]);
    const results = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        headers: Object.fromEntries(
          [...response.headers.entries()].filter(([name]) => name !== 'date'),
        ),
        body: await response.json(),
      })),
    );
    expect(results[0]).toEqual(results[2]);
    expect(results[1]).toEqual(results[2]);
    expect(results[2]).toMatchObject({
      status: 404,
      body: { statusCode: 404, code: 'NOT_FOUND', message: 'Event not found.' },
    });
  });

  it('checks one of fifty concurrent scans in and returns ALREADY_USED for every replay', async () => {
    const rsvp = await createRsvpWithTicket(primaryEventId, studentId(0));
    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        requestAs(organizerId, 'POST', `/events/${primaryEventId}/checkins`, {
          ticket: rsvp.ticketToken,
          deviceId: randomUUID(),
        }),
      ),
    );
    const bodies = await Promise.all(responses.map((response) => response.json()));

    expect(responses.every((response) => response.status === 201)).toBe(true);
    expect(bodies.filter((body) => body.status === 'VALID')).toHaveLength(1);
    expect(bodies.filter((body) => body.status === 'ALREADY_USED')).toHaveLength(49);
    expect(
      await appPrisma.ticket.count({
        where: { rsvpId: rsvp.id, status: TicketStatus.USED },
      }),
    ).toBe(1);
    expect(await appPrisma.checkIn.count({ where: { ticket: { rsvpId: rsvp.id } } })).toBe(1);
    const ticketId = (await appPrisma.ticket.findUniqueOrThrow({ where: { rsvpId: rsvp.id } })).id;
    expect(
      await appPrisma.auditLog.count({ where: { entityId: ticketId, action: 'CHECKIN_QR' } }),
    ).toBe(1);
    expect(
      await appPrisma.auditLog.count({
        where: { entityId: ticketId, action: 'CHECKIN_QR_DUPLICATE' },
      }),
    ).toBe(49);
  });

  it('masks student and other-club dashboard joins with the same failure', async () => {
    const studentSocket = connectRealtime(0, studentId(0));
    const otherOrganizerSocket = connectRealtime(0, otherOrganizerId);
    await Promise.all([
      waitForSocketConnect(studentSocket),
      waitForSocketConnect(otherOrganizerSocket),
    ]);

    const responses = await Promise.all([
      emitDashboardJoin(studentSocket, primaryEventId),
      emitDashboardJoin(otherOrganizerSocket, primaryEventId),
    ]);
    expect(responses[0]).toEqual({ ok: false, error: 'Event not found.' });
    expect(responses[1]).toEqual(responses[0]);
  });

  it('evicts a socket from the dashboard room after active club membership is removed', async () => {
    const socket = connectRealtime(0, organizerId);
    await waitForSocketConnect(socket);
    await expect(emitDashboardJoin(socket, primaryEventId)).resolves.toMatchObject({ ok: true });

    const revoked = waitForSocketEvent(socket, 'dashboard:access-revoked', 8_000);
    await appPrisma.clubMembership.updateMany({
      where: { userId: organizerId, clubId },
      data: { status: 'LEFT' },
    });
    await expect(revoked).resolves.toMatchObject({ eventId: primaryEventId });

    let updateCount = 0;
    socket.on('dashboard:update', () => {
      updateCount += 1;
    });
    await realtimeGateways[0]?.publishCheckIn(primaryEventId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(updateCount).toBe(0);
  }, 12_000);

  it('disconnects sockets when the access token expires or its session family is revoked', async () => {
    const expiringToken = randomUUID();
    principals.set(expiringToken, {
      id: organizerId,
      role: 'ORGANIZER',
      tokenVersion: 0,
    });
    socketTokenExpiries.set(expiringToken, Date.now() + 500);
    const expiringSocket = connectRealtime(0, expiringToken);
    await waitForSocketConnect(expiringSocket);
    await expect(waitForSocketEvent(expiringSocket, 'disconnect', 3_000)).resolves.toBe(
      'io server disconnect',
    );

    const revocableSocket = connectRealtime(0, organizerId);
    await waitForSocketConnect(revocableSocket);
    const familyId = socketFamiliesByToken.get(organizerId);
    if (!familyId) throw new Error('Expected the integration socket to have a session family.');
    const disconnected = waitForSocketEvent(revocableSocket, 'disconnect', 3_000);
    await rateLimitService.publishSessionRevocation({ familyId });
    await expect(disconnected).resolves.toBe('io server disconnect');
  }, 8_000);

  it('uses real auth to disconnect on HTTP logout and reject reconnects', async () => {
    if (!realAuthRealtimeApp) {
      throw new Error('The real-auth integration server did not start.');
    }
    const auth = realAuthRealtimeApp.get(AuthService);
    const session = await auth.completeGoogleLogin({
      googleSubject: organizerId,
      email: `${organizerId}@example.edu`,
      firstName: 'RSVP',
      lastName: 'Organizer',
      avatarUrl: null,
    });
    const authenticatedSession = await auth.authenticateAccessTokenSession(session.accessToken);
    const expiredToken = await issueExpiredAccessToken(authenticatedSession.familyId);
    const expiredSocket = connectToRealAuthRealtime(expiredToken);
    await expect(waitForSocketConnect(expiredSocket)).rejects.toThrow();

    const socket = connectToRealAuthRealtime(session.accessToken);
    await waitForSocketConnect(socket);
    await expect(emitDashboardJoin(socket, primaryEventId)).resolves.toMatchObject({ ok: true });

    const logoutStartedAt = performance.now();
    const disconnected = waitForSocketEvent(socket, 'disconnect', 3_000).then((reason) => ({
      delayMs: performance.now() - logoutStartedAt,
      reason,
    }));
    const logoutResponse = await fetch(`${realAuthRealtimeBaseUrl}/auth/logout`, {
      method: 'POST',
      headers: {
        Cookie: `__Secure-uneventful_refresh=${session.refreshToken}`,
        Origin: 'http://localhost:3000',
        'X-Uneventful-CSRF': '1',
      },
    });
    expect(logoutResponse.status).toBe(204);
    const disconnectResult = await disconnected;
    expect(disconnectResult.reason).toBe('io server disconnect');
    expect(disconnectResult.delayMs).toBeLessThan(3_000);
    process.stdout.write(
      `Real-auth logout disconnected the dashboard socket in ${disconnectResult.delayMs.toFixed(1)} ms.\n`,
    );

    const rejoiningSocket = connectToRealAuthRealtime(session.accessToken);
    await expect(waitForSocketConnect(rejoiningSocket)).rejects.toThrow();
    expect(rejoiningSocket.connected).toBe(false);
  }, 12_000);

  it('rejects a spoofed handshake origin and caps each user at three live sockets', async () => {
    const spoofedSocket = connectRealtime(0, organizerId, 'https://attacker.example');
    await expect(waitForSocketConnect(spoofedSocket)).rejects.toThrow();

    const allowedSockets = [0, 1, 2].map(() => connectRealtime(0, organizerId));
    await Promise.all(allowedSockets.map((socket) => waitForSocketConnect(socket)));
    const excessSocket = connectRealtime(0, organizerId);
    await expect(waitForSocketConnect(excessSocket)).rejects.toThrow();
  });

  it('rejects malformed, oversized, and over-rate dashboard messages', async () => {
    const malformedSocket = connectRealtime(0, organizerId);
    await waitForSocketConnect(malformedSocket);
    await expect(
      emitSocketAck(malformedSocket, 'dashboard:join', { eventId: 'not-a-uuid' }),
    ).resolves.toEqual({ ok: false, error: 'Invalid request.' });

    const oversizedSocket = connectRealtime(0, organizerId);
    await waitForSocketConnect(oversizedSocket);
    const oversizedDisconnect = waitForSocketEvent(oversizedSocket, 'disconnect', 3_000);
    oversizedSocket.emit('dashboard:join', {
      eventId: primaryEventId,
      ignored: 'x'.repeat(5_000),
    });
    await expect(oversizedDisconnect).resolves.toMatch(/close|disconnect/);

    const rateLimitedSocket = connectRealtime(0, organizerId);
    await waitForSocketConnect(rateLimitedSocket);
    const disconnected = waitForSocketEvent(rateLimitedSocket, 'disconnect', 5_000);
    for (let index = 0; index < 21; index += 1) {
      rateLimitedSocket.emit('dashboard:join', { eventId: primaryEventId });
    }
    await expect(disconnected).resolves.toBe('io server disconnect');
  }, 12_000);

  it('broadcasts only one allowlisted dashboard update for fifty concurrent ticket scans', async () => {
    const rsvp = await createRsvpWithTicket(primaryEventId, studentId(0));
    const socket = connectRealtime(1, organizerId);
    await waitForSocketConnect(socket);
    await expect(emitDashboardJoin(socket, primaryEventId)).resolves.toMatchObject({
      ok: true,
      data: { checkInCount: 0 },
    });

    const updates: unknown[] = [];
    socket.on('dashboard:update', (update: unknown) => updates.push(update));
    const firstUpdate = waitForSocketEvent(socket, 'dashboard:update', 5_000);
    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        requestAs(organizerId, 'POST', `/events/${primaryEventId}/checkins`, {
          ticket: rsvp.ticketToken,
          deviceId: randomUUID(),
        }),
      ),
    );
    expect(responses.every((response) => response.status === 201)).toBe(true);
    await expect(firstUpdate).resolves.toMatchObject({
      eventId: primaryEventId,
      checkInCount: 1,
      rsvpCount: 1,
      recentCheckIns: [{ displayName: 'Student0 Integration' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(updates).toHaveLength(1);
    const update = updates[0];
    expect(update).toMatchObject({
      eventId: primaryEventId,
      checkInCount: 1,
      rsvpCount: 1,
      capacity: 50,
    });
    expect(Object.keys(update as Record<string, unknown>).sort()).toEqual([
      'attendanceRatio',
      'capacity',
      'checkInCount',
      'eventId',
      'recentCheckIns',
      'rsvpCount',
    ]);
    expect(
      Object.keys(
        (update as { recentCheckIns: Array<Record<string, unknown>> }).recentCheckIns[0]!,
      ).sort(),
    ).toEqual(['checkedInAt', 'displayName']);
    expect(JSON.stringify(update)).not.toContain('ticketId');
    expect(JSON.stringify(update)).not.toContain('email');

    const storedTicket = await appPrisma.ticket.findUniqueOrThrow({
      where: { rsvpId: rsvp.id },
      select: { ticketIdHash: true },
    });
    const offlineSync = await requestAs(
      organizerId,
      'POST',
      `/events/${primaryEventId}/checkins/sync`,
      {
        scans: [0, 1].map(() => ({
          ticketIdHash: storedTicket.ticketIdHash,
          deviceId: randomUUID(),
          scannedAt: new Date().toISOString(),
        })),
      },
    );
    expect(offlineSync.status).toBe(201);
    await expect(offlineSync.json()).resolves.toMatchObject({
      data: [{ status: 'DUPLICATE' }, { status: 'DUPLICATE' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(updates).toHaveLength(1);
    expect(await appPrisma.checkIn.count({ where: { ticket: { rsvpId: rsvp.id } } })).toBe(1);
  }, 30_000);

  it('does not broadcast a check-in whose database transaction rolls back', async () => {
    const rsvp = await createRsvpWithTicket(primaryEventId, studentId(0));
    const socket = connectRealtime(0, organizerId);
    await waitForSocketConnect(socket);
    await expect(emitDashboardJoin(socket, primaryEventId)).resolves.toMatchObject({ ok: true });
    await migrationPrisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_dashboard_checkin_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'CHECKIN_QR' THEN
          RAISE EXCEPTION 'simulated check-in rollback';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await migrationPrisma.$executeRawUnsafe(`
      CREATE TRIGGER test_fail_dashboard_checkin_audit
      BEFORE INSERT ON "audit_logs"
      FOR EACH ROW
      EXECUTE FUNCTION test_fail_dashboard_checkin_audit()
    `);
    const updatePromise = expectNoSocketEvent(socket, 'dashboard:update', 300);
    try {
      const response = await requestAs(organizerId, 'POST', `/events/${primaryEventId}/checkins`, {
        ticket: rsvp.ticketToken,
        deviceId: randomUUID(),
      });
      expect(response.status).toBe(500);
      await updatePromise;
      expect(
        await appPrisma.ticket.findUniqueOrThrow({ where: { rsvpId: rsvp.id } }),
      ).toMatchObject({ status: TicketStatus.ISSUED });
      expect(await appPrisma.checkIn.count({ where: { ticket: { rsvpId: rsvp.id } } })).toBe(0);
    } finally {
      await migrationPrisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS test_fail_dashboard_checkin_audit ON "audit_logs"',
      );
      await migrationPrisma.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS test_fail_dashboard_checkin_audit()',
      );
    }
  }, 10_000);

  it('fans a dashboard update from one API instance to a socket connected to the other', async () => {
    expect(realtimeApps).toHaveLength(2);
    expect(new Set(realtimeBaseUrls).size).toBe(2);
    const socket = connectRealtime(0, organizerId);
    await waitForSocketConnect(socket);
    await expect(emitDashboardJoin(socket, primaryEventId)).resolves.toMatchObject({ ok: true });
    const updatePromise = waitForSocketEvent(socket, 'dashboard:update', 5_000);

    await realtimeGateways[1]?.publishCheckIn(primaryEventId);

    await expect(updatePromise).resolves.toMatchObject({
      eventId: primaryEventId,
      checkInCount: 0,
      capacity: 50,
    });
  });

  it('accepts tickets signed by the previous public key during rotation', async () => {
    const rsvp = await createRsvpWithTicket(primaryEventId, studentId(0));
    const claims = ticketSigner.verify(rsvp.ticketToken);
    const previousSigner = new TicketSigningService(
      configFor(appDatabaseUrl!, 10, {
        current: previousTicketSigningKeys,
        currentKeyId: 'rsvp-integration-previous-key',
      }),
    );
    const previousKeyTicket = previousSigner.issue(
      {
        ticketId: claims.ticketId,
        eventId: claims.eventId,
        rsvpId: claims.rsvpId,
      },
      new Date(claims.expiresAt),
    );

    const response = await requestAs(organizerId, 'POST', `/events/${primaryEventId}/checkins`, {
      ticket: previousKeyTicket,
      deviceId: randomUUID(),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ status: 'VALID' });
  });

  it('rejects forged, wrong-event, expired and wrong-kid tickets with masked 404 responses', async () => {
    const first = await createRsvpWithTicket(primaryEventId, studentId(0));
    const otherEventId = await createEvent(2);
    const second = await createRsvpWithTicket(otherEventId, studentId(1));
    const wrongEvent = await requestAs(organizerId, 'POST', `/events/${primaryEventId}/checkins`, {
      ticket: second.ticketToken,
      deviceId: randomUUID(),
    });
    const tampered = `${first.ticketToken.slice(0, -1)}${first.ticketToken.endsWith('A') ? 'B' : 'A'}`;
    const forged = await requestAs(organizerId, 'POST', `/events/${primaryEventId}/checkins`, {
      ticket: tampered,
      deviceId: randomUUID(),
    });
    const unknownKid = `${Buffer.from(
      JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'unknown-ticket-key' }),
    ).toString('base64url')}.${first.ticketToken.split('.')[1]}.${first.ticketToken.split('.')[2]}`;
    const wrongKey = await requestAs(organizerId, 'POST', `/events/${primaryEventId}/checkins`, {
      ticket: unknownKid,
      deviceId: randomUUID(),
    });
    const hiddenEvent = await createEvent(2);
    const hidden = await createRsvpWithTicket(hiddenEvent, studentId(2));
    await appPrisma.event.update({ where: { id: hiddenEvent }, data: { isPublic: false } });
    const hiddenTicket = await requestAs(organizerId, 'POST', `/events/${hiddenEvent}/checkins`, {
      ticket: hidden.ticketToken,
      deviceId: randomUUID(),
    });

    for (const response of [wrongEvent, forged, wrongKey, hiddenTicket]) {
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Event not found.',
      });
    }

    await appPrisma.ticket.update({
      where: { rsvpId: first.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    const expiredToken = ticketSigner.issue(
      {
        ticketId: ticketSigner.verify(first.ticketToken).ticketId,
        eventId: primaryEventId,
        rsvpId: first.id,
      },
      new Date(Date.now() - 1),
    );
    const expired = await requestAs(organizerId, 'POST', `/events/${primaryEventId}/checkins`, {
      ticket: expiredToken,
      deviceId: randomUUID(),
    });
    expect(expired.status).toBe(404);
    await expect(expired.json()).resolves.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Event not found.',
    });
  });

  it('syncs offline scans idempotently and returns per-item invalid and wrong-event results', async () => {
    const valid = await createRsvpWithTicket(primaryEventId, studentId(0));
    const otherEventId = await createEvent(2);
    const other = await createRsvpWithTicket(otherEventId, studentId(1));
    const validClaims = ticketSigner.verify(valid.ticketToken);
    const otherClaims = ticketSigner.verify(other.ticketToken);
    const scannedAt = new Date().toISOString();
    const scan = {
      ticketIdHash: TicketSigningService.hashTicketId(validClaims.ticketId),
      deviceId: randomUUID(),
      scannedAt,
    };
    const batch = {
      scans: [
        scan,
        { ...scan, deviceId: randomUUID() },
        { ticketIdHash: 'a'.repeat(64), deviceId: randomUUID(), scannedAt },
        {
          ticketIdHash: TicketSigningService.hashTicketId(otherClaims.ticketId),
          deviceId: randomUUID(),
          scannedAt,
        },
      ],
    };
    const response = await requestAs(
      organizerId,
      'POST',
      `/events/${primaryEventId}/checkins/sync`,
      batch,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      data: [
        { status: 'VALID' },
        { status: 'DUPLICATE' },
        { status: 'INVALID' },
        { status: 'WRONG_EVENT' },
      ],
    });

    const repeated = await requestAs(
      organizerId,
      'POST',
      `/events/${primaryEventId}/checkins/sync`,
      { scans: [scan] },
    );
    await expect(repeated.json()).resolves.toMatchObject({
      data: [{ status: 'DUPLICATE', checkedInAt: expect.any(String) }],
    });
    expect(
      await appPrisma.auditLog.count({
        where: { action: 'CHECKIN_OFFLINE_SCAN_SYNCED', entityId: primaryEventId },
      }),
    ).toBe(5);
    expect(await appPrisma.ticket.findUniqueOrThrow({ where: { rsvpId: valid.id } })).toMatchObject(
      {
        status: TicketStatus.USED,
      },
    );

    const tooMany = await requestAs(
      organizerId,
      'POST',
      `/events/${primaryEventId}/checkins/sync`,
      { scans: Array.from({ length: 51 }, () => scan) },
    );
    expect(tooMany.status).toBe(400);
  });

  it('provides a bounded no-store manifest and audited allowlisted manual lookup', async () => {
    await createRsvpWithTicket(primaryEventId, studentId(0));
    const manifestResponse = await requestAs(
      organizerId,
      'GET',
      `/events/${primaryEventId}/checkin-manifest?limit=1`,
    );
    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers.get('cache-control')).toBe('private, no-store');
    const manifest = await manifestResponse.json();
    expect(manifest.data).toHaveLength(1);
    expect(manifest.publicKeys.keys[0]).toMatchObject({
      kid: 'rsvp-integration-ticket-key',
      publicKey: expect.any(String),
    });
    expect(Object.keys(manifest.data[0]).sort()).toEqual(['status', 'ticketIdHash']);
    expect(JSON.stringify(manifest)).not.toMatch(/rsvpId|userId|token|email/i);
    expect(manifest.nextCursor).toBeUndefined();

    const lookup = await requestAs(
      organizerId,
      'GET',
      `/events/${primaryEventId}/checkins/lookup?q=Student0`,
    );
    expect(lookup.status).toBe(200);
    expect(lookup.headers.get('cache-control')).toBe('private, no-store');
    const lookupBody = await lookup.json();
    expect(lookupBody.data).toEqual([
      expect.objectContaining({ displayName: 'Student0 Integration', status: RsvpStatus.GOING }),
    ]);
    expect(Object.keys(lookupBody.data[0]).sort()).toEqual([
      'checkedInAt',
      'displayName',
      'rsvpId',
      'status',
    ]);
    const manual = await requestAs(
      organizerId,
      'POST',
      `/events/${primaryEventId}/checkins/manual`,
      {
        rsvpId: lookupBody.data[0].rsvpId,
        deviceId: randomUUID(),
      },
    );
    expect(manual.status).toBe(201);
    await expect(manual.json()).resolves.toMatchObject({ status: 'VALID' });

    expect(
      await appPrisma.auditLog.count({
        where: {
          actorId: organizerId,
          entityId: primaryEventId,
          action: { in: ['CHECKIN_MANIFEST_DOWNLOADED', 'CHECKIN_ATTENDEE_LOOKUP'] },
        },
      }),
    ).toBe(2);
    expect(
      await appPrisma.auditLog.count({
        where: { actorId: organizerId, action: 'CHECKIN_MANUAL', entityId: { not: null } },
      }),
    ).toBe(1);
  });

  it('masks every check-in route from students and organizers outside the event club', async () => {
    const rsvp = await createRsvpWithTicket(primaryEventId, studentId(0));
    const claims = ticketSigner.verify(rsvp.ticketToken);
    const body = { ticket: rsvp.ticketToken, deviceId: randomUUID() };
    const routes: Array<{ method: 'GET' | 'POST'; path: string; body?: unknown }> = [
      { method: 'GET', path: `/events/${primaryEventId}/checkin-manifest` },
      { method: 'POST', path: `/events/${primaryEventId}/checkins`, body },
      {
        method: 'POST',
        path: `/events/${primaryEventId}/checkins/sync`,
        body: {
          scans: [
            {
              ticketIdHash: TicketSigningService.hashTicketId(claims.ticketId),
              deviceId: randomUUID(),
              scannedAt: new Date().toISOString(),
            },
          ],
        },
      },
      { method: 'GET', path: `/events/${primaryEventId}/checkins/lookup?q=Student0` },
      {
        method: 'POST',
        path: `/events/${primaryEventId}/checkins/manual`,
        body: { rsvpId: rsvp.id, deviceId: randomUUID() },
      },
    ];

    for (const route of routes) {
      const responses = await Promise.all([
        requestAs(studentId(1), route.method, route.path, route.body),
        requestAs(otherOrganizerId, route.method, route.path, route.body),
      ]);
      const payloads = await Promise.all(
        responses.map(async (response) => ({
          status: response.status,
          headers: Object.fromEntries(
            [...response.headers.entries()].filter(([name]) => name !== 'date'),
          ),
          body: await response.json(),
        })),
      );
      expect(payloads[0]).toEqual(payloads[1]);
      expect(payloads[0]).toMatchObject({
        status: 404,
        body: { statusCode: 404, code: 'NOT_FOUND', message: 'Event not found.' },
      });
    }
  });

  it('enforces the per-user check-in rate limit with Retry-After', async () => {
    const userId = studentId(199);
    for (let count = 0; count < 120; count += 1) {
      await rateLimitService.consume('checkin-user', userId, 120, 60_000);
    }
    const response = await requestAs(userId, 'GET', `/events/${primaryEventId}/checkin-manifest`);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
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
    expect(firstTicket.ticketIdHash).toMatch(/^[a-f0-9]{64}$/);
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
    expect(promotedTicket.ticketIdHash).toMatch(/^[a-f0-9]{64}$/);
    const promotedTokenResponse = await requestAs(
      studentId(2),
      'POST',
      `/events/${primaryEventId}/rsvp/ticket`,
    );
    expect(promotedTokenResponse.status).toBe(201);
    const promotedToken: { token: string } = await promotedTokenResponse.json();
    expect(ticketSigner.verify(promotedToken.token).rsvpId).toBe(promotedWaiter.id);
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

    const restartedWorker = new RsvpPromotionProcessor(
      new RsvpsRepository(appPrisma, new TicketSigningService(configFor(appDatabaseUrl!))),
    );
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
    expect(promotedTicket.ticketIdHash).toMatch(/^[a-f0-9]{64}$/);
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
        expect(hiddenResponse.durationMs).toBeLessThan(10_000);
        expect(unknownResponse.durationMs).toBeLessThan(10_000);
        expect(Math.abs(hiddenResponse.durationMs - unknownResponse.durationMs)).toBeLessThan(
          5_000,
        );
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

  it('keeps profile and RSVP read responses scoped to the requesting student', async () => {
    const attendee = await repository.rsvp(primaryEventId, studentId(0), false);
    const ownProfileResponse = await requestAs(studentId(0), 'GET', '/auth/me');
    expect(ownProfileResponse.status).toBe(200);
    expect(ownProfileResponse.headers.get('cache-control')).toBe('private, no-store');
    const ownProfile = await ownProfileResponse.json();
    expect(ownProfile).toEqual({
      id: studentId(0),
      email: `${studentId(0)}@example.edu`,
      firstName: 'Student0',
      lastName: 'Integration',
      avatarUrl: null,
      role: 'STUDENT',
    });
    expect(JSON.stringify(ownProfile)).not.toContain('tokenVersion');
    expect(JSON.stringify(ownProfile)).not.toContain(`${studentId(1)}@example.edu`);

    const otherProfileResponse = await requestAs(studentId(1), 'GET', '/auth/me');
    expect(otherProfileResponse.status).toBe(200);
    const otherProfile = await otherProfileResponse.json();
    expect(otherProfile).toMatchObject({
      id: studentId(1),
      email: `${studentId(1)}@example.edu`,
    });
    expect(JSON.stringify(otherProfile)).not.toContain(`${studentId(0)}@example.edu`);

    const ownRsvpResponse = await requestAs(studentId(0), 'GET', '/rsvps/me');
    expect(ownRsvpResponse.status).toBe(200);
    expect(ownRsvpResponse.headers.get('cache-control')).toBe('private, no-store');
    const ownRsvpBody = await ownRsvpResponse.json();
    expect(ownRsvpBody.data).toHaveLength(1);
    expect(JSON.stringify(ownRsvpBody)).not.toContain('userId');
    expect(JSON.stringify(ownRsvpBody)).not.toContain('tokenVersion');
    expect(JSON.stringify(ownRsvpBody)).not.toContain(`${studentId(1)}@example.edu`);

    const response = await requestAs(studentId(1), 'GET', '/rsvps/me');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body.data).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(studentId(0));
    expect(JSON.stringify(body)).not.toContain(attendee.id);

    const organizerResponse = await requestAs(organizerId, 'GET', '/rsvps/me');
    expect(organizerResponse.status).toBe(403);
  });

  it('returns an allowlisted no-store RSVP status for only the requesting student', async () => {
    await repository.rsvp(primaryEventId, studentId(0), false);

    const ownResponse = await requestAs(
      studentId(0),
      'GET',
      `/events/${primaryEventId}/rsvp/status`,
    );
    expect(ownResponse.status).toBe(200);
    expect(ownResponse.headers.get('cache-control')).toBe('private, no-store');
    await expect(ownResponse.json()).resolves.toEqual({
      status: RsvpStatus.GOING,
      waitlistPosition: null,
      capacity: 50,
      goingCount: 1,
      isFull: false,
    });

    const otherResponse = await requestAs(
      studentId(1),
      'GET',
      `/events/${primaryEventId}/rsvp/status`,
    );
    expect(otherResponse.status).toBe(200);
    expect(otherResponse.headers.get('cache-control')).toBe('private, no-store');
    const otherStatus = await otherResponse.json();
    expect(otherStatus).toEqual({
      status: null,
      waitlistPosition: null,
      capacity: 50,
      goingCount: 1,
      isFull: false,
    });
    expect(JSON.stringify(otherStatus)).not.toContain(studentId(0));
  });

  it('returns 429 with Retry-After when RSVP status requests exceed the per-user limit', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await requestAs(
        studentId(0),
        'GET',
        `/events/${primaryEventId}/rsvp/status`,
      );
      expect(response.status).toBe(200);
    }

    const limited = await requestAs(studentId(0), 'GET', `/events/${primaryEventId}/rsvp/status`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
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

async function createRsvpWithTicket(
  eventId: string,
  userId: string,
): Promise<{ id: string; ticketToken: string }> {
  const response = await requestAs(userId, 'POST', `/events/${eventId}/rsvp`, {});
  if (!response.ok) {
    throw new Error(`RSVP fixture creation failed with HTTP ${response.status}.`);
  }
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    !('id' in body) ||
    typeof body.id !== 'string' ||
    !('ticketToken' in body) ||
    typeof body.ticketToken !== 'string'
  ) {
    throw new Error('RSVP fixture did not return a signed ticket.');
  }
  return { id: body.id, ticketToken: body.ticketToken };
}

function connectRealtime(
  serverIndex: number,
  token: string,
  origin = 'http://localhost:3000',
): ClientSocket {
  const serverUrl = realtimeBaseUrls.at(serverIndex);
  if (!serverUrl) {
    throw new Error('The requested real-time integration server is unavailable.');
  }
  const socket = io(`${serverUrl}/realtime`, {
    autoConnect: false,
    auth: { accessToken: token },
    extraHeaders: { Origin: origin },
    reconnection: false,
    timeout: 5_000,
    transports: ['websocket'],
  });
  realtimeSockets.push(socket);
  return socket;
}

function connectToRealAuthRealtime(
  accessToken: string,
  origin = 'http://localhost:3000',
): ClientSocket {
  const socket = io(`${realAuthRealtimeBaseUrl.replace(/\/api\/v1$/, '')}/realtime`, {
    autoConnect: false,
    auth: { accessToken },
    extraHeaders: { Origin: origin },
    reconnection: false,
    timeout: 5_000,
    transports: ['websocket'],
  });
  realtimeSockets.push(socket);
  return socket;
}

async function issueExpiredAccessToken(familyId: string): Promise<string> {
  const config = configFor(appDatabaseUrl!);
  const privateKey = await importPKCS8(
    Buffer.from(config.get('JWT_PRIVATE_KEY_B64', { infer: true }), 'base64').toString('utf8'),
    'RS256',
  );
  const nowSeconds = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    role: 'ORGANIZER',
    tokenVersion: 0,
    sid: familyId,
    jti: randomUUID(),
  })
    .setProtectedHeader({
      alg: 'RS256',
      kid: config.get('JWT_KEY_ID', { infer: true }),
    })
    .setSubject(organizerId)
    .setIssuer(config.get('JWT_ISSUER', { infer: true }))
    .setAudience(config.get('JWT_AUDIENCE', { infer: true }))
    .setIssuedAt(nowSeconds - 120)
    .setExpirationTime(nowSeconds - 60)
    .sign(privateKey);
}

function waitForSocketConnect(socket: ClientSocket, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket.IO connection timed out.')), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.connect();
  });
}

async function waitForGatewayReady(gateway: EventDashboardGateway): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!gateway.isReady() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!gateway.isReady()) {
    throw new Error('Socket.IO Redis adapter did not become ready.');
  }
}

function waitForSocketEvent(
  socket: ClientSocket,
  eventName: string,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for Socket.IO event ${eventName}.`)),
      timeoutMs,
    );
    socket.once(eventName, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args[0]);
    });
  });
}

function emitSocketAck(
  socket: ClientSocket,
  eventName: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Socket.IO acknowledgement timed out.')),
      5_000,
    );
    socket.emit(eventName, payload, (response: Record<string, unknown>) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function emitDashboardJoin(
  socket: ClientSocket,
  eventId: string,
): Promise<Record<string, unknown>> {
  return emitSocketAck(socket, 'dashboard:join', { eventId });
}

function expectNoSocketEvent(
  socket: ClientSocket,
  eventName: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      clearTimeout(timer);
      reject(new Error(`Unexpected Socket.IO event ${eventName}.`));
    };
    const timer = setTimeout(() => {
      socket.off(eventName, onEvent);
      resolve();
    }, timeoutMs);
    socket.once(eventName, onEvent);
  });
}

function requestAs(
  userId: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
