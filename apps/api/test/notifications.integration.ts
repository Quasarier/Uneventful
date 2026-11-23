import { ConfigService } from '@nestjs/config';
import { Logger, Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EventStatus,
  NotificationChannel,
  NotificationConsentAction,
  NotificationDeliveryStatus,
  NotificationType,
  RsvpStatus,
  TicketStatus,
} from '../generated/prisma/client';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthRepository } from '../src/auth/auth.repository';
import { AuthService } from '../src/auth/auth.service';
import { GlobalApiRateLimitGuard } from '../src/auth/global-api-rate-limit.guard';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { validateEnvironment, type Environment } from '../src/config/environment';
import { PrismaService } from '../src/database/prisma.service';
import { HttpExceptionFilter } from '../src/http-exception.filter';
import { LocalEmailProvider, type EmailProvider } from '../src/notifications/email-provider';
import { NotificationDeliveryService } from '../src/notifications/notification-delivery.service';
import { NotificationOutboxDispatcher } from '../src/notifications/notification-outbox.dispatcher';
import {
  MAX_NOTIFICATION_JOB_ATTEMPTS,
  NOTIFICATION_DELIVERY_JOB,
  NOTIFICATION_RETRY_DELAY_MS,
} from '../src/notifications/notification.constants';
import { enqueueNotifications } from '../src/notifications/notification-outbox';
import { NotificationsController } from '../src/notifications/notifications.controller';
import { NotificationsService } from '../src/notifications/notifications.service';
import { UnsubscribeService } from '../src/notifications/unsubscribe.service';
import {
  type NotificationPushPayload,
  type PushProvider,
} from '../src/notifications/web-push-provider';
import { EventsRepository } from '../src/events/events.repository';
import { RsvpsRepository } from '../src/rsvps/rsvps.repository';
import { TicketSigningService } from '../src/rsvps/ticket-signing.service';
import { VenueBookingsRepository } from '../src/venues/venue-bookings.repository';
import { VenueBookingsService } from '../src/venues/venue-bookings.service';
import { PatchNotificationPreferencesDto } from '../src/notifications/dto/notification-preferences.dto';
import {
  DeletePushSubscriptionDto,
  PushSubscriptionDto,
} from '../src/notifications/dto/push-subscription.dto';
import { UnsubscribeTokenDto } from '../src/notifications/dto/unsubscribe-token.dto';

const appDatabaseUrl = process.env.TEST_DATABASE_URL;
const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const accessTokenKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ticketSigningKeys = generateKeyPairSync('ed25519');
const unsubscribeSecret = 'notifications-integration-secret-32-chars-minimum';

if (!appDatabaseUrl || !migrationDatabaseUrl || !redisUrl) {
  throw new Error(
    'TEST_DATABASE_URL, TEST_MIGRATION_DATABASE_URL, and TEST_REDIS_URL are required for notification integration tests.',
  );
}

function configFor(databaseUrl: string, rateLimit = 10): ConfigService<Environment, true> {
  const environment = validateEnvironment({
    NODE_ENV: 'test',
    PORT: 3001,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    NOTIFICATION_EMAIL_PROVIDER: 'test',
    NOTIFICATION_UNSUBSCRIBE_SECRET: unsubscribeSecret,
    NOTIFICATION_RATE_LIMIT_PER_MINUTE: rateLimit,
    GOOGLE_CLIENT_ID: 'notifications-integration-client',
    GOOGLE_CLIENT_SECRET: 'notifications-integration-secret',
    GOOGLE_CALLBACK_URL: 'http://localhost:3001/api/v1/auth/google/callback',
    UNIVERSITY_EMAIL_DOMAIN: 'example.edu',
    CAMPUS_TIME_ZONE: 'America/New_York',
    WEB_ORIGIN: 'http://localhost:3000',
    SESSION_SECRET: `${randomUUID()}${randomUUID()}`,
    JWT_PRIVATE_KEY_B64: Buffer.from(
      accessTokenKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    ).toString('base64'),
    JWT_PUBLIC_KEY_B64: Buffer.from(
      accessTokenKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    ).toString('base64'),
    JWT_KEY_ID: 'notifications-integration-key',
    TICKET_SIGNING_PRIVATE_KEY_B64: Buffer.from(
      ticketSigningKeys.privateKey.export({ format: 'der', type: 'pkcs8' }),
    ).toString('base64'),
    TICKET_SIGNING_PUBLIC_KEY_B64: Buffer.from(
      ticketSigningKeys.publicKey.export({ format: 'der', type: 'spki' }),
    ).toString('base64'),
    TICKET_SIGNING_KEY_ID: 'notifications-integration-ticket-key',
    JWT_ISSUER: 'https://api.campuspulse.test',
    JWT_AUDIENCE: 'campuspulse-api',
    REFRESH_TOKEN_TTL_DAYS: 30,
    OBJECT_STORAGE_BUCKET: 'notifications-integration',
    OBJECT_STORAGE_REGION: 'us-east-1',
  });
  return new ConfigService<Environment, true>(environment);
}

