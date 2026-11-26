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
    { AnalyticsCacheService },
    { AnalyticsController },
    { AnalyticsService },
    { AnalyticsQueryDto },
    { RecommendationPreferenceDto },
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
    { CreateVenueDto },
    { CreateRsvpDto },
    { E2eSessionDto },
    { E2eTestSupportController },
    { EventImageStorageService },
    { EventDashboardGateway },
    { EventDashboardRepository },
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
    { NotificationDeliveryProcessor },
    { NotificationDeliveryService },
    { NotificationOutboxDispatcher },
    { NotificationsController },
    { NotificationsService },
    { ResendEmailProvider },
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
    { CheckVenueConflictsDto },
    { UpdateVenueDto },
    { UpdateEventDto },
    { VenueBookingsRepository },
    { VenueBookingsService },
    { VenuesController },
    { VenuesRepository },
    { VenuesService },
    { UnsubscribeService },
    { VapidPushProvider },
  ] = await Promise.all([
    import('../../src/app.controller'),
    import('../../src/app.service'),
    import('../../src/analytics/analytics-cache.service'),
    import('../../src/analytics/analytics.controller'),
    import('../../src/analytics/analytics.service'),
    import('../../src/analytics/dto/analytics-query.dto'),
    import('../../src/analytics/dto/recommendation-preference.dto'),
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
    import('../../src/venues/dto/create-venue.dto'),
    import('../../src/rsvps/dto/create-rsvp.dto'),
    import('./test-support.dto'),
    import('./test-support.controller'),
    import('../../src/events/event-image-storage.service'),
    import('../../src/realtime/event-dashboard.gateway'),
    import('../../src/realtime/event-dashboard.repository'),
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
    import('../../src/notifications/notification-delivery.processor'),
    import('../../src/notifications/notification-delivery.service'),
    import('../../src/notifications/notification-outbox.dispatcher'),
    import('../../src/notifications/notifications.controller'),
    import('../../src/notifications/notifications.service'),
    import('../../src/notifications/email-provider'),
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
    import('../../src/venues/dto/check-venue-conflicts.dto'),
    import('../../src/venues/dto/update-venue.dto'),
    import('../../src/events/dto/update-event.dto'),
    import('../../src/venues/venue-bookings.repository'),
    import('../../src/venues/venue-bookings.service'),
    import('../../src/venues/venues.controller'),
    import('../../src/venues/venues.repository'),
    import('../../src/venues/venues.service'),
    import('../../src/notifications/unsubscribe.service'),
    import('../../src/notifications/web-push-provider'),
  ]);

  defineConstructorTypes(AppController, [AppService, HealthService]);
  defineConstructorTypes(AnalyticsCacheService, [Object, PrismaService]);
  defineConstructorTypes(AnalyticsController, [
    AnalyticsService,
    AuthRateLimitService,
    ConfigService,
  ]);
  defineConstructorTypes(AnalyticsService, [PrismaService, ConfigService, AnalyticsCacheService]);
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
    AnalyticsCacheService,
  ]);
  defineConstructorTypes(CheckinsRepository, [PrismaService, TicketSigningService, Object]);
  defineConstructorTypes(CheckinsService, [CheckinsRepository]);
  defineConstructorTypes(E2eTestSupportController, [PrismaService, AuthService]);
  defineConstructorTypes(EventImageStorageService, [ConfigService]);
  defineConstructorTypes(EventDashboardGateway, [
    AuthService,
    AuthRateLimitService,
    ConfigService,
    EventDashboardRepository,
  ]);
  defineConstructorTypes(EventDashboardRepository, [PrismaService]);
  defineConstructorTypes(EventsController, [EventsService, AuthRateLimitService]);
  defineConstructorTypes(EventsRepository, [PrismaService, VenueBookingsService]);
  defineConstructorTypes(EventsService, [
    EventsRepository,
    EventImageStorageService,
    VenueBookingsService,
  ]);
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
  defineConstructorTypes(NotificationDeliveryProcessor, [NotificationDeliveryService]);
  defineConstructorTypes(NotificationDeliveryService, [
    PrismaService,
    ConfigService,
    AuthRateLimitService,
    UnsubscribeService,
    Object,
    Object,
    Object,
  ]);
  defineConstructorTypes(NotificationOutboxDispatcher, [PrismaService, Object]);
  defineConstructorTypes(NotificationsController, [
    NotificationsService,
    UnsubscribeService,
    AuthRateLimitService,
    ConfigService,
  ]);
  defineConstructorTypes(NotificationsService, [PrismaService, ConfigService, Object]);
  defineConstructorTypes(ResendEmailProvider, [ConfigService]);
  defineConstructorTypes(PrismaService, [ConfigService]);
  defineConstructorTypes(RolesGuard, [Reflector]);
  defineConstructorTypes(RsvpPromotionOutboxDispatcher, [PrismaService, Object]);
  defineConstructorTypes(RsvpPromotionProcessor, [RsvpsRepository]);
  defineConstructorTypes(RsvpsController, [RsvpsService, AuthRateLimitService, ConfigService]);
  defineConstructorTypes(RsvpsRepository, [PrismaService, TicketSigningService]);
  defineConstructorTypes(RsvpsService, [RsvpsRepository, AnalyticsCacheService]);
  defineConstructorTypes(TicketSigningService, [ConfigService]);
  defineConstructorTypes(VenueBookingsRepository, [PrismaService]);
  defineConstructorTypes(VenueBookingsService, [VenueBookingsRepository, ConfigService]);
  defineConstructorTypes(VenuesController, [VenuesService, AuthRateLimitService]);
  defineConstructorTypes(VenuesRepository, [PrismaService]);
  defineConstructorTypes(VenuesService, [VenuesRepository, VenueBookingsService]);
  defineConstructorTypes(UnsubscribeService, [PrismaService, ConfigService]);
  defineConstructorTypes(VapidPushProvider, [ConfigService]);

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
  defineMethodTypes(AnalyticsController, 'eventAnalytics', [Object, String, AnalyticsQueryDto]);
  defineMethodTypes(AnalyticsController, 'clubAnalytics', [Object, String, AnalyticsQueryDto]);
  defineMethodTypes(AnalyticsController, 'exportAttendees', [Object, String, Object]);
  defineMethodTypes(AnalyticsController, 'recommendations', [Object]);
  defineMethodTypes(AnalyticsController, 'getRecommendationPreference', [Object]);
  defineMethodTypes(AnalyticsController, 'updateRecommendationPreference', [
    Object,
    RecommendationPreferenceDto,
  ]);
  defineMethodTypes(AnalyticsController, 'deleteRecommendationData', [Object]);
  defineMethodTypes(AnalyticsController, 'followClub', [Object, String]);
  defineMethodTypes(AnalyticsController, 'unfollowClub', [Object, String]);
  defineMethodTypes(VenuesController, 'list', []);
  defineMethodTypes(VenuesController, 'get', [Object, String]);
  defineMethodTypes(VenuesController, 'checkConflicts', [Object, CheckVenueConflictsDto]);
  defineMethodTypes(VenuesController, 'create', [Object, CreateVenueDto]);
  defineMethodTypes(VenuesController, 'update', [Object, String, UpdateVenueDto]);
  defineMethodTypes(VenuesController, 'retire', [Object, String]);
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
