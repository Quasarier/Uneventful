import type { Page } from '@playwright/test';
import type { components } from '@/lib/api-schema';

export const testEventId = 'b3a3345c-6450-4c36-9bb4-440e07b65bce';
type CheckinManifest = components['schemas']['CheckinManifest'];

export const testEvent: components['schemas']['Event'] = {
  id: testEventId,
  title: 'Campus Showcase',
  slug: 'campus-showcase',
  description: 'Meet the campus clubs.',
  tags: [],
  status: 'APPROVED',
  startAt: new Date(Date.now() + 86_400_000).toISOString(),
  endAt: new Date(Date.now() + 90_000_000).toISOString(),
  timeZone: 'UTC',
  capacity: 50,
  expectedAttendance: 40,
  isPublic: true,
  venue: null,
  clubId: '4ea0f280-2d60-4a56-a4cf-18b44349269f',
  categoryId: 'c138c747-06dc-4dcf-a24f-0533639e689c',
  rejectionReason: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  hasImage: false,
  club: { name: 'Student Union', slug: 'student-union' },
  category: { name: 'Community', slug: 'community' },
};

const profile = {
  id: '98de1d25-a8f7-4ee7-9510-cc04a59181ef',
  email: 'student@example.edu',
  firstName: 'Campus',
  lastName: 'Student',
  avatarUrl: null,
  role: 'STUDENT',
};

const corsHeaders = {
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'Authorization,Content-Type,X-Uneventful-CSRF',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-origin': process.env.NEXT_PUBLIC_WEB_ORIGIN ?? 'http://localhost:3000',
  'access-control-expose-headers': 'Content-Disposition',
};

const notificationTypes = [
  'EVENT_SUBMITTED',
  'EVENT_APPROVED',
  'EVENT_REJECTED',
  'EVENT_CANCELLED',
  'EVENT_UPDATED',
  'RSVP_CONFIRMED',
  'RSVP_CANCELLED',
  'WAITLISTED',
  'EVENT_REMINDER',
  'EVENT_REMINDER_24H',
  'EVENT_REMINDER_1H',
  'VENUE_BOOKING_UPDATED',
] as const;

const notificationPreferences = ['EMAIL', 'PUSH'].flatMap((channel) =>
  notificationTypes.map((type) => ({
    channel,
    type,
    enabled: channel === 'EMAIL',
  })),
);

export async function mockStudentApi(
  page: Page,
  options: {
    event?: typeof testEvent;
    profile?: typeof profile;
    rsvps?: unknown[];
    checkinManifest?: CheckinManifest;
  } = {},
): Promise<void> {
  const event = options.event ?? testEvent;
  const preferences = notificationPreferences.map((preference) => ({ ...preference }));
  let personalized = true;

  await page.context().route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }

    if (url.pathname.endsWith('/auth/refresh')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({
          accessToken: 'in-memory-test-token',
          tokenType: 'Bearer',
          expiresIn: 900,
        }),
      });
      return;
    }
    if (url.pathname.endsWith('/auth/me')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify(options.profile ?? profile),
      });
      return;
    }
    if (url.pathname.endsWith('/recommendations')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({ data: [], personalized }),
      });
      return;
    }
    if (url.pathname.endsWith('/me/recommendation-preference')) {
      if (request.method() === 'PATCH') {
        personalized = (request.postDataJSON() as { personalized: boolean }).personalized;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({ personalized }),
      });
      return;
    }
    if (url.pathname.endsWith('/me/recommendation-data')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({ deleted: true }),
      });
      return;
    }
    if (/\/clubs\/[^/]+\/follow$/.test(url.pathname)) {
      await route.fulfill({
        status: request.method() === 'POST' ? 201 : 200,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({ followed: request.method() === 'POST' }),
      });
      return;
    }
    if (url.pathname.endsWith('/attendees/export')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/csv',
        headers: {
          ...corsHeaders,
          'content-disposition': 'attachment; filename="event-attendees.csv"',
          'x-content-type-options': 'nosniff',
        },
        body: '\uFEFFDisplay name,Status,Check-in time\r\n',
      });
      return;
    }
    if (/\/events\/[^/]+\/analytics$/.test(url.pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({
          eventId: event.id,
          period: {
            from: new Date(Date.now() - 86_400_000).toISOString(),
            to: new Date().toISOString(),
            bucket: 'day',
          },
          rsvps: { going: 10, waitlisted: 5, cancelled: 5, checkedIn: 5 },
          noShowRate: 10,
          repeatAttendeeRate: 20,
          rsvpsOverTime: [],
          checkInsByTime: [],
          peakSignupHours: [],
        }),
      });
      return;
    }
    if (url.pathname.endsWith('/me/notification-preferences')) {
      if (request.method() === 'PATCH') {
        const body = request.postDataJSON() as {
          preferences?: Array<{ channel: string; type: string; enabled: boolean }>;
        };
        for (const change of body.preferences ?? []) {
          const preference = preferences.find(
            (item) => item.channel === change.channel && item.type === change.type,
          );
          if (preference) {
            preference.enabled = change.enabled;
          }
        }
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({
          data: {
            preferences,
            pushSubscriptionCount: 0,
            vapidPublicKey: 'B'.repeat(87),
          },
        }),
      });
      return;
    }
    if (url.pathname.endsWith('/me/push-subscriptions')) {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    if (url.pathname.endsWith('/rsvp/status')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({
          status: null,
          waitlistPosition: null,
          capacity: event.capacity,
          goingCount: 0,
          isFull: false,
        }),
      });
      return;
    }
    if (url.pathname.endsWith('/rsvps/me')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({ data: options.rsvps ?? [] }),
      });
      return;
    }
    if (url.pathname.endsWith('/checkin-manifest') && options.checkinManifest) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify(options.checkinManifest),
      });
      return;
    }
    if (url.pathname.endsWith(`/events/${event.id}`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify(event),
      });
      return;
    }
    if (url.pathname.endsWith('/events')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({ data: [event], page: 1, limit: 20, total: 1, totalPages: 1 }),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({ statusCode: 404, message: 'Not found' }),
    });
  });
}