const appConfig = configFor(appDatabaseUrl);
const emailTransport = new LocalEmailProvider();
let emailFailure: Error | undefined;
let pushFailureStatus: number | undefined;
const sentPushPayloads: NotificationPushPayload[] = [];

const emailProvider: EmailProvider = {
  async send(email, idempotencyKey) {
    if (emailFailure) {
      throw new Error(`${emailFailure.message} ${email.to}`);
    }
    await emailTransport.send(email, idempotencyKey);
  },
};

const pushProvider: PushProvider = {
  async send(_subscription, payload) {
    if (pushFailureStatus) {
      throw { statusCode: pushFailureStatus };
    }
    sentPushPayloads.push(payload);
  },
};

const hostLookup = async () => [{ address: '8.8.8.8', family: 4 }];

let appPrisma: PrismaService;
let migrationPrisma: PrismaService;
let authRepository: AuthRepository;
let authService: AuthService;
let rateLimitService: AuthRateLimitService;
let notificationsService: NotificationsService;
let unsubscribeService: UnsubscribeService;
let deliveryService: NotificationDeliveryService;
let eventsRepository: EventsRepository;
let rsvpsRepository: RsvpsRepository;
let httpApp: INestApplication | undefined;
let httpBaseUrl: string;
let currentUserId: string;
let currentAccessToken: string;
let createdUserIds: string[] = [];
let createdEventIds: string[] = [];
let createdClubIds: string[] = [];
let createdCategoryIds: string[] = [];

Reflect.defineMetadata(
  'design:paramtypes',
  [NotificationsService, UnsubscribeService, AuthRateLimitService, ConfigService],
  NotificationsController,
);
Reflect.defineMetadata(
  'design:paramtypes',
  [Object],
  NotificationsController.prototype,
  'getPreferences',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [Object, PatchNotificationPreferencesDto],
  NotificationsController.prototype,
  'patchPreferences',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [Object, PushSubscriptionDto],
  NotificationsController.prototype,
  'addPushSubscription',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [Object, DeletePushSubscriptionDto],
  NotificationsController.prototype,
  'removePushSubscription',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [Object, UnsubscribeTokenDto],
  NotificationsController.prototype,
  'unsubscribe',
);

@Module({
  controllers: [NotificationsController],
  providers: [
    { provide: ConfigService, useValue: appConfig },
    { provide: NotificationsService, useFactory: () => notificationsService },
    { provide: UnsubscribeService, useFactory: () => unsubscribeService },
    { provide: AuthRateLimitService, useFactory: () => rateLimitService },
  ],
})
class NotificationsHttpTestModule {}

async function createSession() {
  const identity = randomUUID();
  const session = await authService.completeGoogleLogin({
    googleSubject: identity,
    email: `${identity}@example.edu`,
    firstName: 'Notification',
    lastName: 'Tester',
    avatarUrl: null,
  });
  const authenticated = await authService.authenticateAccessToken(session.accessToken);
  createdUserIds.push(authenticated.id);
  return { userId: authenticated.id, accessToken: session.accessToken };
}

