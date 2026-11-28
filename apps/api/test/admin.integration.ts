import 'reflect-metadata';
import { Module, RequestMethod, ValidationPipe, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { Reflector } from '@nestjs/core';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminAccessGuard } from '../src/admin/admin-access.guard';
import { AdminController } from '../src/admin/admin.controller';
import { AdminService } from '../src/admin/admin.service';
import { ADMIN_ONLY_KEY } from '../src/auth/auth.decorators';
import { EventsController } from '../src/events/events.controller';
import { EventsService } from '../src/events/events.service';
import { EventsRepository } from '../src/events/events.repository';
import { EventImageStorageService } from '../src/events/event-image-storage.service';
import { VenuesController } from '../src/venues/venues.controller';
import {
  ClubVerificationStatus,
  EventStatus,
  ModerationAction,
  ModerationReportReason,
  ModerationReportStatus,
  ModerationTargetType,
  NotificationType,
  RsvpStatus,
} from '../generated/prisma/client';
import { AnalyticsCacheService } from '../src/analytics/analytics-cache.service';
import { AdminPageDto } from '../src/admin/dto/admin-page.dto';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthRepository } from '../src/auth/auth.repository';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { validateEnvironment, type Environment } from '../src/config/environment';
import { PrismaService } from '../src/database/prisma.service';
import { VenueBookingsRepository } from '../src/venues/venue-bookings.repository';
import { VenueBookingsService } from '../src/venues/venue-bookings.service';
import { VenuesService } from '../src/venues/venues.service';
import { ConfigService } from '@nestjs/config';
import { HttpExceptionFilter } from '../src/http-exception.filter';
import { AnalyticsService } from '../src/analytics/analytics.service';

let authService: AuthService;
let authConfig: ConfigService<Environment, true>;
let authRateLimit: AuthRateLimitService;
let adminService: AdminService;
let analyticsCache: AnalyticsCacheService;
let routeMatrixApp: INestApplication | undefined;
let routeMatrixBaseUrl: string;

Reflect.defineMetadata('design:paramtypes', [AdminService, VenuesService], AdminController);
Reflect.defineMetadata(
  'design:paramtypes',
  [AuthService, ConfigService, AuthRateLimitService],
  AdminAccessGuard,
);
Reflect.defineMetadata(
  'design:paramtypes',
  [AdminPageDto],
  AdminController.prototype,
  'listApprovalQueue',
);

@Module({
  controllers: [AdminController],
  providers: [
    { provide: AuthService, useFactory: () => authService },
    { provide: ConfigService, useFactory: () => authConfig },
    { provide: AuthRateLimitService, useFactory: () => authRateLimit },
    {
      provide: AdminAccessGuard,
      useFactory: () => new AdminAccessGuard(authService, authConfig, authRateLimit),
    },
    { provide: AdminService, useFactory: () => adminService },
    { provide: VenuesService, useValue: {} },
  ],
})
class AdminAccessIntegrationModule {}

const routeMatrixAdminService = new Proxy(Object.create(null) as Record<PropertyKey, unknown>, {
  get(_target, property) {
    if (property === 'then') return undefined;
    if (property === 'requestAdminRoleGrant') {
      return (
        actor: Parameters<AdminService['requestAdminRoleGrant']>[0],
        userId: string,
        familyId: string,
        reason: string,
        ip: string,
      ) => adminService.requestAdminRoleGrant(actor, userId, familyId, reason, ip);
    }
    return async () => ({ data: [] });
  },
});

const routeMatrixService = new Proxy(Object.create(null) as Record<PropertyKey, unknown>, {
  get(_target, property) {
    if (property === 'then') return undefined;
    return async () => ({ data: [] });
  },
});

Reflect.defineMetadata('design:paramtypes', [AdminService, VenuesService], AdminController);
Reflect.defineMetadata(
  'design:paramtypes',
  [EventsService, AuthRateLimitService, AdminService],
  EventsController,
);
Reflect.defineMetadata(
  'design:paramtypes',
  [VenuesService, AuthRateLimitService],
  VenuesController,
);
@Module({
  controllers: [AdminController, EventsController, VenuesController],
  providers: [
    { provide: AdminService, useValue: routeMatrixAdminService },
    { provide: EventsService, useValue: routeMatrixService },
    { provide: VenuesService, useValue: routeMatrixService },
    { provide: AuthService, useFactory: () => authService },
    { provide: ConfigService, useFactory: () => authConfig },
    { provide: AuthRateLimitService, useFactory: () => authRateLimit },
    {
      provide: AdminAccessGuard,
      useFactory: () => new AdminAccessGuard(authService, authConfig, authRateLimit),
    },
  ],
})
class AdminRouteMatrixModule {}

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for admin integration tests.');
}

