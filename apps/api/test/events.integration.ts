import 'reflect-metadata';
import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Reflector } from '@nestjs/core';
import { EventStatus } from '../generated/prisma/client';
import { AuthService } from '../src/auth/auth.service';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { validateEnvironment, type Environment } from '../src/config/environment';
import { PrismaService } from '../src/database/prisma.service';
import { EventImageStorageService } from '../src/events/event-image-storage.service';
import { EventsController } from '../src/events/events.controller';
import { EventsRepository } from '../src/events/events.repository';
import { EventsService } from '../src/events/events.service';
import { CreateEventDto } from '../src/events/dto/create-event.dto';
import { CreateImageUploadDto } from '../src/events/dto/create-image-upload.dto';
import { RejectEventDto } from '../src/events/dto/reject-event.dto';
import { UpdateEventDto } from '../src/events/dto/update-event.dto';
import { HttpExceptionFilter } from '../src/http-exception.filter';
import type { AuthPrincipal } from '../src/auth/auth.types';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

Reflect.defineMetadata(
  'design:paramtypes',
  [Object, CreateEventDto],
  EventsController.prototype,
  'create',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, UpdateEventDto],
  EventsController.prototype,
  'update',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, RejectEventDto],
  EventsController.prototype,
  'reject',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [Object, String, CreateImageUploadDto],
  EventsController.prototype,
  'createImageUpload',
);

const appDatabaseUrl = process.env.TEST_DATABASE_URL;
const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

if (!appDatabaseUrl || !migrationDatabaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL and TEST_MIGRATION_DATABASE_URL are required for events integration tests.',
  );
}

const roleNames = ['student', 'organizer', 'peer', 'outsider', 'admin'] as const;
type TestRole = (typeof roleNames)[number];
const principals = new Map<TestRole, AuthPrincipal>();
const userIds: string[] = [];
const eventIds: string[] = [];
let appPrisma: PrismaService;
let migrationPrisma: PrismaService;
let app: INestApplication;
let baseUrl: string;
let clubId: string;
let foreignClubId: string;
let categoryId: string;
let approvedEventId: string;
let privateApprovedEventId: string;
let draftEventId: string;
let foreignEventId: string;
let deletedEventId: string;
let imageStorageStub: {
  createUploadForm: ReturnType<typeof vi.fn>;
  sanitizeAndStoreUploadedObject: ReturnType<typeof vi.fn>;
  getFinalImage: ReturnType<typeof vi.fn>;
};
let rateLimitStub: {
  consume: ReturnType<typeof vi.fn>;
};

function configFor(databaseUrl: string): ConfigService<Environment, true> {
  const environment = validateEnvironment({
    NODE_ENV: 'test',
    PORT: 3001,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    GOOGLE_CLIENT_ID: 'events-integration-client',
    GOOGLE_CLIENT_SECRET: 'events-integration-secret',
    GOOGLE_CALLBACK_URL: 'http://localhost:3001/api/v1/auth/google/callback',
    UNIVERSITY_EMAIL_DOMAIN: 'example.edu',
    WEB_ORIGIN: 'http://localhost:3000',
    SESSION_SECRET: `${randomUUID()}${randomUUID()}`,
    JWT_PRIVATE_KEY_B64: Buffer.from('unused-private-key').toString('base64'),
    JWT_PUBLIC_KEY_B64: Buffer.from('unused-public-key').toString('base64'),
    JWT_KEY_ID: 'events-integration-key',
    JWT_ISSUER: 'https://api.uneventful.test',
    JWT_AUDIENCE: 'uneventful-api',
    REFRESH_TOKEN_TTL_DAYS: 30,
    OBJECT_STORAGE_BUCKET: 'events-integration',
    OBJECT_STORAGE_REGION: 'us-east-1',
  });
  return new ConfigService<Environment, true>(environment);
}

const authStub = {
  authenticateAccessToken: async (token: string): Promise<AuthPrincipal> => {
    const principal = [...principals.values()].find((candidate) => candidate.id === token);
    if (!principal) {
      throw new Error('Unknown integration-test bearer token.');
    }
    return principal;
  },
};

let activePrisma: PrismaService;

