import { expect, test, type BrowserContext, type Response } from '@playwright/test';

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api/v1';
const webOrigin = process.env.NEXT_PUBLIC_WEB_ORIGIN ?? 'http://localhost:3000';

function getBypassSecret(): string {
  const secret = process.env.E2E_TEST_AUTH_BYPASS_SECRET;
  if (!secret) {
    throw new Error('E2E_TEST_AUTH_BYPASS_SECRET is required for the real API E2E test.');
  }
  return secret;
}

const bypassSecret = getBypassSecret();
const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQqfjwH4QZYAwAUuwJ7SYuIloAAAAASUVORK5CYII=',
  'base64',
);

test('real API and database support browse, RSVP, waitlist, and cancellation', async ({
  browser,
  request,
}) => {
  const fixtureResponse = await request.post(`${apiBaseUrl}/__test/e2e/fixtures`, {
    headers: { 'x-uneventful-e2e-secret': bypassSecret },
  });
  expect(fixtureResponse.status()).toBe(201);
  const fixture: { fixtureId: string; eventId: string; title: string } =
    await fixtureResponse.json();
  const contexts: BrowserContext[] = [];

  async function createStudentPage(user: 'first' | 'second') {
    const context = await browser.newContext();
    contexts.push(context);
    const sessionResponse = await context.request.post(
      `${apiBaseUrl}/__test/e2e/fixtures/${fixture.fixtureId}/session`,
      {
        headers: { 'x-uneventful-e2e-secret': bypassSecret },
        data: { user },
      },
    );
    expect(sessionResponse.status()).toBe(204);
    const page = await context.newPage();
    await page.goto('/events');
    await expect(page.getByRole('link', { name: fixture.title })).toBeVisible();
    await page.getByRole('link', { name: fixture.title }).click();
    await expect(page.getByRole('heading', { name: fixture.title })).toBeVisible();
    return page;
  }

  try {
    const firstPage = await createStudentPage('first');
    await expect(firstPage.locator('aside [role="status"]')).toContainText('Spots are available.');
    await firstPage.getByRole('button', { name: 'RSVP' }).click();
    await expect(firstPage.locator('aside [role="status"]')).toContainText('You’re going.');

    const secondPage = await createStudentPage('second');
    await expect(secondPage.locator('aside [role="status"]')).toContainText('This event is full.');
    await secondPage.getByRole('button', { name: 'Join waitlist' }).click();
    await expect(secondPage.locator('aside [role="status"]')).toContainText(
      'You’re on the waitlist at position 1.',
    );

    const cancellationResponse = firstPage.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response.url().endsWith(`/events/${fixture.eventId}/rsvp`),
    );
    await firstPage.getByRole('button', { name: 'Cancel RSVP' }).click();
    const cancellation = await cancellationResponse;
    expect(cancellation.status()).toBe(200);
    expect(await cancellation.json()).toMatchObject({ status: 'CANCELLED' });
    await firstPage.reload();
    await expect(firstPage.getByRole('heading', { name: fixture.title })).toBeVisible();
    await expect(firstPage.getByRole('button', { name: 'Cancel RSVP' })).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    const cleanupResponse = await request.delete(
      `${apiBaseUrl}/__test/e2e/fixtures/${fixture.fixtureId}`,
      { headers: { 'x-uneventful-e2e-secret': bypassSecret } },
    );
    expect(cleanupResponse.status(), await cleanupResponse.text()).toBe(204);
  }
});

