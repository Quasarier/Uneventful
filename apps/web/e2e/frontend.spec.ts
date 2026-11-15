import { expect, test, type Page } from '@playwright/test';

const eventId = 'b3a3345c-6450-4c36-9bb4-440e07b65bce';
const eventStart = new Date(Date.now() + 86_400_000).toISOString();
const eventEnd = new Date(Date.now() + 90_000_000).toISOString();
const event = {
  id: eventId,
  title: 'Campus Showcase',
  slug: 'campus-showcase',
  description: 'Meet the campus clubs.',
  status: 'APPROVED',
  startAt: eventStart,
  endAt: eventEnd,
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

async function mockStudentApi(page: Page) {
  let going = false;
  await page.context().route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/auth/refresh')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
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
        body: JSON.stringify({
          id: '98de1d25-a8f7-4ee7-9510-cc04a59181ef',
          email: 'student@example.edu',
          firstName: 'Campus',
          lastName: 'Student',
          avatarUrl: null,
          role: 'STUDENT',
        }),
      });
      return;
    }
    if (url.pathname.endsWith('/rsvp/status')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: going ? 'GOING' : null,
          waitlistPosition: null,
          capacity: 50,
          goingCount: going ? 1 : 0,
          isFull: false,
        }),
      });
      return;
    }
    if (url.pathname.endsWith('/rsvp') && request.method() === 'POST') {
      going = true;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        headers: { 'cache-control': 'private, no-store' },
        body: JSON.stringify({
          id: 'f5866ad7-0929-48e8-92c7-948e262b9192',
          eventId,
          status: 'GOING',
          waitlistPosition: null,
        }),
      });
      return;
    }
    if (url.pathname.endsWith(`/events/${eventId}`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(event),
      });
      return;
    }
    if (url.pathname.endsWith('/events')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [event], page: 1, limit: 20, total: 1, totalPages: 1 }),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: '{"statusCode":404,"message":"Not found"}',
    });
  });
}

test('discovers events and updates the RSVP state after confirmation', async ({ page }) => {
  await mockStudentApi(page);
  await page.goto('/events');

  await page.getByRole('link', { name: 'Campus Showcase' }).click();
  await expect(page.getByRole('heading', { name: 'Campus Showcase' })).toBeVisible();
  await page.getByRole('button', { name: 'RSVP' }).click();
  await expect(page.getByText('You’re going.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel RSVP' })).toBeVisible();
});

test('serves an installable manifest and a service worker with no API caching', async ({
  request,
}) => {
  const manifestResponse = await request.get('/manifest.json');
  expect(manifestResponse.ok()).toBe(true);
  const manifest: unknown = await manifestResponse.json();
  expect(manifest).toMatchObject({
    name: 'CampusPulse',
    display: 'standalone',
    start_url: '/events',
  });

  const workerResponse = await request.get('/sw.js');
  expect(workerResponse.ok()).toBe(true);
  const worker = await workerResponse.text();
  expect(worker).toContain("url.pathname.startsWith('/api/')");
  expect(worker).toContain('caches.match(OFFLINE_URL)');
});