function authenticatedRequest(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  if (init.body) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${httpBaseUrl}${path}`, {
    ...init,
    headers,
  });
}

async function createEvent(
  createdById: string,
  options: { status?: EventStatus; capacity?: number | null; startAt?: Date } = {},
) {
  const id = randomUUID();
  const clubId = randomUUID();
  const categoryId = randomUUID();
  const startAt = options.startAt ?? new Date(Date.now() + 72 * 60 * 60_000);
  const endAt = new Date(startAt.getTime() + 2 * 60 * 60_000);
  const status = options.status ?? EventStatus.APPROVED;
  await appPrisma.club.create({
    data: {
      id: clubId,
      name: `Notification Club ${id.slice(0, 8)}`,
      slug: `notification-club-${id}`,
      createdById,
    },
  });
  await appPrisma.eventCategory.create({
    data: {
      id: categoryId,
      name: `Notification Category ${id.slice(0, 8)}`,
      slug: `notification-category-${id}`,
    },
  });
  await appPrisma.event.create({
    data: {
      id,
      title: 'Notification Integration Event',
      slug: `notification-event-${id}`,
      description: 'Integration test event',
      status,
      startAt,
      endAt,
      timeZone: 'America/New_York',
      capacity: options.capacity ?? null,
      isPublic: true,
      clubId,
      categoryId,
      createdById,
      ...(status === EventStatus.APPROVED
        ? { approvedById: createdById, approvedAt: new Date() }
        : {}),
    },
  });
  createdEventIds.push(id);
  createdClubIds.push(clubId);
  createdCategoryIds.push(categoryId);
  return { id, clubId, categoryId, startAt, endAt };
}

async function enqueueTestNotification(
  userId: string,
  input: {
    eventId?: string | null;
    type?: NotificationType;
    dedupeKey?: string;
    channel?: NotificationChannel;
  } = {},
) {
  const notificationId = randomUUID();
  await appPrisma.notification.create({
    data: {
      id: notificationId,
      userId,
      eventId: input.eventId ?? null,
      dedupeKey: input.dedupeKey ?? `notification-integration:${randomUUID()}`,
      type: input.type ?? NotificationType.RSVP_CONFIRMED,
      title: 'Notification test',
      body: 'Notification test body',
    },
  });
  const delivery = await appPrisma.notificationDelivery.create({
    data: {
      notificationId,
      channel: input.channel ?? NotificationChannel.EMAIL,
      availableAt: new Date(Date.now() - 1_000),
    },
  });
  return { notificationId, deliveryId: delivery.id };
}

function signUnsubscribeToken(claims: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', unsubscribeSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

beforeAll(async () => {
  appPrisma = new PrismaService(appConfig);
  migrationPrisma = new PrismaService(configFor(migrationDatabaseUrl));
  await Promise.all([appPrisma.$connect(), migrationPrisma.$connect()]);

  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  await redis.ping();
  rateLimitService = new AuthRateLimitService(redis);
  authRepository = new AuthRepository(appPrisma);
  authService = new AuthService(appConfig, authRepository);
  await authService.onModuleInit();
  unsubscribeService = new UnsubscribeService(appPrisma, appConfig);
  notificationsService = new NotificationsService(appPrisma, appConfig, hostLookup);
  deliveryService = new NotificationDeliveryService(
    appPrisma,
    appConfig,
    rateLimitService,
    unsubscribeService,
    emailProvider,
    pushProvider,
    hostLookup,
  );

  const venueBookings = new VenueBookingsService(new VenueBookingsRepository(appPrisma), appConfig);
  eventsRepository = new EventsRepository(appPrisma, venueBookings);
  rsvpsRepository = new RsvpsRepository(appPrisma, new TicketSigningService(appConfig));

  httpApp = await NestFactory.create(NotificationsHttpTestModule, { logger: false });
  httpApp.setGlobalPrefix('api/v1');
  httpApp.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  httpApp.useGlobalFilters(new HttpExceptionFilter());
  const reflector = new Reflector();
  httpApp.useGlobalGuards(
    new JwtAuthGuard(reflector, authService, rateLimitService, appConfig),
    new GlobalApiRateLimitGuard(rateLimitService, reflector, appConfig),
    new RolesGuard(reflector),
  );
  await httpApp.listen(0, '127.0.0.1');
  const address = httpApp.getHttpServer().address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not determine notification integration server address.');
  }
  httpBaseUrl = `http://127.0.0.1:${address.port}/api/v1`;
});

beforeEach(async () => {
  const session = await createSession();
  currentUserId = session.userId;
  currentAccessToken = session.accessToken;
  emailFailure = undefined;
  pushFailureStatus = undefined;
  sentPushPayloads.length = 0;
});

afterEach(async () => {
  emailFailure = undefined;
  pushFailureStatus = undefined;
  if (createdEventIds.length > 0) {
    await migrationPrisma.notification.deleteMany({
      where: { eventId: { in: createdEventIds } },
    });
    await migrationPrisma.checkIn.deleteMany({
      where: { ticket: { rsvp: { eventId: { in: createdEventIds } } } },
    });
    await migrationPrisma.ticket.deleteMany({
      where: { rsvp: { eventId: { in: createdEventIds } } },
    });
    await migrationPrisma.rsvp.deleteMany({ where: { eventId: { in: createdEventIds } } });
    await migrationPrisma.rsvpPromotionOutbox.deleteMany({
      where: { eventId: { in: createdEventIds } },
    });
    await migrationPrisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
  }
  if (createdCategoryIds.length > 0) {
    await migrationPrisma.eventCategory.deleteMany({
      where: { id: { in: createdCategoryIds } },
    });
  }
  if (createdClubIds.length > 0) {
    await migrationPrisma.club.deleteMany({ where: { id: { in: createdClubIds } } });
  }
  if (createdUserIds.length > 0) {
    await migrationPrisma.notification.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
    await migrationPrisma.notificationPreference.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
    await migrationPrisma.notificationConsent.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
    await migrationPrisma.pushSubscription.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
    await migrationPrisma.refreshToken.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
  }
  createdEventIds = [];
  createdClubIds = [];
  createdCategoryIds = [];
  createdUserIds = [];
});

