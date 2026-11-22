import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

function defineConstructorTypes(target: object, parameterTypes: unknown[]): void {
  Reflect.defineMetadata('design:paramtypes', parameterTypes, target);
}

function defineMethodTypes(
  target: { prototype: object },
  methodName: string,
  parameterTypes: unknown[],
): void {
  Reflect.defineMetadata('design:paramtypes', parameterTypes, target.prototype, methodName);
}

export async function installDecoratorMetadataForTsx(): Promise<void> {
  const [
    { AppController },
    { AppService },
    { AuthController },
    { AuthRateLimitService },
    { AuthRepository },
    { AuthService },
    { CheckinManifestQueryDto },
    { CheckinTicketDto },
    { CheckinsController },
    { CheckinsRepository },
    { CheckinsService },
    { CreateEventDto },
    { CreateImageUploadDto },
    { CreateRsvpDto },
    { E2eSessionDto },
    { E2eTestSupportController },
    { EventImageStorageService },
    { EventsController },
    { EventsRepository },
    { EventsService },
    { GlobalApiRateLimitGuard },
    { GoogleOidcService },
    { HealthService },
    { JwtAuthGuard },
    { ListEventAttendeesDto },
    { ListEventsDto },
    { ManualCheckinDto },
    { ManualCheckinLookupDto },
    { MyRsvpsController },
    { PrismaService },
    { RejectEventDto },
    { RolesGuard },
    { RsvpPromotionOutboxDispatcher },
    { RsvpPromotionProcessor },
    { RsvpsController },
    { RsvpsRepository },
    { RsvpsService },
    { SyncCheckinsDto },
    { TicketSigningService },
    { UpdateEventDto },
  ] = await Promise.all([
    import('../../src/app.controller'),
    import('../../src/app.service'),
    import('../../src/auth/auth.controller'),
    import('../../src/auth/auth-rate-limit.service'),
    import('../../src/auth/auth.repository'),
    import('../../src/auth/auth.service'),
    import('../../src/rsvps/dto/checkin-manifest-query.dto'),
    import('../../src/rsvps/dto/checkin-ticket.dto'),
    import('../../src/rsvps/checkins.controller'),
    import('../../src/rsvps/checkins.repository'),
    import('../../src/rsvps/checkins.service'),
    import('../../src/events/dto/create-event.dto'),
    import('../../src/events/dto/create-image-upload.dto'),
    import('../../src/rsvps/dto/create-rsvp.dto'),
    import('./test-support.dto'),
    import('./test-support.controller'),
    import('../../src/events/event-image-storage.service'),
    import('../../src/events/events.controller'),
    import('../../src/events/events.repository'),
    import('../../src/events/events.service'),
    import('../../src/auth/global-api-rate-limit.guard'),
    import('../../src/auth/google-oidc.service'),
    import('../../src/health.service'),
    import('../../src/auth/jwt-auth.guard'),
    import('../../src/rsvps/dto/list-event-attendees.dto'),
    import('../../src/events/dto/list-events.dto'),
    import('../../src/rsvps/dto/manual-checkin.dto'),
    import('../../src/rsvps/dto/manual-checkin-lookup.dto'),
    import('../../src/rsvps/my-rsvps.controller'),
    import('../../src/database/prisma.service'),
    import('../../src/events/dto/reject-event.dto'),
    import('../../src/auth/roles.guard'),
    import('../../src/rsvps/rsvp-promotion-outbox.dispatcher'),
    import('../../src/rsvps/rsvp-promotion.processor'),
    import('../../src/rsvps/rsvps.controller'),
    import('../../src/rsvps/rsvps.repository'),
    import('../../src/rsvps/rsvps.service'),
    import('../../src/rsvps/dto/sync-checkins.dto'),
    import('../../src/rsvps/ticket-signing.service'),
    import('../../src/events/dto/update-event.dto'),
  ]);

  defineConstructorTypes(AppController, [AppService, HealthService]);
  defineConstructorTypes(AuthController, [
    AuthService,
    GoogleOidcService,
    ConfigService,
    AuthRateLimitService,
  ]);
  defineConstructorTypes(AuthRateLimitService, [Object]);
  defineConstructorTypes(AuthRepository, [PrismaService]);
  defineConstructorTypes(AuthService, [ConfigService, AuthRepository]);
  defineConstructorTypes(CheckinsController, [
    CheckinsService,
    AuthRateLimitService,
    ConfigService,
  ]);
  defineConstructorTypes(CheckinsRepository, [PrismaService, TicketSigningService]);
  defineConstructorTypes(CheckinsService, [CheckinsRepository]);
  defineConstructorTypes(E2eTestSupportController, [PrismaService, AuthService]);
  defineConstructorTypes(EventImageStorageService, [ConfigService]);
  defineConstructorTypes(EventsController, [EventsService, AuthRateLimitService]);
  defineConstructorTypes(EventsRepository, [PrismaService]);
  defineConstructorTypes(EventsService, [EventsRepository, EventImageStorageService]);
  defineConstructorTypes(GlobalApiRateLimitGuard, [AuthRateLimitService, Reflector, ConfigService]);
  defineConstructorTypes(GoogleOidcService, [ConfigService]);
  defineConstructorTypes(HealthService, [PrismaService, AuthRateLimitService]);
  defineConstructorTypes(JwtAuthGuard, [
    Reflector,
    AuthService,
    AuthRateLimitService,
    ConfigService,
  ]);
  defineConstructorTypes(MyRsvpsController, [RsvpsService]);
  defineConstructorTypes(PrismaService, [ConfigService]);
  defineConstructorTypes(RolesGuard, [Reflector]);
  defineConstructorTypes(RsvpPromotionOutboxDispatcher, [PrismaService, Object]);
  defineConstructorTypes(RsvpPromotionProcessor, [RsvpsRepository]);
  defineConstructorTypes(RsvpsController, [RsvpsService, AuthRateLimitService, ConfigService]);
  defineConstructorTypes(RsvpsRepository, [PrismaService, TicketSigningService]);
  defineConstructorTypes(RsvpsService, [RsvpsRepository]);
  defineConstructorTypes(TicketSigningService, [ConfigService]);

  defineMethodTypes(AppController, 'getLiveness', []);
  defineMethodTypes(AppController, 'getReadiness', []);
  defineMethodTypes(AuthController, 'getCurrentUser', [Object]);
  defineMethodTypes(CheckinsController, 'getManifest', [Object, String, CheckinManifestQueryDto]);
  defineMethodTypes(CheckinsController, 'checkIn', [Object, String, CheckinTicketDto]);
  defineMethodTypes(CheckinsController, 'syncCheckins', [Object, String, SyncCheckinsDto]);
  defineMethodTypes(CheckinsController, 'lookup', [Object, String, ManualCheckinLookupDto]);
  defineMethodTypes(CheckinsController, 'manualCheckIn', [Object, String, ManualCheckinDto]);
  defineMethodTypes(EventsController, 'list', [Object, ListEventsDto]);
  defineMethodTypes(EventsController, 'get', [Object, String]);
  defineMethodTypes(EventsController, 'create', [Object, CreateEventDto]);
  defineMethodTypes(EventsController, 'update', [Object, String, UpdateEventDto]);
  defineMethodTypes(EventsController, 'submit', [Object, String]);
  defineMethodTypes(EventsController, 'approve', [Object, String]);
  defineMethodTypes(EventsController, 'reject', [Object, String, RejectEventDto]);
  defineMethodTypes(EventsController, 'cancel', [Object, String]);
  defineMethodTypes(EventsController, 'createImageUpload', [Object, String, CreateImageUploadDto]);
  defineMethodTypes(EventsController, 'confirmImageUpload', [Object, String]);
  defineMethodTypes(EventsController, 'getImage', [Object, String, Object]);
  defineMethodTypes(RsvpsController, 'getStatus', [Object, String]);
  defineMethodTypes(RsvpsController, 'listAttendees', [Object, String, ListEventAttendeesDto]);
  defineMethodTypes(RsvpsController, 'rsvp', [Object, String, CreateRsvpDto]);
  defineMethodTypes(RsvpsController, 'cancel', [Object, String]);
  defineMethodTypes(RsvpsController, 'issueTicket', [Object, String]);
  defineMethodTypes(MyRsvpsController, 'listMine', [Object]);
  defineMethodTypes(E2eTestSupportController, 'createFixture', [String]);
  defineMethodTypes(E2eTestSupportController, 'createSession', [
    String,
    String,
    E2eSessionDto,
    Object,
  ]);
  defineMethodTypes(E2eTestSupportController, 'deleteFixture', [String, String, Object]);
}