describe('admin access PostgreSQL/Redis integration', () => {
  let prisma: PrismaService | undefined;
  let app: INestApplication | undefined;
  let baseUrl: string;
  const fixtureUserIds: string[] = [];
  let prismaRedis: Redis | undefined;

  beforeAll(async () => {
    const keyPair = await generateKeyPair('RS256', {
      modulusLength: 2048,
      extractable: true,
    });
    const environment = validateEnvironment({
      NODE_ENV: 'test',
      PORT: 3001,
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      GOOGLE_CLIENT_ID: 'admin-integration-client',
      GOOGLE_CLIENT_SECRET: 'admin-integration-secret',
      GOOGLE_CALLBACK_URL: 'http://localhost:3001/api/v1/auth/google/callback',
      UNIVERSITY_EMAIL_DOMAIN: 'example.edu',
      CAMPUS_TIME_ZONE: 'America/New_York',
      WEB_ORIGIN: 'http://localhost:3000',
      SESSION_SECRET: `${randomUUID()}${randomUUID()}`,
      JWT_PRIVATE_KEY_B64: Buffer.from(await exportPKCS8(keyPair.privateKey)).toString('base64'),
      JWT_PUBLIC_KEY_B64: Buffer.from(await exportSPKI(keyPair.publicKey)).toString('base64'),
      JWT_KEY_ID: 'admin-integration-key',
      TICKET_SIGNING_PRIVATE_KEY_B64: Buffer.from('unused-ticket-private-key').toString('base64'),
      TICKET_SIGNING_PUBLIC_KEY_B64: Buffer.from('unused-ticket-public-key').toString('base64'),
      TICKET_SIGNING_KEY_ID: 'admin-integration-ticket-key',
      JWT_ISSUER: 'https://api.uneventful.test',
      JWT_AUDIENCE: 'uneventful-api',
      REFRESH_TOKEN_TTL_DAYS: 30,
      ADMIN_RATE_LIMIT_PER_MINUTE: 10,
      OBJECT_STORAGE_BUCKET: 'admin-integration',
      OBJECT_STORAGE_REGION: 'us-east-1',
    });
    authConfig = new ConfigService<Environment, true>(environment);
    prisma = new PrismaService(authConfig);
    await prisma.$connect();
    const repository = new AuthRepository(prisma);
    authService = new AuthService(authConfig, repository);
    await authService.onModuleInit();
    authRateLimit = new AuthRateLimitService(new Redis(redisUrl));
    prismaRedis = new Redis(redisUrl);
    analyticsCache = new AnalyticsCacheService(prismaRedis, prisma);
    const bookings = new VenueBookingsService(new VenueBookingsRepository(prisma), authConfig);
    adminService = new AdminService(prisma, authRateLimit, analyticsCache, bookings);

    app = await NestFactory.create(AdminAccessIntegrationModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    const reflector = app.get(Reflector);
    app.useGlobalGuards(
      new JwtAuthGuard(reflector, authService, authRateLimit, authConfig),
      new RolesGuard(reflector),
    );
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') {
      throw new Error('Could not determine admin integration server address.');
    }
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

    routeMatrixApp = await NestFactory.create(AdminRouteMatrixModule, { logger: false });
    routeMatrixApp.setGlobalPrefix('api/v1');
    routeMatrixApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    routeMatrixApp.useGlobalFilters(new HttpExceptionFilter());
    const matrixReflector = routeMatrixApp.get(Reflector);
    routeMatrixApp.useGlobalGuards(
      new JwtAuthGuard(matrixReflector, authService, authRateLimit, authConfig),
      new RolesGuard(matrixReflector),
    );
    await routeMatrixApp.listen(0, '127.0.0.1');
    const matrixAddress = routeMatrixApp.getHttpServer().address();
    if (!matrixAddress || typeof matrixAddress === 'string') {
      throw new Error('Could not determine admin route-matrix server address.');
    }
    routeMatrixBaseUrl = `http://127.0.0.1:${matrixAddress.port}/api/v1`;
  }, 30_000);

  beforeEach(() => {
    fixtureUserIds.splice(0, fixtureUserIds.length);
  });

  afterEach(async () => {
    fixtureUserIds.splice(0, fixtureUserIds.length);
  });

  afterAll(async () => {
    await routeMatrixApp?.close();
    await app?.close();
    authRateLimit?.onModuleDestroy();
    prismaRedis?.disconnect();
    await prisma?.$disconnect();
  });

  it('uses the real access-token session family and masks non-admin and anonymous callers', async () => {
    const admin = await createSession('ADMIN');
    const student = await createSession('STUDENT');
    const endpoint = `${baseUrl}/admin/events/approval-queue`;
    const adminResponse = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${admin.accessToken}` },
    });
    expect(adminResponse.status).toBe(200);
    expect(adminResponse.headers.get('cache-control')).toBe('private, no-store');

    const studentResponse = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${student.accessToken}` },
    });
    const anonymousResponse = await fetch(endpoint);
    const anonymousBody = await anonymousResponse.json();
    expect(studentResponse.status).toBe(404);
    expect(anonymousResponse.status).toBe(404);
    expect(await studentResponse.json()).toEqual(anonymousBody);
    expect(studentResponse.headers.get('cache-control')).toBe('private, no-store');
    expect(anonymousResponse.headers.get('cache-control')).toBe('private, no-store');

    await authService.logout(admin.refreshToken);
    const revokedResponse = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${admin.accessToken}` },
    });
    expect(revokedResponse.status).toBe(404);
    expect(await revokedResponse.json()).toEqual(anonymousBody);
  });

  it('returns 429 with Retry-After after the per-admin request limit', async () => {
    const admin = await createSession('ADMIN');
    const endpoint = `${baseUrl}/admin/events/approval-queue`;
    const responses = await Promise.all(
      Array.from({ length: 11 }, () =>
        fetch(endpoint, { headers: { Authorization: `Bearer ${admin.accessToken}` } }),
      ),
    );
    const limited = responses.find((response) => response.status === 429);
    expect(limited).toBeDefined();
    expect(limited?.headers.get('retry-after')).toMatch(/^\d+$/);
  });

  it('applies the real session-backed admin guard to every Nest-declared admin route', async () => {
    const admin = await createSession('ADMIN');
    const student = await createSession('STUDENT');
    const organizer = await createSession('ORGANIZER');
    const target = await createSession('STUDENT');
    const staleAdmin = await createSession('ADMIN');
    await prisma!.refreshToken.updateMany({
      where: { userId: staleAdmin.principal.id, familyId: staleAdmin.familyId },
      data: {
        createdAt: new Date(Date.now() - 6 * 60_000),
        googleAuthenticatedAt: new Date(Date.now() - 6 * 60_000),
      },
    });

    const controllers = [AdminController, EventsController, VenuesController];
    const routes = controllers.flatMap((controller) => {
      const classPath = Reflect.getMetadata(PATH_METADATA, controller) as string;
      return Object.getOwnPropertyNames(controller.prototype)
        .filter((methodName) => methodName !== 'constructor')
        .flatMap((methodName) => {
          const handler = Object.getOwnPropertyDescriptor(controller.prototype, methodName)?.value;
          if (typeof handler !== 'function') return [];
          const adminOnly =
            Reflect.getMetadata(ADMIN_ONLY_KEY, handler) === true ||
            Reflect.getMetadata(ADMIN_ONLY_KEY, controller) === true;
          if (!adminOnly) return [];
          const routePath = Reflect.getMetadata(PATH_METADATA, handler) as string;
          const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
          const verb =
            requestMethod === RequestMethod.GET
              ? 'get'
              : requestMethod === RequestMethod.POST
                ? 'post'
                : requestMethod === RequestMethod.PATCH
                  ? 'patch'
                  : requestMethod === RequestMethod.DELETE
                    ? 'delete'
                    : 'unknown';
          return [{ path: `/${classPath}/${routePath}`.replace(/\/+/g, '/'), verb, methodName }];
        });
    });
    expect(routes.length).toBeGreaterThan(20);

    const pathFor = (path: string) =>
      path.replace(/:id/g, randomUUID()).replace(/:clubId/g, randomUUID());
    const bodyFor = (path: string): Record<string, unknown> => {
      const body: Record<string, unknown> = { reason: 'Route-matrix authorization fixture.' };
      if (path.includes('/verification')) body.status = ClubVerificationStatus.VERIFIED;
      if (path === '/venues') {
        Object.assign(body, {
          name: 'Route Matrix Venue',
          capacity: 10,
          bufferMinutes: 0,
          availabilityHours: [],
        });
      }
      if (path.includes('/resolve')) body.action = 'DISMISS';
      return body;
    };
    const invoke = async (
      route: (typeof routes)[number],
      session?: Awaited<ReturnType<typeof createSession>>,
    ) => {
      if (session?.principal.role === 'ADMIN') {
        const digest = createHash('sha256').update(session.principal.id).digest('hex');
        await prismaRedis!.del(`uneventful:auth-rate:v1:admin-user:${digest}`);
      }
      let path = pathFor(route.path);
      if (path.includes('/admin/users/') && path.endsWith('/admin-grant-requests')) {
        path = path.replace(/\/admin\/users\/[^/]+\//, `/admin/users/${target.principal.id}/`);
      }
      const query =
        route.verb !== 'get'
          ? ''
          : route.path.endsWith('/audit-logs')
            ? '?limit=1'
            : `?page=1&limit=1${route.path.endsWith('/users') ? '&search=matrix' : ''}`;
      return fetch(`${routeMatrixBaseUrl}${path}${query}`, {
        method: route.verb.toUpperCase(),
        headers: {
          ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
          ...(route.verb === 'get' ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(route.verb === 'get' ? {} : { body: JSON.stringify(bodyFor(route.path)) }),
      });
    };

    for (const route of routes) {
      const anonymous = await invoke(route);
      const studentResponse = await invoke(route, student);
      const organizerResponse = await invoke(route, organizer);
      expect(anonymous.status, `${route.verb.toUpperCase()} ${route.path} anonymous`).toBe(404);
      expect(studentResponse.status, `${route.verb.toUpperCase()} ${route.path} student`).toBe(404);
      expect(organizerResponse.status, `${route.verb.toUpperCase()} ${route.path} organizer`).toBe(
        404,
      );
      const anonymousBody = await anonymous.json();
      expect(await studentResponse.json()).toEqual(anonymousBody);
      expect(await organizerResponse.json()).toEqual(anonymousBody);
      expect(anonymous.headers.get('cache-control')).toBe('private, no-store');

      const allowed = await invoke(route, admin);
      expect(allowed.status, `${route.verb.toUpperCase()} ${route.path} active admin`).toBeLessThan(
        400,
      );

      const staleResponse = await invoke(route, staleAdmin);
      if (route.methodName === 'requestAdminRoleGrant') {
        expect(staleResponse.status).toBe(409);
      } else {
        expect(
          staleResponse.status,
          `${route.verb.toUpperCase()} ${route.path} active-family admin`,
        ).toBeLessThan(400);
      }
    }
  });

  it('requires recent re-authentication and a different admin for role grants', async () => {
    const requester = await createSession('ADMIN');
    const approver = await createSession('ADMIN');
    const target = await createSession('STUDENT');
    const storedSession = await prisma!.refreshToken.findFirstOrThrow({
      where: { userId: requester.principal.id, familyId: requester.familyId },
    });
    const staleAuthentication = new Date(Date.now() - 6 * 60_000);
    await prisma!.refreshToken.updateMany({
      where: { userId: requester.principal.id, familyId: requester.familyId },
      data: { googleAuthenticatedAt: staleAuthentication },
    });
    const refreshedRequester = await authService.refresh(requester.refreshToken);
    await expect(
      adminService.requestAdminRoleGrant(
        requester.principal,
        target.principal.id,
        requester.familyId,
        'Needs administrator access.',
        '127.0.0.1',
      ),
    ).rejects.toThrow('A recent Google sign-in is required.');

    const rotated = await prisma!.refreshToken.findFirstOrThrow({
      where: { id: storedSession.id },
    });
    const activeAfterRotation = await prisma!.refreshToken.findFirstOrThrow({
      where: { userId: requester.principal.id, familyId: requester.familyId, revokedAt: null },
    });
    expect(activeAfterRotation.googleAuthenticatedAt).toEqual(staleAuthentication);
    expect(rotated.revokedAt).not.toBeNull();

    await prisma!.refreshToken.updateMany({
      where: { userId: requester.principal.id, familyId: requester.familyId },
      data: { googleAuthenticatedAt: new Date() },
    });
    const grant = await adminService.requestAdminRoleGrant(
      requester.principal,
      target.principal.id,
      requester.familyId,
      'Needs administrator access.',
      '127.0.0.1',
    );
    const requestAudit = await prisma!.auditLog.findFirstOrThrow({
      where: { entityId: grant.id, action: 'ADMIN_ROLE_GRANT_REQUESTED' },
    });
    expect(requestAudit).toMatchObject({
      actorId: requester.principal.id,
      entityType: 'AdminRoleGrantRequest',
      reason: 'Needs administrator access.',
      actorIp: '127.0.0.1',
      beforeValues: { role: 'STUDENT' },
      afterValues: { status: 'PENDING', targetUserId: target.principal.id },
    });
    expect(requestAudit.createdAt).toBeInstanceOf(Date);
    await expect(
      adminService.approveAdminRoleGrant(
        requester.principal,
        grant.id,
        'Cannot self approve.',
        '127.0.0.1',
      ),
    ).rejects.toThrow('Role grant request not found.');

    await prisma!.adminRoleGrantRequest.update({
      where: { id: grant.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await expect(
      adminService.approveAdminRoleGrant(
        approver.principal,
        grant.id,
        'Approval window elapsed.',
        '127.0.0.1',
      ),
    ).rejects.toThrow('administrator grant request has expired');
    const expiryAudit = await prisma!.auditLog.findFirstOrThrow({
      where: { entityId: grant.id, action: 'ADMIN_ROLE_GRANT_EXPIRED' },
    });
    expect(expiryAudit).toMatchObject({
      actorId: approver.principal.id,
      entityType: 'AdminRoleGrantRequest',
      reason: 'Approval window elapsed.',
      actorIp: '127.0.0.1',
      beforeValues: { status: 'PENDING' },
      afterValues: { status: 'EXPIRED' },
    });
    expect(expiryAudit.createdAt).toBeInstanceOf(Date);

    const successTarget = await createSession('STUDENT');
    const successGrant = await adminService.requestAdminRoleGrant(
      requester.principal,
      successTarget.principal.id,
      requester.familyId,
      'Second-admin approval required.',
      '127.0.0.1',
    );
    await adminService.approveAdminRoleGrant(
      approver.principal,
      successGrant.id,
      'Second administrator approved.',
      '127.0.0.1',
    );
    const approvalAudit = await prisma!.auditLog.findFirstOrThrow({
      where: { entityId: successGrant.id, action: 'ADMIN_ROLE_GRANT_APPROVED' },
    });
    expect(approvalAudit).toMatchObject({
      actorId: approver.principal.id,
      entityType: 'AdminRoleGrantRequest',
      reason: 'Second administrator approved.',
      actorIp: '127.0.0.1',
      beforeValues: { status: 'PENDING' },
      afterValues: { status: 'APPROVED' },
    });
    expect(approvalAudit.createdAt).toBeInstanceOf(Date);
    await expect(authService.authenticateAccessToken(successTarget.accessToken)).rejects.toThrow(
      'Access token is no longer valid.',
    );
    await expect(
      prisma!.user.findUniqueOrThrow({ where: { id: successTarget.principal.id } }),
    ).resolves.toMatchObject({ role: 'ADMIN', tokenVersion: 1 });
    expect(
      await prisma!.notification.count({
        where: {
          userId: successTarget.principal.id,
          type: NotificationType.ACCOUNT_ROLE_CHANGED,
        },
      }),
    ).toBe(1);
    void refreshedRequester;
  });

  it('serializes competing demotions and suspensions so one active administrator always remains', async () => {
    const first = await createSession('ADMIN');
    const second = await createSession('ADMIN');
    const originalAdmins = await prisma!.user.findMany({
      where: { role: 'ADMIN', id: { notIn: [first.principal.id, second.principal.id] } },
      select: { id: true },
    });

    await prisma!.user.updateMany({
      where: { id: { in: originalAdmins.map(({ id }) => id) } },
      data: { role: 'STUDENT', tokenVersion: { increment: 1 } },
    });
    try {
      const demotions = await Promise.allSettled([
        adminService.revokeAdminRole(
          first.principal,
          second.principal.id,
          'Concurrent demotion.',
          '127.0.0.1',
        ),
        adminService.revokeAdminRole(
          second.principal,
          first.principal.id,
          'Concurrent demotion.',
          '127.0.0.1',
        ),
      ]);
      expect(demotions.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(
        await prisma!.user.count({ where: { role: 'ADMIN', isActive: true, deletedAt: null } }),
      ).toBe(1);
      const lastAdministrator = await prisma!.user.findFirstOrThrow({
        where: { role: 'ADMIN', isActive: true, deletedAt: null },
        select: { id: true },
      });
      const differentActor =
        lastAdministrator.id === first.principal.id ? second.principal : first.principal;
      await expect(
        adminService.revokeAdminRole(
          differentActor,
          lastAdministrator.id,
          'Attempt to demote the last administrator.',
          '127.0.0.1',
        ),
      ).rejects.toThrow('The last active administrator cannot be demoted.');
      await expect(
        adminService.setUserActive(
          differentActor,
          lastAdministrator.id,
          false,
          'Attempt to suspend the last administrator.',
          '127.0.0.1',
        ),
      ).rejects.toThrow('The last active administrator cannot be suspended.');
    } finally {
      await prisma!.user.updateMany({
        where: { id: { in: originalAdmins.map(({ id }) => id) } },
        data: { role: 'ADMIN', tokenVersion: { increment: 1 } },
      });
    }

    const third = await createSession('ADMIN');
    const fourth = await createSession('ADMIN');
    const otherAdmins = await prisma!.user.findMany({
      where: { role: 'ADMIN', id: { notIn: [third.principal.id, fourth.principal.id] } },
      select: { id: true },
    });
    await prisma!.user.updateMany({
      where: { id: { in: otherAdmins.map(({ id }) => id) } },
      data: { role: 'STUDENT', tokenVersion: { increment: 1 } },
    });
    try {
      const suspensions = await Promise.allSettled([
        adminService.setUserActive(
          third.principal,
          fourth.principal.id,
          false,
          'Concurrent suspension.',
          '127.0.0.1',
        ),
        adminService.setUserActive(
          fourth.principal,
          third.principal.id,
          false,
          'Concurrent suspension.',
          '127.0.0.1',
        ),
      ]);
      expect(suspensions.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(
        await prisma!.user.count({ where: { role: 'ADMIN', isActive: true, deletedAt: null } }),
      ).toBe(1);
    } finally {
      await prisma!.user.updateMany({
        where: { id: { in: otherAdmins.map(({ id }) => id) } },
        data: { role: 'ADMIN', tokenVersion: { increment: 1 } },
      });
    }
  });

  it('invalidates access and refresh tokens after role, suspension, and club membership changes', async () => {
    const actor = await createSession('ADMIN');
    const roleTarget = await createSession('ADMIN');
    await adminService.revokeAdminRole(
      actor.principal,
      roleTarget.principal.id,
      'Role revoked.',
      '127.0.0.1',
    );
    await expect(authService.authenticateAccessToken(roleTarget.accessToken)).rejects.toThrow();
    const roleRevocationAudit = await prisma!.auditLog.findFirstOrThrow({
      where: { entityId: roleTarget.principal.id, action: 'USER_ROLE_CHANGED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(roleRevocationAudit).toMatchObject({
      actorId: actor.principal.id,
      entityType: 'User',
      reason: 'Role revoked.',
      actorIp: '127.0.0.1',
      beforeValues: { role: 'ADMIN', tokenVersion: 0 },
      afterValues: { role: 'STUDENT', tokenVersion: 1 },
    });
    expect(roleRevocationAudit.createdAt).toBeInstanceOf(Date);
    expect(
      await prisma!.refreshToken.count({
        where: { userId: roleTarget.principal.id, familyId: roleTarget.familyId, revokedAt: null },
      }),
    ).toBe(0);
    expect(
      await prisma!.notification.count({
        where: {
          userId: roleTarget.principal.id,
          type: NotificationType.ACCOUNT_ROLE_CHANGED,
        },
      }),
    ).toBe(1);

    const suspended = await createSession('STUDENT');
    await adminService.setUserActive(
      actor.principal,
      suspended.principal.id,
      false,
      'Account suspended.',
      '127.0.0.1',
    );
    await expect(authService.authenticateAccessToken(suspended.accessToken)).rejects.toThrow();
    const suspensionAudit = await prisma!.auditLog.findFirstOrThrow({
      where: { entityId: suspended.principal.id, action: 'USER_SUSPENDED' },
    });
    expect(suspensionAudit).toMatchObject({
      actorId: actor.principal.id,
      entityType: 'User',
      reason: 'Account suspended.',
      actorIp: '127.0.0.1',
      beforeValues: { isActive: true, tokenVersion: 0 },
      afterValues: { isActive: false, tokenVersion: 1 },
    });
    expect(suspensionAudit.createdAt).toBeInstanceOf(Date);
    expect(
      await prisma!.refreshToken.count({
        where: { userId: suspended.principal.id, familyId: suspended.familyId, revokedAt: null },
      }),
    ).toBe(0);
    expect(
      await prisma!.notification.count({
        where: {
          userId: suspended.principal.id,
          type: NotificationType.ACCOUNT_SUSPENDED,
        },
      }),
    ).toBe(1);
    await expect(
      adminService.setUserActive(
        actor.principal,
        suspended.principal.id,
        false,
        'Repeated suspension.',
        '127.0.0.1',
      ),
    ).rejects.toThrow();
    expect(
      await prisma!.notification.count({
        where: { userId: suspended.principal.id, type: NotificationType.ACCOUNT_SUSPENDED },
      }),
    ).toBe(1);
    await adminService.setUserActive(
      actor.principal,
      suspended.principal.id,
      true,
      'Account reactivated.',
      '127.0.0.1',
    );
    const reactivationAudit = await prisma!.auditLog.findFirstOrThrow({
      where: { entityId: suspended.principal.id, action: 'USER_REACTIVATED' },
    });
    expect(reactivationAudit).toMatchObject({
      actorId: actor.principal.id,
      entityType: 'User',
      reason: 'Account reactivated.',
      actorIp: '127.0.0.1',
      beforeValues: { isActive: false, tokenVersion: 1 },
      afterValues: { isActive: true, tokenVersion: 2 },
    });
    expect(reactivationAudit.createdAt).toBeInstanceOf(Date);
    expect(
      await prisma!.notification.count({
        where: { userId: suspended.principal.id, type: NotificationType.ACCOUNT_REACTIVATED },
      }),
    ).toBe(1);

    const member = await createSession('STUDENT');
    const clubId = await createClub(actor.principal.id);
    await adminService.grantOrganizerMembership(
      actor.principal,
      member.principal.id,
      clubId,
      'Organizer role granted.',
      '127.0.0.1',
    );
    await expect(authService.authenticateAccessToken(member.accessToken)).rejects.toThrow();
    expect(
      await prisma!.refreshToken.count({
        where: { userId: member.principal.id, familyId: member.familyId, revokedAt: null },
      }),
    ).toBe(0);
    expect(
      await prisma!.notification.count({
        where: { userId: member.principal.id, type: NotificationType.ACCOUNT_ROLE_CHANGED },
      }),
    ).toBe(1);

    const organizer = await createSession('ORGANIZER');
    const clubToLeave = await createClub(actor.principal.id);
    const remainingClub = await createClub(actor.principal.id);
    await prisma!.clubMembership.createMany({
      data: [
        { userId: organizer.principal.id, clubId: clubToLeave, role: 'OFFICER', status: 'ACTIVE' },
        {
          userId: organizer.principal.id,
          clubId: remainingClub,
          role: 'OFFICER',
          status: 'ACTIVE',
        },
      ],
    });
    await adminService.revokeOrganizerMembership(
      actor.principal,
      organizer.principal.id,
      clubToLeave,
      'Club membership revoked.',
      '127.0.0.1',
    );
    await expect(authService.authenticateAccessToken(organizer.accessToken)).rejects.toThrow();
    const membershipAudit = await prisma!.auditLog.findFirstOrThrow({
      where: { entityId: clubToLeave, action: 'ORGANIZER_MEMBERSHIP_REVOKED' },
    });
    expect(membershipAudit).toMatchObject({
      actorId: actor.principal.id,
      entityType: 'ClubMembership',
      reason: 'Club membership revoked.',
      actorIp: '127.0.0.1',
      beforeValues: {
        userId: organizer.principal.id,
        clubId: clubToLeave,
        status: 'ACTIVE',
        role: 'OFFICER',
      },
      afterValues: {
        userId: organizer.principal.id,
        clubId: clubToLeave,
        status: 'LEFT',
        role: 'OFFICER',
      },
    });
    expect(membershipAudit.createdAt).toBeInstanceOf(Date);
    const sessionVersionAudit = await prisma!.auditLog.findFirstOrThrow({
      where: { entityId: organizer.principal.id, action: 'USER_SESSION_VERSION_CHANGED' },
    });
    expect(sessionVersionAudit).toMatchObject({
      actorId: actor.principal.id,
      entityType: 'User',
      reason: 'Club membership revoked.',
      actorIp: '127.0.0.1',
      beforeValues: { tokenVersion: 0 },
      afterValues: { tokenVersion: 1 },
    });
    expect(sessionVersionAudit.createdAt).toBeInstanceOf(Date);
    const organizerAfter = await prisma!.user.findUniqueOrThrow({
      where: { id: organizer.principal.id },
    });
    expect(organizerAfter).toMatchObject({ role: 'ORGANIZER', tokenVersion: 1 });
    expect(
      await prisma!.refreshToken.count({
        where: { userId: organizer.principal.id, familyId: organizer.familyId, revokedAt: null },
      }),
    ).toBe(0);
  }, 30_000);

  it('serializes concurrent approval and rejection to one event outcome and one audit entry', async () => {
    const firstAdmin = await createSession('ADMIN');
    const secondAdmin = await createSession('ADMIN');
    const organizer = await createSession('ORGANIZER');
    const fixture = await createModerationFixture(organizer.principal.id);
    await prisma!.event.update({
      where: { id: fixture.eventId },
      data: { status: EventStatus.PENDING_APPROVAL, approvedById: null, approvedAt: null },
    });

    const outcomes = await Promise.allSettled([
      adminService.approveEvent(
        firstAdmin.principal,
        fixture.eventId,
        'Approval race.',
        '192.0.2.21',
      ),
      adminService.rejectEvent(
        secondAdmin.principal,
        fixture.eventId,
        'Rejection race.',
        '192.0.2.22',
      ),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const event = await prisma!.event.findUniqueOrThrow({ where: { id: fixture.eventId } });
    expect([EventStatus.APPROVED, EventStatus.REJECTED]).toContain(event.status);
    const auditRows = await prisma!.auditLog.findMany({
      where: { entityId: fixture.eventId, action: { in: ['EVENT_APPROVED', 'EVENT_REJECTED'] } },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      entityType: 'Event',
      reason: expect.any(String),
      actorIp: expect.stringMatching(/^192\.0\.2\.(21|22)$/),
      beforeValues: { status: EventStatus.PENDING_APPROVAL },
    });
    expect(auditRows[0]?.createdAt).toBeInstanceOf(Date);
    const action = auditRows[0]?.action;
    expect(
      await prisma!.notification.count({
        where: {
          eventId: fixture.eventId,
          type:
            action === 'EVENT_APPROVED'
              ? NotificationType.EVENT_APPROVED
              : NotificationType.EVENT_REJECTED,
        },
      }),
    ).toBe(1);
  });

  it('enforces report uniqueness, rate limits, masked reporter access, and all moderation outcomes', async () => {
    const admin = await createSession('ADMIN');
    const reporter = await createSession('STUDENT');
    const organizer = await createSession('ORGANIZER');
    const dismissedTarget = await createModerationFixture(admin.principal.id);
    const submitted = await adminService.createReport(
      reporter.principal,
      {
        targetType: ModerationTargetType.EVENT,
        targetId: dismissedTarget.eventId,
        reason: ModerationReportReason.SPAM,
      },
      '127.0.0.1',
    );
    await expect(
      adminService.createReport(
        reporter.principal,
        {
          targetType: ModerationTargetType.EVENT,
          targetId: dismissedTarget.eventId,
          reason: ModerationReportReason.OTHER,
        },
        '127.0.0.1',
      ),
    ).rejects.toThrow('A report is already open for this item.');
    await adminService.enforceReportRateLimit(reporter.principal.id, 1);
    await expect(adminService.enforceReportRateLimit(reporter.principal.id, 1)).rejects.toThrow(
      'Too many reports.',
    );

    const listed = await adminService.listReports({ page: 1, limit: 50 });
    expect(JSON.stringify(listed)).toContain(reporter.principal.id);
    const unknownReportList = await fetch(`${routeMatrixBaseUrl}/admin/reports`);
    const organizerReportList = await fetch(`${routeMatrixBaseUrl}/admin/reports`, {
      headers: { Authorization: `Bearer ${organizer.accessToken}` },
    });
    expect(unknownReportList.status).toBe(404);
    expect(organizerReportList.status).toBe(404);
    const unknownReportBody = await unknownReportList.json();
    const organizerReportBody = await organizerReportList.json();
    expect(organizerReportBody).toEqual(unknownReportBody);
    expect(JSON.stringify(organizerReportBody)).not.toContain(reporter.principal.id);

    const cases = [
      { action: ModerationAction.DISMISS, targetType: ModerationTargetType.EVENT },
      { action: ModerationAction.HIDE_EVENT, targetType: ModerationTargetType.EVENT },
      { action: ModerationAction.CANCEL_EVENT, targetType: ModerationTargetType.EVENT },
      { action: ModerationAction.SUSPEND_CLUB, targetType: ModerationTargetType.CLUB },
    ];
    const outcomes: Array<{
      eventId: string;
      clubId: string;
      action: ModerationAction;
      cacheKey: string;
    }> = [];
    for (const [index, testCase] of cases.entries()) {
      const fixture = await createModerationFixture(admin.principal.id);
      const cacheKey = `stage12-report-test:${fixture.eventId}`;
      await analyticsCache.getOrCompute(
        cacheKey,
        [`recommendations:event:index:${fixture.eventId}`],
        (value) => (typeof value === 'string' ? value : null),
        async () => 'cached moderation fixture',
      );
      const targetId =
        testCase.targetType === ModerationTargetType.EVENT ? fixture.eventId : fixture.clubId;
      const report = await adminService.createReport(
        reporter.principal,
        {
          targetType: testCase.targetType,
          targetId,
          reason: ModerationReportReason.UNSAFE,
        },
        '127.0.0.1',
      );
      await adminService.resolveReport(
        admin.principal,
        report.id,
        { action: testCase.action, reason: `Resolution ${index + 1}` },
        '127.0.0.1',
      );
      outcomes.push({
        eventId: fixture.eventId,
        clubId: fixture.clubId,
        action: testCase.action,
        cacheKey,
      });
      const reportAudit = await prisma!.auditLog.findFirstOrThrow({
        where: { entityId: report.id, action: 'MODERATION_REPORT_RESOLVED' },
      });
      expect(reportAudit).toMatchObject({
        actorId: admin.principal.id,
        entityType: 'ModerationReport',
        reason: `Resolution ${index + 1}`,
        actorIp: '127.0.0.1',
        beforeValues: { status: ModerationReportStatus.OPEN },
        afterValues: { status: ModerationReportStatus.RESOLVED, action: testCase.action },
      });
      expect(reportAudit.createdAt).toBeInstanceOf(Date);
      expect(JSON.stringify([reportAudit.beforeValues, reportAudit.afterValues])).not.toContain(
        reporter.email,
      );
    }

    const hidden = outcomes.find(({ action }) => action === ModerationAction.HIDE_EVENT);
    const cancelled = outcomes.find(({ action }) => action === ModerationAction.CANCEL_EVENT);
    const suspendedClub = outcomes.find(({ action }) => action === ModerationAction.SUSPEND_CLUB);
    if (!hidden || !cancelled || !suspendedClub)
      throw new Error('Moderation fixtures were missing.');
    const bookingService = new VenueBookingsService(
      new VenueBookingsRepository(prisma!),
      authConfig,
    );
    const eventService = new EventsService(
      new EventsRepository(prisma!, bookingService),
      {} as EventImageStorageService,
      bookingService,
    );
    const analyticsService = new AnalyticsService(prisma!, authConfig, analyticsCache);
    for (const { eventId } of [hidden, cancelled, suspendedClub]) {
      const event = await prisma!.event.findUniqueOrThrow({ where: { id: eventId } });
      expect(event).toMatchObject({ status: EventStatus.CANCELLED });
      expect(event.deletedAt).toBeInstanceOf(Date);
      expect(
        await prisma!.notification.count({
          where: { eventId, type: NotificationType.EVENT_CANCELLED },
        }),
      ).toBe(1);
      await expect(eventService.get(reporter.principal, eventId)).rejects.toThrow();
      const listed = await eventService.list(reporter.principal, {
        q: event.title,
        page: 1,
        limit: 10,
      });
      expect(listed.data.some(({ id }) => id === eventId)).toBe(false);
      await expect(analyticsService.exportAttendees(admin.principal, eventId)).rejects.toThrow();
    }
    const cancellationAudit = await prisma!.auditLog.findFirstOrThrow({
      where: {
        entityId: suspendedClub.eventId,
        action: 'EVENT_CANCELLED_BY_CLUB_SUSPENSION',
      },
    });
    expect(cancellationAudit).toMatchObject({
      actorId: admin.principal.id,
      entityType: 'Event',
      reason: 'Resolution 4',
      actorIp: '127.0.0.1',
      beforeValues: { status: EventStatus.APPROVED, deletedAt: null },
      afterValues: {
        status: EventStatus.CANCELLED,
        deletedAt: expect.any(String),
      },
    });
    expect(cancellationAudit.createdAt).toBeInstanceOf(Date);
    const clubSuspensionAudit = await prisma!.auditLog.findFirstOrThrow({
      where: {
        entityId: suspendedClub.clubId,
        action: 'CLUB_SUSPENDED_BY_MODERATION',
      },
    });
    expect(clubSuspensionAudit).toMatchObject({
      actorId: admin.principal.id,
      entityType: 'Club',
      reason: 'Resolution 4',
      actorIp: '127.0.0.1',
      beforeValues: { verificationStatus: 'UNVERIFIED' },
      afterValues: { verificationStatus: 'SUSPENDED' },
    });
    expect(clubSuspensionAudit.createdAt).toBeInstanceOf(Date);
    const recommendations = await analyticsService.getRecommendations(reporter.principal);
    expect(
      recommendations.data.some(({ event }) =>
        [hidden.eventId, cancelled.eventId, suspendedClub.eventId].includes(event.id),
      ),
    ).toBe(false);
    for (const outcome of outcomes.filter(({ action }) => action !== ModerationAction.DISMISS)) {
      expect(await prismaRedis!.get(outcome.cacheKey)).toBeNull();
    }

    const reportAudit = await prisma!.auditLog.findFirstOrThrow({
      where: { entityId: submitted.id, action: 'MODERATION_REPORT_SUBMITTED' },
    });
    expect(reportAudit).toMatchObject({
      actorId: reporter.principal.id,
      entityType: 'ModerationReport',
      reason: ModerationReportReason.SPAM,
      actorIp: '127.0.0.1',
    });
    expect(reportAudit.createdAt).toBeInstanceOf(Date);
    const auditValues = JSON.stringify([reportAudit.beforeValues, reportAudit.afterValues]);
    expect(auditValues).not.toContain(reporter.email);
    expect(auditValues).not.toContain(reporter.refreshToken);
    expect(auditValues).not.toContain(reporter.accessToken);
  });

  it('returns emails only through the admin user search and audits admin changes and audit reads', async () => {
    const admin = await createSession('ADMIN');
    const target = await createSession('STUDENT');
    const clubId = await createClub(admin.principal.id);
    const before = await adminService.searchUsers({ page: 1, limit: 50, search: target.email });
    expect(JSON.stringify(before)).toContain(target.email);

    await adminService.grantOrganizerMembership(
      admin.principal,
      target.principal.id,
      clubId,
      'Organizer membership approved.',
      '192.0.2.17',
    );
    const roleAudit = await prisma!.auditLog.findFirstOrThrow({
      where: { entityId: target.principal.id, action: 'USER_ROLE_CHANGED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(roleAudit).toMatchObject({
      actorId: admin.principal.id,
      entityType: 'User',
      reason: 'Organizer membership approved.',
      actorIp: '192.0.2.17',
    });
    expect(roleAudit.beforeValues).toMatchObject({ role: 'STUDENT' });
    expect(roleAudit.afterValues).toMatchObject({ role: 'ORGANIZER' });
    expect(roleAudit.createdAt).toBeInstanceOf(Date);
    const serialized = JSON.stringify([roleAudit.beforeValues, roleAudit.afterValues]);
    expect(serialized).not.toContain(target.email);
    expect(serialized).not.toContain(target.refreshToken);
    expect(serialized).not.toContain(target.accessToken);

    const membershipAudit = await prisma!.auditLog.findFirstOrThrow({
      where: { entityId: clubId, action: 'ORGANIZER_MEMBERSHIP_GRANTED' },
    });
    expect(membershipAudit).toMatchObject({
      actorId: admin.principal.id,
      entityType: 'ClubMembership',
      reason: 'Organizer membership approved.',
      actorIp: '192.0.2.17',
      beforeValues: {
        userId: target.principal.id,
        clubId,
        status: null,
        role: null,
      },
      afterValues: {
        userId: target.principal.id,
        clubId,
        status: 'ACTIVE',
        role: 'OFFICER',
      },
    });
    expect(membershipAudit.createdAt).toBeInstanceOf(Date);
    expect(
      JSON.stringify([membershipAudit.beforeValues, membershipAudit.afterValues]),
    ).not.toContain(target.email);

    const verificationClubId = await createClub(admin.principal.id);
    await adminService.changeClubVerification(
      admin.principal,
      verificationClubId,
      {
        status: ClubVerificationStatus.VERIFIED,
        reason: 'Verification approved.',
      },
      '192.0.2.18',
    );
    const verificationAudit = await prisma!.auditLog.findFirstOrThrow({
      where: { entityId: verificationClubId, action: 'CLUB_VERIFICATION_CHANGED' },
    });
    expect(verificationAudit).toMatchObject({
      actorId: admin.principal.id,
      entityType: 'Club',
      reason: 'Verification approved.',
      actorIp: '192.0.2.18',
      beforeValues: {
        verificationStatus: 'UNVERIFIED',
        verificationReason: null,
        suspendedAt: null,
      },
      afterValues: {
        verificationStatus: 'VERIFIED',
        verificationReason: 'Verification approved.',
        suspendedAt: null,
      },
    });
    expect(verificationAudit.createdAt).toBeInstanceOf(Date);

    const beforeRead = await prisma!.auditLog.count({
      where: { actorId: admin.principal.id, action: 'ADMIN_AUDIT_LOG_READ' },
    });
    await adminService.listAuditLogs(admin.principal, { limit: 10 }, '192.0.2.17');
    expect(
      await prisma!.auditLog.count({
        where: { actorId: admin.principal.id, action: 'ADMIN_AUDIT_LOG_READ' },
      }),
    ).toBe(beforeRead + 1);
  });

  it('hides and cancels future approved club events, invalidates caches, and notifies once', async () => {
    const actor = await createSession('ADMIN');
    const organizer = await createSession('STUDENT');
    const attendee = await createSession('STUDENT');
    const categoryId = randomUUID();
    const clubId = randomUUID();
    const eventId = randomUUID();
    const startAt = new Date(Date.now() + 10 * 24 * 60 * 60_000);
    const endAt = new Date(startAt.getTime() + 60 * 60_000);

    await prisma!.eventCategory.create({
      data: { id: categoryId, name: `Admin ${categoryId}`, slug: `admin-${categoryId}` },
    });
    await prisma!.club.create({
      data: {
        id: clubId,
        name: `Suspension ${clubId}`,
        slug: `suspension-${clubId}`,
        createdById: organizer.principal.id,
      },
    });
    await prisma!.event.create({
      data: {
        id: eventId,
        title: `Future event ${eventId}`,
        slug: `future-${eventId}`,
        description: 'Integration fixture.',
        status: EventStatus.APPROVED,
        startAt,
        endAt,
        timeZone: 'UTC',
        isPublic: true,
        clubId,
        categoryId,
        createdById: organizer.principal.id,
        approvedById: actor.principal.id,
        approvedAt: new Date(),
      },
    });
    await prisma!.rsvp.create({
      data: { eventId, userId: attendee.principal.id, status: RsvpStatus.GOING },
    });

    const cacheKey = `stage12-admin-test:${randomUUID()}`;
    await analyticsCache.getOrCompute(
      cacheKey,
      [`recommendations:event:index:${eventId}`],
      (value) => (typeof value === 'string' ? value : null),
      async () => 'cached recommendation',
    );
    expect(await prismaRedis!.get(cacheKey)).toBe(JSON.stringify('cached recommendation'));

    await adminService.changeClubVerification(
      actor.principal,
      clubId,
      { status: ClubVerificationStatus.SUSPENDED, reason: 'Club suspended for review.' },
      '127.0.0.1',
    );
    await adminService.changeClubVerification(
      actor.principal,
      clubId,
      { status: ClubVerificationStatus.SUSPENDED, reason: 'Club remains suspended.' },
      '127.0.0.1',
    );

    const event = await prisma!.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(event.status).toBe(EventStatus.CANCELLED);
    expect(event.deletedAt).toBeInstanceOf(Date);
    expect(await prismaRedis!.get(cacheKey)).toBeNull();
    expect(
      await prisma!.notification.count({
        where: { eventId, type: NotificationType.EVENT_CANCELLED },
      }),
    ).toBe(2);
  });

  it('audits every exercised admin action with an allowlisted, attributable record', async () => {
    const expectedActions = [
      'CLUB_VERIFICATION_CHANGED',
      'ORGANIZER_MEMBERSHIP_GRANTED',
      'ORGANIZER_MEMBERSHIP_REVOKED',
      'USER_ROLE_CHANGED',
      'USER_SESSION_VERSION_CHANGED',
      'USER_SUSPENDED',
      'USER_REACTIVATED',
      'ADMIN_ROLE_GRANT_REQUESTED',
      'ADMIN_ROLE_GRANT_EXPIRED',
      'ADMIN_ROLE_GRANT_APPROVED',
      'MODERATION_REPORT_SUBMITTED',
      'MODERATION_REPORT_RESOLVED',
      'CLUB_SUSPENDED_BY_MODERATION',
      'EVENT_CANCELLED_BY_CLUB_SUSPENSION',
      'ADMIN_AUDIT_LOG_READ',
    ];
    const possibleApprovalActions = ['EVENT_APPROVED', 'EVENT_REJECTED'];
    const auditRows = await prisma!.auditLog.findMany({
      where: { action: { in: [...expectedActions, ...possibleApprovalActions] } },
      select: {
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
    const observedActions = new Set(auditRows.map(({ action }) => action));
    for (const action of expectedActions) {
      expect(observedActions, `expected audit action ${action}`).toContain(action);
    }
    expect(possibleApprovalActions.some((action) => observedActions.has(action))).toBe(true);

    const allowedFields = new Set([
      'status',
      'role',
      'tokenVersion',
      'targetUserId',
      'requestedById',
      'approvedById',
      'expiresAt',
      'isActive',
      'verificationStatus',
      'verificationReason',
      'suspendedAt',
      'userId',
      'clubId',
      'action',
      'deletedAt',
      'cursor',
      'limit',
      'approvedById',
      'approvedAt',
      'rejectionReason',
      'targetType',
      'targetId',
    ]);
    const assertAllowedValues = (value: unknown) => {
      if (value === null) return;
      expect(typeof value).toBe('object');
      expect(Array.isArray(value)).toBe(false);
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Audit values must be JSON objects or null.');
      }
      for (const key of Object.keys(value)) {
        expect(allowedFields, `audit field ${key}`).toContain(key);
      }
      expect(JSON.stringify(value)).not.toMatch(/accessToken|refreshToken|secret|email|password/i);
    };

    for (const row of auditRows) {
      expect(row.actorId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(row.entityType).toBeTruthy();
      expect(row.reason).toBeTruthy();
      expect(row.actorIp).toBeTruthy();
      expect(row.createdAt).toBeInstanceOf(Date);
      assertAllowedValues(row.beforeValues);
      assertAllowedValues(row.afterValues);
    }
  });

  async function createSession(role: 'STUDENT' | 'ORGANIZER' | 'ADMIN') {
    const userId = randomUUID();
    fixtureUserIds.push(userId);
    const googleSubject = `admin-integration-${userId}`;
    const email = `${googleSubject}@example.edu`;
    await prisma!.user.create({
      data: {
        id: userId,
        googleSubject,
        email,
        firstName: 'Admin',
        lastName: 'Integration',
        role,
      },
    });
    const session = await authService.completeGoogleLogin({
      googleSubject,
      email,
      firstName: 'Admin',
      lastName: 'Integration',
      avatarUrl: null,
    });
    const authenticated = await authService.authenticateAccessTokenSession(session.accessToken);
    return {
      ...session,
      email,
      principal: authenticated.principal,
      familyId: authenticated.familyId,
    };
  }

  async function createModerationFixture(creatorId: string): Promise<{
    eventId: string;
    clubId: string;
  }> {
    const clubId = await createClub(creatorId);
    const categoryId = randomUUID();
    const eventId = randomUUID();
    const startAt = new Date(Date.now() + 5 * 24 * 60 * 60_000);
    await prisma!.eventCategory.create({
      data: { id: categoryId, name: `Moderation ${categoryId}`, slug: `moderation-${categoryId}` },
    });
    await prisma!.event.create({
      data: {
        id: eventId,
        title: `Reportable event ${eventId}`,
        slug: `reportable-${eventId}`,
        description: 'Moderation integration fixture.',
        status: EventStatus.APPROVED,
        startAt,
        endAt: new Date(startAt.getTime() + 60 * 60_000),
        timeZone: 'UTC',
        isPublic: true,
        expectedAttendance: 10,
        clubId,
        categoryId,
        createdById: creatorId,
        approvedById: creatorId,
        approvedAt: new Date(),
      },
    });
    return { eventId, clubId };
  }

  async function createClub(creatorId: string): Promise<string> {
    const id = randomUUID();
    await prisma!.club.create({
      data: {
        id,
        name: `Admin integration club ${id}`,
        slug: `admin-integration-${id}`,
        createdById: creatorId,
      },
    });
    return id;
  }
});