afterAll(async () => {
  await httpApp?.close();
  await rateLimitService?.onModuleDestroy();
  await Promise.all([appPrisma?.$disconnect(), migrationPrisma?.$disconnect()]);
});

describe('notification PostgreSQL and Redis integration', () => {
  it('returns allowlisted defaults with no-store headers and keeps preferences self-scoped', async () => {
    const response = await authenticatedRequest(currentAccessToken, '/me/notification-preferences');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = (await response.json()) as {
      data: { preferences: Array<{ channel: string; type: string; enabled: boolean }> };
    };
    expect(body.data.preferences).toHaveLength(24);
    expect(
      body.data.preferences.every(({ channel, enabled }) =>
        channel === 'EMAIL' ? enabled : !enabled,
      ),
    ).toBe(true);

    const other = await createSession();
    const patch = await authenticatedRequest(currentAccessToken, '/me/notification-preferences', {
      method: 'PATCH',
      body: JSON.stringify({
        preferences: [{ channel: 'EMAIL', type: 'RSVP_CONFIRMED', enabled: false }],
      }),
    });
    expect(patch.status).toBe(200);
    const otherResponse = await authenticatedRequest(
      other.accessToken,
      '/me/notification-preferences',
    );
    const otherBody = (await otherResponse.json()) as {
      data: { preferences: Array<{ channel: string; type: string; enabled: boolean }> };
    };
    expect(
      otherBody.data.preferences.find(
        ({ channel, type }) => channel === 'EMAIL' && type === 'RSVP_CONFIRMED',
      )?.enabled,
    ).toBe(true);
    expect(
      await appPrisma.notificationConsent.count({
        where: {
          userId: currentUserId,
          channel: NotificationChannel.EMAIL,
          type: NotificationType.RSVP_CONFIRMED,
          action: NotificationConsentAction.OPTED_OUT,
          source: 'SETTINGS',
        },
      }),
    ).toBe(1);
    expect(
      await appPrisma.auditLog.count({
        where: { actorId: currentUserId, action: 'NOTIFICATION_PREFERENCE_CHANGED' },
      }),
    ).toBe(1);
  });

  it('rejects unknown preference fields and rate limits settings with Retry-After', async () => {
    const invalid = await authenticatedRequest(currentAccessToken, '/me/notification-preferences', {
      method: 'PATCH',
      body: JSON.stringify({
        userId: randomUUID(),
        preferences: [{ channel: 'EMAIL', type: 'RSVP_CONFIRMED', enabled: false }],
      }),
    });
    expect(invalid.status).toBe(400);

    const session = await createSession();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await authenticatedRequest(
        session.accessToken,
        '/me/notification-preferences',
      );
      expect(response.status).toBe(200);
    }
    const limited = await authenticatedRequest(session.accessToken, '/me/notification-preferences');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  });

  it('accepts one-click unsubscribe idempotently and rejects expired, tampered, and wrong-purpose tokens', async () => {
    const token = unsubscribeService.createToken(currentUserId);
    const unknownUserToken = signUnsubscribeToken({
      purpose: 'email-unsubscribe',
      channel: 'EMAIL',
      userId: randomUUID(),
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    const unknownUserResponse = await fetch(
      `${httpBaseUrl}/unsubscribe?token=${encodeURIComponent(unknownUserToken)}`,
      { method: 'POST' },
    );
    expect(unknownUserResponse.status).toBe(204);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(
        `${httpBaseUrl}/unsubscribe?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
        },
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await fetch(
        `${httpBaseUrl}/unsubscribe?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
        },
      );
      expect(response.status).toBe(204);
    }
    const limited = await fetch(`${httpBaseUrl}/unsubscribe?token=${encodeURIComponent(token)}`, {
      method: 'POST',
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(
      await appPrisma.notificationConsent.count({
        where: {
          userId: currentUserId,
          channel: NotificationChannel.EMAIL,
          source: 'ONE_CLICK',
        },
      }),
    ).toBe(12);
    expect(
      await appPrisma.auditLog.count({
        where: { actorId: currentUserId, action: 'NOTIFICATION_UNSUBSCRIBED' },
      }),
    ).toBe(1);

    const expired = signUnsubscribeToken({
      purpose: 'email-unsubscribe',
      channel: 'EMAIL',
      userId: currentUserId,
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    });
    const wrongPurpose = signUnsubscribeToken({
      purpose: 'push-unsubscribe',
      channel: 'EMAIL',
      userId: currentUserId,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    await unsubscribeService.unsubscribe(expired);
    await unsubscribeService.unsubscribe(`${token}x`);
    await unsubscribeService.unsubscribe(wrongPurpose);
    expect(
      await appPrisma.notificationConsent.count({
        where: { userId: currentUserId, source: 'ONE_CLICK' },
      }),
    ).toBe(12);
  });

  it('validates HTTPS push endpoints, enforces the per-user cap, and audits subscriptions', async () => {
    const keys = { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) };
    const insecure = await authenticatedRequest(currentAccessToken, '/me/push-subscriptions', {
      method: 'POST',
      body: JSON.stringify({ endpoint: 'http://push.example.edu/subscription', keys }),
    });
    expect(insecure.status).toBe(400);
    await expect(
      notificationsService.addPushSubscription(
        { id: currentUserId, role: 'STUDENT', tokenVersion: 0 },
        {
          endpoint: 'https://127.0.0.1/subscription',
          keys,
        },
      ),
    ).rejects.toThrow('The push subscription is invalid.');

    for (let index = 0; index < 5; index += 1) {
      const response = await authenticatedRequest(currentAccessToken, '/me/push-subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          endpoint: `https://push${index}.example.edu/subscription`,
          keys,
        }),
      });
      expect(response.status).toBe(204);
    }
    const capped = await authenticatedRequest(currentAccessToken, '/me/push-subscriptions', {
      method: 'POST',
      body: JSON.stringify({ endpoint: 'https://push5.example.edu/subscription', keys }),
    });
    expect(capped.status).toBe(400);
    expect(await appPrisma.pushSubscription.count({ where: { userId: currentUserId } })).toBe(5);
    expect(
      await appPrisma.auditLog.count({
        where: { actorId: currentUserId, action: 'PUSH_SUBSCRIPTION_CREATED' },
      }),
    ).toBe(5);
  });

  it('deduplicates outbox notifications and creates only one delivery per channel', async () => {
    const notifications = Object.values(NotificationType).map((type) => ({
      userId: currentUserId,
      eventId: null,
      type,
      title: 'Notification type test',
      body: 'Notification type test',
      dedupeKey: `outbox:${currentUserId}:${type}:${randomUUID()}`,
    }));
    await appPrisma.$transaction(async (transaction) => {
      await enqueueNotifications(transaction, notifications);
    });
    await appPrisma.$transaction(async (transaction) => {
      await enqueueNotifications(transaction, notifications);
    });

    const stored = await appPrisma.notification.findMany({
      where: { dedupeKey: { in: notifications.map(({ dedupeKey }) => dedupeKey) } },
      include: { deliveries: true },
    });
    expect(stored).toHaveLength(Object.values(NotificationType).length);
    expect(
      stored.every(
        ({ deliveries }) =>
          deliveries.length === 2 &&
          deliveries.some(({ channel }) => channel === NotificationChannel.EMAIL) &&
          deliveries.some(({ channel }) => channel === NotificationChannel.PUSH),
      ),
    ).toBe(true);
  });

  it('rolls back outbox rows with the parent transaction and keeps email work off the write path', async () => {
    const dedupeKey = `outbox-rollback:${randomUUID()}`;
    const messagesBefore = emailTransport.messages.length;
    await expect(
      appPrisma.$transaction(async (transaction) => {
        await enqueueNotifications(transaction, [
          {
            userId: currentUserId,
            eventId: null,
            type: NotificationType.RSVP_CONFIRMED,
            title: 'Confirmed',
            body: 'Confirmed',
            dedupeKey,
          },
        ]);
        throw new Error('transaction rollback probe');
      }),
    ).rejects.toThrow('transaction rollback probe');
    expect(await appPrisma.notification.count({ where: { dedupeKey } })).toBe(0);
    expect(emailTransport.messages).toHaveLength(messagesBefore);
  });

  it('records an RSVP and both reminders transactionally without sending from the request path', async () => {
    const event = await createEvent(currentUserId);
    const messagesBefore = emailTransport.messages.length;
    emailFailure = new Error('test provider is unavailable');
    const rsvp = await rsvpsRepository.rsvp(event.id, currentUserId, false);
    expect(rsvp.status).toBe(RsvpStatus.GOING);
    expect(await appPrisma.notification.count({ where: { eventId: event.id } })).toBe(3);
    expect(
      await appPrisma.notificationDelivery.count({
        where: {
          notification: { eventId: event.id },
          channel: NotificationChannel.EMAIL,
          status: NotificationDeliveryStatus.PENDING,
        },
      }),
    ).toBe(3);
    expect(emailTransport.messages).toHaveLength(messagesBefore);
  });

  it('promotes a waitlisted attendee with a ticket and reminder deliveries', async () => {
    const event = await createEvent(currentUserId, { capacity: 1 });
    const waitlistedAttendee = await createSession();
    const first = await rsvpsRepository.rsvp(event.id, currentUserId, false);
    const waitlisted = await rsvpsRepository.rsvp(event.id, waitlistedAttendee.userId, false);
    expect(first.status).toBe(RsvpStatus.GOING);
    expect(waitlisted.status).toBe(RsvpStatus.WAITLISTED);

    await rsvpsRepository.cancel(event.id, currentUserId);
    const promotion = await appPrisma.rsvpPromotionOutbox.findFirstOrThrow({
      where: { eventId: event.id, processedAt: null },
    });
    await rsvpsRepository.promoteNextWaitlisted(event.id, promotion.id);

    expect(
      await appPrisma.rsvp.findUniqueOrThrow({
        where: { eventId_userId: { eventId: event.id, userId: waitlistedAttendee.userId } },
      }),
    ).toMatchObject({ status: RsvpStatus.GOING, waitlistPosition: null });
    expect(
      await appPrisma.ticket.findFirst({
        where: {
          rsvp: { eventId: event.id, userId: waitlistedAttendee.userId },
          status: TicketStatus.ISSUED,
        },
      }),
    ).not.toBeNull();
    expect(
      await appPrisma.notification.count({
        where: {
          eventId: event.id,
          userId: waitlistedAttendee.userId,
          type: {
            in: [
              NotificationType.RSVP_CONFIRMED,
              NotificationType.EVENT_REMINDER_24H,
              NotificationType.EVENT_REMINDER_1H,
            ],
          },
        },
      }),
    ).toBe(3);
  });

  it('cancels RSVP reminders and reschedules them when the event time changes', async () => {
    const event = await createEvent(currentUserId);
    await rsvpsRepository.rsvp(event.id, currentUserId, false);
    const initialReminders = await appPrisma.notification.findMany({
      where: {
        eventId: event.id,
        type: { in: [NotificationType.EVENT_REMINDER_24H, NotificationType.EVENT_REMINDER_1H] },
      },
      include: { deliveries: true },
    });
    expect(initialReminders).toHaveLength(2);

    const currentEvent = await appPrisma.event.findUniqueOrThrow({ where: { id: event.id } });
    const newStartAt = new Date(event.startAt.getTime() + 4 * 60 * 60_000);
    const updated = await eventsRepository.updateEvent(
      event.id,
      EventStatus.APPROVED,
      {
        startAt: newStartAt,
        endAt: new Date(event.endAt.getTime() + 4 * 60 * 60_000),
      },
      currentUserId,
      currentEvent.updatedAt,
    );
    expect(updated?.status).toBe(EventStatus.APPROVED);
    expect(
      await appPrisma.notificationDelivery.count({
        where: {
          notification: {
            eventId: event.id,
            type: { in: [NotificationType.EVENT_REMINDER_24H, NotificationType.EVENT_REMINDER_1H] },
          },
          status: NotificationDeliveryStatus.CANCELLED,
        },
      }),
    ).toBe(4);
    const rescheduledReminders = await appPrisma.notification.findMany({
      where: {
        eventId: event.id,
        type: { in: [NotificationType.EVENT_REMINDER_24H, NotificationType.EVENT_REMINDER_1H] },
        dedupeKey: { endsWith: String(newStartAt.getTime()) },
      },
    });
    expect(rescheduledReminders).toHaveLength(2);
    expect(
      await appPrisma.notification.count({
        where: {
          eventId: event.id,
          type: NotificationType.EVENT_UPDATED,
          userId: currentUserId,
        },
      }),
    ).toBe(1);

    await rsvpsRepository.cancel(event.id, currentUserId);
    expect(
      await appPrisma.notification.count({
        where: {
          eventId: event.id,
          type: NotificationType.RSVP_CANCELLED,
          userId: currentUserId,
        },
      }),
    ).toBe(1);
    expect(
      await appPrisma.notificationDelivery.count({
        where: {
          notification: {
            eventId: event.id,
            type: { in: [NotificationType.EVENT_REMINDER_24H, NotificationType.EVENT_REMINDER_1H] },
          },
          status: NotificationDeliveryStatus.CANCELLED,
        },
      }),
    ).toBe(8);
  });

  it('enqueues approval, rejection, and cancellation results for their intended recipients', async () => {
    const approvedEvent = await createEvent(currentUserId, {
      status: EventStatus.PENDING_APPROVAL,
    });
    const beforeApproval = await appPrisma.event.findUniqueOrThrow({
      where: { id: approvedEvent.id },
    });
    await eventsRepository.updateEvent(
      approvedEvent.id,
      EventStatus.PENDING_APPROVAL,
      { status: EventStatus.APPROVED, approvedAt: new Date(), approvedById: currentUserId },
      currentUserId,
      beforeApproval.updatedAt,
    );

    const rejectedEvent = await createEvent(currentUserId, {
      status: EventStatus.PENDING_APPROVAL,
    });
    const beforeRejection = await appPrisma.event.findUniqueOrThrow({
      where: { id: rejectedEvent.id },
    });
    await eventsRepository.updateEvent(
      rejectedEvent.id,
      EventStatus.PENDING_APPROVAL,
      { status: EventStatus.REJECTED, rejectionReason: 'Test rejection' },
      currentUserId,
      beforeRejection.updatedAt,
    );

    const cancelledEvent = await createEvent(currentUserId);
    await rsvpsRepository.rsvp(cancelledEvent.id, currentUserId, false);
    const beforeCancellation = await appPrisma.event.findUniqueOrThrow({
      where: { id: cancelledEvent.id },
    });
    await eventsRepository.updateEvent(
      cancelledEvent.id,
      EventStatus.APPROVED,
      { status: EventStatus.CANCELLED },
      currentUserId,
      beforeCancellation.updatedAt,
    );

    const notifications = await appPrisma.notification.findMany({
      where: { eventId: { in: [approvedEvent.id, rejectedEvent.id, cancelledEvent.id] } },
      select: { eventId: true, userId: true, type: true },
    });
    expect(notifications).toContainEqual({
      eventId: approvedEvent.id,
      userId: currentUserId,
      type: NotificationType.EVENT_APPROVED,
    });
    expect(notifications).toContainEqual({
      eventId: rejectedEvent.id,
      userId: currentUserId,
      type: NotificationType.EVENT_REJECTED,
    });
    expect(
      notifications.filter(
        ({ eventId, type }) =>
          eventId === cancelledEvent.id && type === NotificationType.EVENT_CANCELLED,
      ),
    ).toHaveLength(2);
  });

  it('processes email idempotently across service restarts and moves exhausted retries to dead letter', async () => {
    const { deliveryId } = await enqueueTestNotification(currentUserId);
    const messageCount = emailTransport.messages.length;
    await deliveryService.deliver(deliveryId);
    const restartedDeliveryService = new NotificationDeliveryService(
      appPrisma,
      appConfig,
      rateLimitService,
      unsubscribeService,
      emailProvider,
      pushProvider,
      hostLookup,
    );
    await restartedDeliveryService.deliver(deliveryId);
    expect(emailTransport.messages).toHaveLength(messageCount + 1);
    expect(
      await appPrisma.notificationDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({ status: NotificationDeliveryStatus.SENT, attempts: 1 });

    const failed = await enqueueTestNotification(currentUserId);
    const logger = vi.spyOn(Logger.prototype, 'error');
    const logStart = logger.mock.calls.length;
    emailFailure = new Error('provider failure');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(deliveryService.deliver(failed.deliveryId)).rejects.toThrow(
        'Notification delivery failed.',
      );
    }
    await deliveryService.markDeadLettered(failed.deliveryId);
    expect(
      await appPrisma.notificationDelivery.findUniqueOrThrow({
        where: { id: failed.deliveryId },
      }),
    ).toMatchObject({ status: NotificationDeliveryStatus.DEAD_LETTERED, attempts: 5 });
    const loggedOutput = logger.mock.calls.slice(logStart).flat().join(' ');
    expect(loggedOutput).not.toContain('provider failure');
    expect(loggedOutput).not.toContain(
      (await appPrisma.user.findUniqueOrThrow({ where: { id: currentUserId } })).email,
    );
    logger.mockRestore();
  });

  it('escapes database-sourced message content and strips subject header injection', async () => {
    const event = await createEvent(currentUserId);
    const hostileTitle = 'Campus <img src=x onerror=alert(1)>\r\nBcc: attacker@example.edu';
    await appPrisma.event.update({
      where: { id: event.id },
      data: { title: hostileTitle },
    });
    await appPrisma.user.update({
      where: { id: currentUserId },
      data: { firstName: '<svg onload=alert(1)>' },
    });
    const { deliveryId } = await enqueueTestNotification(currentUserId, { eventId: event.id });
    await deliveryService.deliver(deliveryId);

    const email = emailTransport.messages.find(
      ({ idempotencyKey }) => idempotencyKey === deliveryId,
    )?.email;
    expect(email).toBeDefined();
    expect(email?.subject).not.toMatch(/[\r\n]/);
    expect(email?.subject).toContain('Bcc: attacker@example.edu');
    expect(email?.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(email?.html).toContain('&lt;svg onload=alert(1)&gt;');
    expect(email?.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(email?.html).toContain(`href="http://localhost:3000/events/${event.id}"`);
    expect(email?.text).toContain(`http://localhost:3000/events/${event.id}`);
  });

  it('applies atomic per-user quotas and configures exponential BullMQ retries', async () => {
    const userId = randomUUID();
    const first = await rateLimitService.consumeNotificationQuota(userId, 1, 100_000);
    const second = await rateLimitService.consumeNotificationQuota(userId, 1, 100_000);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);

    const { deliveryId } = await enqueueTestNotification(currentUserId);
    const delivery = await appPrisma.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
      select: { availableAt: true },
    });
    const queue = new Queue(`notifications-integration-${randomUUID()}`, {
      connection: new Redis(redisUrl, { maxRetriesPerRequest: null }),
    });
    try {
      await queue.waitUntilReady();
      const dispatcher = new NotificationOutboxDispatcher(appPrisma, queue);
      await dispatcher.dispatchPending();
      const job = await queue.getJob(
        `notification_${deliveryId}_${delivery.availableAt.getTime()}`,
      );
      expect(job).not.toBeNull();
      expect(job?.name).toBe(NOTIFICATION_DELIVERY_JOB);
      expect(job?.opts.attempts).toBe(MAX_NOTIFICATION_JOB_ATTEMPTS);
      expect(job?.opts.backoff).toEqual({
        type: 'exponential',
        delay: NOTIFICATION_RETRY_DELAY_MS,
      });
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('removes expired push subscriptions and limits push payloads to generic event details', async () => {
    const endpoint = 'https://push.example.edu/subscription';
    await appPrisma.notificationPreference.create({
      data: {
        userId: currentUserId,
        channel: NotificationChannel.PUSH,
        type: NotificationType.RSVP_CONFIRMED,
        enabled: true,
      },
    });
    await notificationsService.addPushSubscription(
      { id: currentUserId, role: 'STUDENT', tokenVersion: 0 },
      { endpoint, keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } },
    );
    const event = await createEvent(currentUserId);
    const { deliveryId } = await enqueueTestNotification(currentUserId, {
      eventId: event.id,
      channel: NotificationChannel.PUSH,
    });
    pushFailureStatus = 410;
    await deliveryService.deliver(deliveryId);
    expect(await appPrisma.pushSubscription.count({ where: { userId: currentUserId } })).toBe(0);
    expect(
      await appPrisma.notificationDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({ status: NotificationDeliveryStatus.SKIPPED });

    await notificationsService.addPushSubscription(
      { id: currentUserId, role: 'STUDENT', tokenVersion: 0 },
      {
        endpoint: 'https://push2.example.edu/subscription',
        keys: { p256dh: 'C'.repeat(87), auth: 'D'.repeat(22) },
      },
    );
    const safeDelivery = await enqueueTestNotification(currentUserId, {
      eventId: event.id,
      channel: NotificationChannel.PUSH,
    });
    pushFailureStatus = undefined;
    await deliveryService.deliver(safeDelivery.deliveryId);
    expect(sentPushPayloads).toEqual([
      {
        title: 'CampusPulse update',
        eventName: 'Notification Integration Event',
        link: `/events/${event.id}`,
      },
    ]);
    expect(JSON.stringify(sentPushPayloads)).not.toContain('example.edu');
    expect(JSON.stringify(sentPushPayloads)).not.toContain(currentUserId);
  });
});
