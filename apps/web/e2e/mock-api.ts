import type { Page } from '@playwright/test';

export const testEventId = 'b3a3345c-6450-4c36-9bb4-440e07b65bce';

export const testEvent = {
  id: testEventId,
  title: 'Campus Showcase',
  slug: 'campus-showcase',
  description: 'Meet the campus clubs.',
  status: 'APPROVED',
  startAt: new Date(Date.now() + 86_400_000).toISOString(),
  endAt: new Date(Date.now() + 90_000_000).toISOString(),
  timeZone: 'UTC',
  capacity: 50,
  isPublic: true,
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
};

export async function mockStudentApi(
  page: Page,
  options: {
    event?: typeof testEvent;
    profile?: typeof profile;
    rsvps?: unknown[];
  } = {},
): Promise<void> {
  const event = options.event ?? testEvent;

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