@Module({
  controllers: [EventsController],
  providers: [
    {
      provide: EventsRepository,
      useFactory: () => new EventsRepository(activePrisma),
    },
    { provide: EventImageStorageService, useFactory: () => imageStorageStub },
    { provide: AuthRateLimitService, useFactory: () => rateLimitStub },
    {
      provide: EventsService,
      useFactory: (repository: EventsRepository, storage: EventImageStorageService) =>
        new EventsService(repository, storage),
      inject: [EventsRepository, EventImageStorageService],
    },
    { provide: AuthService, useValue: authStub },
  ],
})
class EventsIntegrationModule {}

describe('events PostgreSQL/HTTP integration', () => {
  beforeAll(async () => {
    appPrisma = new PrismaService(configFor(appDatabaseUrl!));
    migrationPrisma = new PrismaService(configFor(migrationDatabaseUrl!));
    await Promise.all([appPrisma.$connect(), migrationPrisma.$connect()]);
    activePrisma = appPrisma;

    imageStorageStub = {
      createUploadForm: vi.fn().mockResolvedValue({
        url: 'https://storage.example/upload',
        fields: { key: 'server-generated' },
      }),
      sanitizeAndStoreUploadedObject: vi.fn().mockResolvedValue(undefined),
      getFinalImage: vi.fn().mockResolvedValue({
        body: Buffer.from('normalized image data'),
        contentType: 'image/png',
        extension: 'png',
      }),
    };
    rateLimitStub = { consume: vi.fn().mockResolvedValue(undefined) };

    app = await NestFactory.create(EventsIntegrationModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    const reflector = app.get(Reflector);
    app.useGlobalGuards(
      new JwtAuthGuard(
        reflector,
        app.get(AuthService),
        app.get(AuthRateLimitService),
        configFor(appDatabaseUrl!),
      ),
      new RolesGuard(reflector),
    );
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') {
      throw new Error('Could not determine events integration server address.');
    }
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  });

  beforeEach(async () => {
    imageStorageStub.createUploadForm.mockClear();
    imageStorageStub.sanitizeAndStoreUploadedObject.mockClear();
    imageStorageStub.getFinalImage.mockClear();
    rateLimitStub.consume.mockClear();

    const ids = new Map(roleNames.map((role) => [role, randomUUID()]));
    for (const role of roleNames) {
      const id = ids.get(role)!;
      principals.set(role, {
        id,
        role: role === 'admin' ? 'ADMIN' : role === 'student' ? 'STUDENT' : 'ORGANIZER',
        tokenVersion: 0,
      });
      userIds.push(id);
    }

    await appPrisma.user.createMany({
      data: roleNames.map((role) => ({
        id: ids.get(role)!,
        email: `${role}-${ids.get(role)!}@example.edu`,
        googleSubject: `${role}-${ids.get(role)!}`,
        firstName: role,
        lastName: 'Integration',
        role: role === 'admin' ? 'ADMIN' : role === 'student' ? 'STUDENT' : 'ORGANIZER',
      })),
    });

    clubId = randomUUID();
    foreignClubId = randomUUID();
    categoryId = randomUUID();
    await appPrisma.club.createMany({
      data: [
        {
          id: clubId,
          name: 'Integration Campus Club',
          slug: `integration-${clubId}`,
          createdById: ids.get('admin')!,
        },
        {
          id: foreignClubId,
          name: 'Foreign Integration Club',
          slug: `foreign-${foreignClubId}`,
          createdById: ids.get('admin')!,
        },
      ],
    });
    await appPrisma.eventCategory.create({
      data: { id: categoryId, name: `Integration ${categoryId}`, slug: `events-${categoryId}` },
    });
    await appPrisma.clubMembership.createMany({
      data: [
        { clubId, userId: ids.get('organizer')!, status: 'ACTIVE', joinedAt: new Date() },
        { clubId, userId: ids.get('peer')!, status: 'ACTIVE', joinedAt: new Date() },
        {
          clubId: foreignClubId,
          userId: ids.get('outsider')!,
          status: 'ACTIVE',
          joinedAt: new Date(),
        },
      ],
    });

    draftEventId = await createEvent({
      clubId,
      createdById: ids.get('organizer')!,
      imageKey: `events/${randomUUID()}.png`,
    });
    approvedEventId = await createEvent({
      clubId,
      createdById: ids.get('organizer')!,
      status: EventStatus.APPROVED,
      approvedById: ids.get('admin')!,
      approvedAt: new Date(),
      imageKey: `events/${randomUUID()}.png`,
      rejectionReason: 'Internal review details.',
    });
    privateApprovedEventId = await createEvent({
      clubId,
      createdById: ids.get('organizer')!,
      status: EventStatus.APPROVED,
      approvedById: ids.get('admin')!,
      approvedAt: new Date(),
      isPublic: false,
    });
    foreignEventId = await createEvent({
      clubId: foreignClubId,
      createdById: ids.get('outsider')!,
    });
    deletedEventId = await createEvent({
      clubId,
      createdById: ids.get('organizer')!,
      status: EventStatus.PENDING_APPROVAL,
      deletedAt: new Date(),
    });
  });

  afterEach(async () => {
    if (userIds.length > 0) {
      await migrationPrisma.event.deleteMany({
        where: {
          OR: [{ clubId: { in: [clubId, foreignClubId] } }, { createdById: { in: userIds } }],
        },
      });
      eventIds.splice(0, eventIds.length);
      await migrationPrisma.clubMembership.deleteMany({ where: { userId: { in: userIds } } });
      await migrationPrisma.club.deleteMany({ where: { createdById: { in: userIds } } });
      await migrationPrisma.eventCategory.deleteMany({ where: { id: categoryId } });
      await migrationPrisma.user.deleteMany({
        where: { id: { in: userIds }, auditLogs: { none: {} } },
      });
      userIds.splice(0, userIds.length);
    }
    principals.clear();
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([appPrisma?.$disconnect(), migrationPrisma?.$disconnect()]);
  });

  it('scopes list, detail, and image reads by role and club membership', async () => {
    const listExpectations: Array<[TestRole, string[]]> = [
      ['student', [approvedEventId]],
      ['organizer', [approvedEventId, privateApprovedEventId, draftEventId]],
      ['peer', [approvedEventId, privateApprovedEventId, draftEventId]],
      ['outsider', [approvedEventId, foreignEventId]],
      ['admin', [approvedEventId, privateApprovedEventId, draftEventId, foreignEventId]],
    ];
    for (const [role, expectedIds] of listExpectations) {
      const response = await request(role, 'GET', '/events');
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: Array<
          Record<string, unknown> & {
            id: string;
            rejectionReason: string | null;
            club: Record<string, unknown>;
            category: Record<string, unknown>;
          }
        >;
      };
      const fixtureEventIds = [
        approvedEventId,
        privateApprovedEventId,
        draftEventId,
        foreignEventId,
        deletedEventId,
      ];
      expect(
        body.data
          .map((event) => event.id)
          .filter((id) => fixtureEventIds.includes(id))
          .sort(),
      ).toEqual(expectedIds.sort());
      expect(body.data[0]).not.toHaveProperty('createdById');
      expect(body.data[0]).not.toHaveProperty('approvedById');
      expect(body.data[0]).not.toHaveProperty('imageKey');
      expect(body.data[0]).not.toHaveProperty('pendingImageKey');
      const visibleApprovedEvent = body.data.find((event) => event.id === approvedEventId);
      if (visibleApprovedEvent) {
        const maySeeRejectionReason = role === 'admin' || role === 'organizer' || role === 'peer';
        expect(visibleApprovedEvent.rejectionReason).toBe(
          maySeeRejectionReason ? 'Internal review details.' : null,
        );
        expect(Object.keys(visibleApprovedEvent.club).sort()).toEqual(['name', 'slug']);
        expect(Object.keys(visibleApprovedEvent.category).sort()).toEqual(['name', 'slug']);
        expect(JSON.stringify(visibleApprovedEvent)).not.toContain('@example.edu');
        expect(visibleApprovedEvent.club).not.toHaveProperty('id');
        expect(visibleApprovedEvent.category).not.toHaveProperty('id');
        expect(visibleApprovedEvent.club).not.toHaveProperty('createdById');
        expect(visibleApprovedEvent.category).not.toHaveProperty('createdById');
      }
    }

    for (const role of roleNames) {
      const draftResponse = await request(role, 'GET', `/events/${draftEventId}`);
      const canReadDraft = role === 'organizer' || role === 'peer' || role === 'admin';
      expect(draftResponse.status).toBe(canReadDraft ? 200 : 404);
      const draftImageResponse = await request(role, 'GET', `/events/${draftEventId}/image`);
      expect(draftImageResponse.status).toBe(canReadDraft ? 200 : 404);

      const foreignResponse = await request(role, 'GET', `/events/${foreignEventId}`);
      const canReadForeign = role === 'outsider' || role === 'admin';
      expect(foreignResponse.status).toBe(canReadForeign ? 200 : 404);

      const privateApprovedResponse = await request(
        role,
        'GET',
        `/events/${privateApprovedEventId}`,
      );
      const canReadPrivateApproved = role === 'organizer' || role === 'peer' || role === 'admin';
      expect(privateApprovedResponse.status).toBe(canReadPrivateApproved ? 200 : 404);

      const imageResponse = await request(role, 'GET', `/events/${approvedEventId}/image`);
      const canReadApprovedImage =
        role === 'student' ||
        role === 'organizer' ||
        role === 'peer' ||
        role === 'outsider' ||
        role === 'admin';
      expect(imageResponse.status).toBe(canReadApprovedImage ? 200 : 404);
      if (canReadApprovedImage) {
        expect(imageResponse.headers.get('x-content-type-options')).toBe('nosniff');
        expect(imageResponse.headers.get('content-disposition')).toContain('attachment;');
        expect(imageResponse.headers.get('content-type')).toContain('image/png');
      }
    }

    const unknownImage = await request('student', 'GET', `/events/${randomUUID()}/image`);
    const forbiddenImage = await request('student', 'GET', `/events/${draftEventId}/image`);
    expect(unknownImage.status).toBe(404);
    expect(forbiddenImage.status).toBe(404);
    expect(await unknownImage.json()).toEqual(await forbiddenImage.json());
    expect(rateLimitStub.consume).toHaveBeenCalledWith(
      'event-image-ip',
      expect.any(String),
      120,
      60_000,
      expect.objectContaining({ exceeded: 'Too many image requests. Try again later.' }),
    );
    expect(rateLimitStub.consume).toHaveBeenCalledWith(
      'event-image-user',
      principals.get('student')!.id,
      120,
      60_000,
      expect.any(Object),
    );
  });

  it('serves images with nosniff, attachment, and no-store headers', async () => {
    const response = await request('student', 'GET', `/events/${approvedEventId}/image`);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('exposes rejection reasons only to active club members and admins without nested personal or internal data', async () => {
    for (const role of roleNames) {
      const response = await request(role, 'GET', `/events/${approvedEventId}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        rejectionReason: string | null;
        club: Record<string, unknown>;
        category: Record<string, unknown>;
      };
      const maySeeRejectionReason = role === 'admin' || role === 'organizer' || role === 'peer';
      expect(body.rejectionReason).toBe(maySeeRejectionReason ? 'Internal review details.' : null);
      expect(Object.keys(body.club).sort()).toEqual(['name', 'slug']);
      expect(Object.keys(body.category).sort()).toEqual(['name', 'slug']);
      expect(JSON.stringify(body)).not.toContain('@example.edu');
      expect(body.club).not.toHaveProperty('id');
      expect(body.category).not.toHaveProperty('id');
      expect(body.club).not.toHaveProperty('createdById');
      expect(body.category).not.toHaveProperty('createdById');
    }

    await appPrisma.clubMembership.update({
      where: {
        clubId_userId: { clubId, userId: principals.get('organizer')!.id },
      },
      data: { status: 'LEFT', leftAt: new Date() },
    });
    const formerMemberResponse = await request('organizer', 'GET', `/events/${approvedEventId}`);
    expect(formerMemberResponse.status).toBe(200);
    await expect(formerMemberResponse.json()).resolves.toMatchObject({ rejectionReason: null });
  });

  it('enforces create permissions and sanitizes created descriptions through HTTP', async () => {
    const payload = {
      title: 'Integration-created event',
      description: '<p>Campus event<script>alert(1)</script></p>',
      startAt: '2027-03-01T10:00:00.000Z',
      endAt: '2027-03-01T12:00:00.000Z',
      timeZone: 'UTC',
      isPublic: true,
      clubId,
      categoryId,
    };
    for (const role of roleNames) {
      const response = await request(role, 'POST', '/events', payload);
      const mayCreate = role === 'organizer' || role === 'peer' || role === 'admin';
      expect(response.status).toBe(mayCreate ? 201 : 403);
      if (!mayCreate) {
        continue;
      }
      const body = (await response.json()) as Record<string, unknown> & {
        id: string;
        description: string;
      };
      expect(body.description).not.toContain('<script');
      expect(body.description).not.toContain('alert(1)');
      expect(body).not.toHaveProperty('createdById');
      expect(body).not.toHaveProperty('approvedById');
      expect(body).not.toHaveProperty('imageKey');
      expect(body).not.toHaveProperty('pendingImageKey');
    }
  });

  it.each([
    ['status', EventStatus.APPROVED],
    ['createdById', '00000000-0000-4000-8000-000000000001'],
    ['approvedById', '00000000-0000-4000-8000-000000000002'],
    ['approvedAt', '2027-03-01T10:00:00.000Z'],
  ])('rejects mass-assignment of %s on POST /events', async (field, value) => {
    const before = await appPrisma.event.count();
    const response = await request('organizer', 'POST', '/events', {
      title: 'Mass assignment test',
      description: 'Valid description',
      startAt: '2027-03-01T10:00:00.000Z',
      endAt: '2027-03-01T12:00:00.000Z',
      timeZone: 'UTC',
      isPublic: true,
      clubId,
      categoryId,
      [field]: value,
    });

    expect(response.status).toBe(400);
    expect(await appPrisma.event.count()).toBe(before);
  });

  it.each([
    {
      route: 'update',
      method: 'PATCH',
      path: (id: string) => `/events/${id}`,
      body: { title: 'Edited title' },
      allowedStatus: 200,
    },
    {
      route: 'submit',
      method: 'POST',
      path: (id: string) => `/events/${id}/submit`,
      body: undefined,
      allowedStatus: 201,
    },
    {
      route: 'cancel',
      method: 'POST',
      path: (id: string) => `/events/${id}/cancel`,
      body: undefined,
      allowedStatus: 201,
    },
    {
      route: 'upload initiation',
      method: 'POST',
      path: (id: string) => `/events/${id}/image-upload`,
      body: { contentType: 'image/png', size: 12 },
      allowedStatus: 201,
    },
  ])('protects the $route endpoint against cross-club IDORs', async (testCase) => {
    for (const role of roleNames) {
      const id = await createEvent({ clubId, createdById: principals.get('organizer')!.id });
      const response = await request(role, testCase.method, testCase.path(id), testCase.body);
      const expectedStatus =
        role === 'admin' || role === 'organizer' || role === 'peer'
          ? testCase.allowedStatus
          : role === 'outsider'
            ? 404
            : 403;
      expect(response.status).toBe(expectedStatus);
    }
  });

  it.each([
    ['status', EventStatus.APPROVED],
    ['clubId', '00000000-0000-4000-8000-000000000001'],
    ['createdById', '00000000-0000-4000-8000-000000000002'],
    ['approvedById', '00000000-0000-4000-8000-000000000003'],
    ['approvedAt', '2027-03-01T10:00:00.000Z'],
  ])('rejects mass-assignment of %s on PATCH', async (field, value) => {
    const response = await request('organizer', 'PATCH', `/events/${draftEventId}`, {
      title: 'This update must not be applied',
      [field]: value,
    });

    expect(response.status).toBe(400);
    expect(
      (await appPrisma.event.findUniqueOrThrow({ where: { id: draftEventId } })).title,
    ).toMatch(/^Fixture /);
  });

  it('returns the same 404 for hidden and unknown IDs across state-changing event routes', async () => {
    const cases: Array<{
      name: string;
      role: TestRole;
      method: string;
      path: (id: string) => string;
      hiddenId: string;
      body?: unknown;
    }> = [
      {
        name: 'approve',
        role: 'admin',
        method: 'POST',
        path: (id) => `/events/${id}/approve`,
        hiddenId: deletedEventId,
      },
      {
        name: 'reject',
        role: 'admin',
        method: 'POST',
        path: (id) => `/events/${id}/reject`,
        hiddenId: deletedEventId,
        body: { reason: 'Missing details.' },
      },
      {
        name: 'cancel',
        role: 'organizer',
        method: 'POST',
        path: (id) => `/events/${id}/cancel`,
        hiddenId: foreignEventId,
      },
      {
        name: 'submit',
        role: 'organizer',
        method: 'POST',
        path: (id) => `/events/${id}/submit`,
        hiddenId: foreignEventId,
      },
      {
        name: 'PATCH',
        role: 'organizer',
        method: 'PATCH',
        path: (id) => `/events/${id}`,
        hiddenId: foreignEventId,
        body: { title: 'Hidden event edit' },
      },
      {
        name: 'image-upload',
        role: 'organizer',
        method: 'POST',
        path: (id) => `/events/${id}/image-upload`,
        hiddenId: foreignEventId,
        body: { contentType: 'image/png', size: 12 },
      },
    ];

    for (const testCase of cases) {
      const hidden = await request(
        testCase.role,
        testCase.method,
        testCase.path(testCase.hiddenId),
        testCase.body,
      );
      const unknown = await request(
        testCase.role,
        testCase.method,
        testCase.path(randomUUID()),
        testCase.body,
      );
      expect(hidden.status, testCase.name).toBe(404);
      expect(unknown.status, testCase.name).toBe(404);
      expect(await hidden.json(), testCase.name).toEqual(await unknown.json());
    }
  });

  it('restricts approval and rejection to admins and blocks self-approval', async () => {
    for (const role of roleNames) {
      const pendingId = await createEvent({
        clubId,
        createdById: principals.get('organizer')!.id,
        status: EventStatus.PENDING_APPROVAL,
      });
      const approve = await request(role, 'POST', `/events/${pendingId}/approve`);
      expect(approve.status).toBe(role === 'admin' ? 201 : 403);

      const rejectedId = await createEvent({
        clubId,
        createdById: principals.get('organizer')!.id,
        status: EventStatus.PENDING_APPROVAL,
      });
      const reject = await request(role, 'POST', `/events/${rejectedId}/reject`, {
        reason: 'Please update the event details.',
      });
      expect(reject.status).toBe(role === 'admin' ? 201 : 403);
    }

    const adminId = principals.get('admin')!.id;
    const ownSubmission = await createEvent({
      clubId,
      createdById: adminId,
      status: EventStatus.PENDING_APPROVAL,
    });
    expect((await request('admin', 'POST', `/events/${ownSubmission}/approve`)).status).toBe(403);
    expect((await appPrisma.event.findUniqueOrThrow({ where: { id: ownSubmission } })).status).toBe(
      EventStatus.PENDING_APPROVAL,
    );
  });

  it('binds confirmation to its initiating user and event, and revokes uploader rights after leaving', async () => {
    const organizerId = principals.get('organizer')!.id;
    const originalImageKey = (
      await appPrisma.event.findUniqueOrThrow({ where: { id: draftEventId } })
    ).imageKey;
    const uploadKey = `event-uploads/staging/${draftEventId}/${randomUUID()}.png`;
    await appPrisma.event.update({
      where: { id: draftEventId },
      data: {
        pendingImageKey: uploadKey,
        pendingImageExpiresAt: new Date(Date.now() + 60_000),
        pendingImageOwnerId: organizerId,
      },
    });

    expect(
      (await request('peer', 'POST', `/events/${draftEventId}/image-upload/confirm`)).status,
    ).toBe(404);
    expect(
      (await request('student', 'POST', `/events/${draftEventId}/image-upload/confirm`)).status,
    ).toBe(403);
    expect(
      (await request('outsider', 'POST', `/events/${draftEventId}/image-upload/confirm`)).status,
    ).toBe(404);
    expect(
      (await request('admin', 'POST', `/events/${draftEventId}/image-upload/confirm`)).status,
    ).toBe(404);
    expect(imageStorageStub.sanitizeAndStoreUploadedObject).not.toHaveBeenCalled();
    expect(
      (await appPrisma.event.findUniqueOrThrow({ where: { id: draftEventId } })).imageKey,
    ).toBe(originalImageKey);

    const otherEvent = await createEvent({ clubId, createdById: organizerId });
    await appPrisma.event.update({
      where: { id: otherEvent },
      data: {
        pendingImageKey: uploadKey,
        pendingImageExpiresAt: new Date(Date.now() + 60_000),
        pendingImageOwnerId: organizerId,
      },
    });
    expect(
      (await request('organizer', 'POST', `/events/${otherEvent}/image-upload/confirm`)).status,
    ).toBe(409);
    expect(
      (await appPrisma.event.findUniqueOrThrow({ where: { id: otherEvent } })).imageKey,
    ).toBeNull();

    expect(
      (await request('organizer', 'POST', `/events/${draftEventId}/image-upload/confirm`)).status,
    ).toBe(201);
    const confirmed = await appPrisma.event.findUniqueOrThrow({ where: { id: draftEventId } });
    expect(confirmed.imageKey).toMatch(/^events\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/);
    expect(confirmed.pendingImageOwnerId).toBeNull();

    await appPrisma.clubMembership.update({
      where: { clubId_userId: { clubId, userId: organizerId } },
      data: { status: 'LEFT', leftAt: new Date() },
    });
    expect(
      (await request('organizer', 'PATCH', `/events/${draftEventId}`, { title: 'After leaving' }))
        .status,
    ).toBe(404);
    expect(
      (await request('organizer', 'POST', `/events/${draftEventId}/image-upload/confirm`)).status,
    ).toBe(404);
  });

  it('masks PATCH and cancel with 404 after membership ends', async () => {
    await appPrisma.clubMembership.update({
      where: {
        clubId_userId: { clubId, userId: principals.get('organizer')!.id },
      },
      data: { status: 'LEFT', leftAt: new Date() },
    });

    const hiddenPatch = await request('organizer', 'PATCH', `/events/${draftEventId}`, {
      title: 'Former member edit',
    });
    const unknownPatch = await request('organizer', 'PATCH', `/events/${randomUUID()}`, {
      title: 'Unknown event edit',
    });
    expect(hiddenPatch.status).toBe(404);
    expect(await hiddenPatch.json()).toEqual(await unknownPatch.json());

    const hiddenCancel = await request('organizer', 'POST', `/events/${draftEventId}/cancel`);
    const unknownCancel = await request('organizer', 'POST', `/events/${randomUUID()}/cancel`);
    expect(hiddenCancel.status).toBe(404);
    expect(await hiddenCancel.json()).toEqual(await unknownCancel.json());
  });

  it('returns only the new protected image route, with no direct presigned GET URL endpoint', async () => {
    expect((await request('admin', 'GET', `/events/${approvedEventId}/image-url`)).status).toBe(
      404,
    );
    const response = await request('admin', 'GET', `/events/${approvedEventId}/image`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('normalized image data');
  });
});

async function createEvent(input: {
  clubId: string;
  createdById: string;
  status?: EventStatus;
  approvedById?: string;
  approvedAt?: Date;
  imageKey?: string;
  isPublic?: boolean;
  rejectionReason?: string;
  deletedAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  await appPrisma.event.create({
    data: {
      id,
      title: `Fixture ${id}`,
      slug: `fixture-${id}`,
      description: '<p>Database integration fixture</p>',
      status: input.status ?? EventStatus.DRAFT,
      startAt: new Date('2027-03-01T10:00:00.000Z'),
      endAt: new Date('2027-03-01T12:00:00.000Z'),
      timeZone: 'UTC',
      isPublic: input.isPublic ?? true,
      clubId: input.clubId,
      categoryId,
      createdById: input.createdById,
      approvedById: input.approvedById,
      approvedAt: input.approvedAt,
      rejectionReason: input.rejectionReason,
      imageKey: input.imageKey,
      deletedAt: input.deletedAt,
    },
  });
  eventIds.push(id);
  return id;
}

async function request(
  role: TestRole,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${principals.get(role)!.id}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