test('uploads and renders a real event image without CSP or COEP errors', async ({
  browser,
  request,
}) => {
  const fixtureResponse = await request.post(`${apiBaseUrl}/__test/e2e/fixtures`, {
    headers: { 'x-uneventful-e2e-secret': bypassSecret },
  });
  expect(fixtureResponse.status()).toBe(201);
  const fixture: { fixtureId: string; eventId: string; title: string } =
    await fixtureResponse.json();
  const organizerContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const studentContext = await browser.newContext();
  let cleanupFailure: string | null = null;

  try {
    const organizerSession = await organizerContext.request.post(
      `${apiBaseUrl}/__test/e2e/fixtures/${fixture.fixtureId}/session`,
      {
        headers: { 'x-uneventful-e2e-secret': bypassSecret },
        data: { user: 'organizer' },
      },
    );
    expect(organizerSession.status()).toBe(204);

    const refreshResponse = await organizerContext.request.post(`${apiBaseUrl}/auth/refresh`, {
      headers: { Origin: webOrigin, 'X-Uneventful-CSRF': '1' },
    });
    expect(refreshResponse.status()).toBe(200);
    const organizerSessionBody: { accessToken: string } = await refreshResponse.json();
    const authorization = { Authorization: `Bearer ${organizerSessionBody.accessToken}` };

    const uploadFormResponse = await organizerContext.request.post(
      `${apiBaseUrl}/events/${fixture.eventId}/image-upload`,
      {
        headers: authorization,
        data: { contentType: 'image/png', size: imageBytes.length },
      },
    );
    expect(uploadFormResponse.status()).toBe(201);
    const uploadForm: { url: string; fields: Record<string, string> } =
      await uploadFormResponse.json();
    expect(uploadForm.url).toBeTruthy();
    expect(uploadForm.fields.key).toContain(fixture.eventId);
    const uploadResponse = await request.post(
      `${apiBaseUrl}/__test/e2e/fixtures/${fixture.fixtureId}/image`,
      {
        headers: { 'x-uneventful-e2e-secret': bypassSecret },
        data: { imageBase64: imageBytes.toString('base64') },
      },
    );
    expect(uploadResponse.status()).toBe(204);

    const confirmResponse = await organizerContext.request.post(
      `${apiBaseUrl}/events/${fixture.eventId}/image-upload/confirm`,
      { headers: authorization },
    );
    const confirmedEvent = await confirmResponse.json();
    expect(confirmResponse.status(), JSON.stringify(confirmedEvent)).toBe(201);
    expect(confirmedEvent).toMatchObject({ hasImage: true });

    const adminSession = await adminContext.request.post(
      `${apiBaseUrl}/__test/e2e/fixtures/${fixture.fixtureId}/session`,
      {
        headers: { 'x-uneventful-e2e-secret': bypassSecret },
        data: { user: 'admin' },
      },
    );
    expect(adminSession.status()).toBe(204);
    const adminRefresh = await adminContext.request.post(`${apiBaseUrl}/auth/refresh`, {
      headers: { Origin: webOrigin, 'X-Uneventful-CSRF': '1' },
    });
    expect(adminRefresh.status()).toBe(200);
    const adminSessionBody: { accessToken: string } = await adminRefresh.json();
    const approvalResponse = await adminContext.request.post(
      `${apiBaseUrl}/events/${fixture.eventId}/approve`,
      { headers: { Authorization: `Bearer ${adminSessionBody.accessToken}` } },
    );
    expect(approvalResponse.status()).toBe(201);

    const studentSession = await studentContext.request.post(
      `${apiBaseUrl}/__test/e2e/fixtures/${fixture.fixtureId}/session`,
      {
        headers: { 'x-uneventful-e2e-secret': bypassSecret },
        data: { user: 'first' },
      },
    );
    expect(studentSession.status()).toBe(204);
    const studentRefresh = await studentContext.request.post(`${apiBaseUrl}/auth/refresh`, {
      headers: { Origin: webOrigin, 'X-Uneventful-CSRF': '1' },
    });
    expect(studentRefresh.status()).toBe(200);
    const studentSessionBody: { accessToken: string } = await studentRefresh.json();
    const studentEventResponse = await studentContext.request.get(
      `${apiBaseUrl}/events/${fixture.eventId}`,
      { headers: { Authorization: `Bearer ${studentSessionBody.accessToken}` } },
    );
    expect(studentEventResponse.status()).toBe(200);
    expect(await studentEventResponse.json()).toMatchObject({ hasImage: true });
    const studentImageResponse = await studentContext.request.get(
      `${apiBaseUrl}/events/${fixture.eventId}/image`,
      { headers: { Authorization: `Bearer ${studentSessionBody.accessToken}` } },
    );
    expect(studentImageResponse.status(), await studentImageResponse.text()).toBe(200);
    expect(studentImageResponse.headers()['cross-origin-resource-policy']).toBe('cross-origin');

    const page = await studentContext.newPage();
    const securityConsoleErrors: string[] = [];
    let imageResponse: Response | undefined;
    await page.addInitScript(() => {
      window.__imageCspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__imageCspViolations.push(`${event.effectiveDirective}:${event.blockedURI}`);
      });
    });
    page.on('console', (message) => {
      if (
        message.type() === 'error' &&
        /Content Security Policy|Cross-Origin-Embedder-Policy|Cross-Origin-Resource-Policy|NotSameOriginAfterDefaultedToSameOriginByCoep/i.test(
          message.text(),
        )
      ) {
        securityConsoleErrors.push(message.text());
      }
    });
    const observedApiRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith(apiBaseUrl)) {
        observedApiRequests.push(`${request.method()} ${request.url()}`);
      }
    });
    page.on('response', (response) => {
      if (
        response.request().method() === 'GET' &&
        response.url().endsWith(`/events/${fixture.eventId}/image`)
      ) {
        imageResponse = response;
      }
    });
    page.on('pageerror', (error) => securityConsoleErrors.push(error.message));

    await page.goto(`/events/${fixture.eventId}`);
    await expect(page.getByRole('heading', { name: fixture.title })).toBeVisible({
      timeout: 10_000,
    });
    await expect.poll(() => imageResponse?.status(), { timeout: 10_000 }).toBe(200);
    const receivedImageResponse = imageResponse;
    if (!receivedImageResponse) {
      throw new Error(
        `Image response was not observed. API requests: ${observedApiRequests.join(', ')}`,
      );
    }
    expect(receivedImageResponse.status(), await receivedImageResponse.text()).toBe(200);
    expect(receivedImageResponse.headers()['cross-origin-resource-policy']).toBe('cross-origin');
    expect(receivedImageResponse.request().headers()).toHaveProperty('authorization');

    const eventImage = page.getByRole('img', { name: `Event image for ${fixture.title}` });
    await expect(eventImage).toBeVisible();
    await expect
      .poll(() =>
        eventImage.evaluate((image) => {
          const element = image as HTMLImageElement;
          return element.complete && element.naturalWidth > 0;
        }),
      )
      .toBe(true);
    expect(await page.evaluate(() => window.__imageCspViolations)).toEqual([]);
    expect(securityConsoleErrors).toEqual([]);
  } finally {
    await Promise.all([organizerContext.close(), adminContext.close(), studentContext.close()]);
    const cleanupResponse = await request.delete(
      `${apiBaseUrl}/__test/e2e/fixtures/${fixture.fixtureId}`,
      { headers: { 'x-uneventful-e2e-secret': bypassSecret } },
    );
    const cleanupBody = await cleanupResponse.text();
    if (cleanupResponse.status() !== 204) {
      cleanupFailure = `Cleanup failed (${cleanupResponse.status()}): ${cleanupBody}`;
    }
  }
  expect(cleanupFailure).toBeNull();
});

declare global {
  interface Window {
    __imageCspViolations: string[];
  }
}
