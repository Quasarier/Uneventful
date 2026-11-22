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

test('scans tickets online and offline, syncs queued hashes, and clears local data on logout', async ({
  browser,
  request,
}) => {
  const fixtureResponse = await request.post(`${apiBaseUrl}/__test/e2e/fixtures`, {
    headers: { 'x-uneventful-e2e-secret': bypassSecret },
  });
  expect(fixtureResponse.status()).toBe(201);
  const fixture: { fixtureId: string; eventId: string; title: string } =
    await fixtureResponse.json();
  const studentContext = await browser.newContext();
  const organizerContext = await browser.newContext();

  try {
    for (const [context, user] of [
      [studentContext, 'first'],
      [organizerContext, 'organizer'],
    ] as const) {
      const sessionResponse = await context.request.post(
        `${apiBaseUrl}/__test/e2e/fixtures/${fixture.fixtureId}/session`,
        {
          headers: { 'x-uneventful-e2e-secret': bypassSecret },
          data: { user },
        },
      );
      expect(sessionResponse.status()).toBe(204);
    }

    const studentRefresh = await studentContext.request.post(`${apiBaseUrl}/auth/refresh`, {
      headers: { Origin: webOrigin, 'X-Uneventful-CSRF': '1' },
    });
    expect(studentRefresh.status()).toBe(200);
    const studentSession: { accessToken: string } = await studentRefresh.json();
    const rsvpResponse = await studentContext.request.post(
      `${apiBaseUrl}/events/${fixture.eventId}/rsvp`,
      { headers: { Authorization: `Bearer ${studentSession.accessToken}` }, data: {} },
    );
    const rsvpText = await rsvpResponse.text();
    expect(rsvpResponse.status(), rsvpText).toBe(201);
    const rsvp: { ticketToken?: string } = JSON.parse(rsvpText);
    expect(rsvp.ticketToken).toBeTruthy();

    const organizerRefresh = await organizerContext.request.post(`${apiBaseUrl}/auth/refresh`, {
      headers: { Origin: webOrigin, 'X-Uneventful-CSRF': '1' },
    });
    expect(organizerRefresh.status()).toBe(200);
    const organizerSession: { accessToken: string } = await organizerRefresh.json();

    const page = await organizerContext.newPage();
    await page.addInitScript(() => {
      window.__qrTicketToken = '';
      class TestBarcodeDetector {
        async detect() {
          return window.__qrTicketToken ? [{ rawValue: window.__qrTicketToken }] : [];
        }
      }
      Object.defineProperty(window, 'BarcodeDetector', {
        configurable: true,
        value: TestBarcodeDetector,
      });
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => new MediaStream() },
      });
      Object.defineProperty(HTMLMediaElement.prototype, 'play', {
        configurable: true,
        value: () => Promise.resolve(),
      });
      Object.defineProperty(HTMLVideoElement.prototype, 'readyState', {
        configurable: true,
        get: () => HTMLMediaElement.HAVE_CURRENT_DATA,
      });
    });
    const manifestResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/events/${fixture.eventId}/checkin-manifest`) &&
        response.status() === 200,
    );
    await page.goto(`/events/${fixture.eventId}/scanner`);
    await manifestResponse;
    await expect(page.getByText(/0 offline scans queued/)).toBeVisible();
    await page.evaluate((token) => {
      window.__qrTicketToken = token;
    }, rsvp.ticketToken!);

    const onlineCheckin = await page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/events/${fixture.eventId}/checkins`),
    );
    await expect(page.getByText('VALID', { exact: true })).toBeVisible();
    expect(onlineCheckin.status()).toBe(201);

    await page.context().setOffline(true);
    await page.getByRole('button', { name: 'Scan another' }).click();
    await expect(page.getByText(/1 offline scan queued/)).toBeVisible();
    const persistedOfflineData = await page.evaluate(
      () =>
        new Promise<string>((resolve, reject) => {
          const request = indexedDB.open('uneventful-checkin', 1);
          request.onerror = () => reject(new Error('Could not inspect scanner storage.'));
          request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction(['manifests', 'scans'], 'readonly');
            const manifests = transaction.objectStore('manifests').getAll();
            const scans = transaction.objectStore('scans').getAll();
            transaction.oncomplete = () => {
              resolve(JSON.stringify({ manifests: manifests.result, scans: scans.result }));
              database.close();
            };
          };
        }),
    );
    expect(persistedOfflineData).toContain('ticketIdHash');
    expect(persistedOfflineData).not.toContain(rsvp.ticketToken!);
    expect(persistedOfflineData).not.toContain(organizerSession.accessToken);

    const syncResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/events/${fixture.eventId}/checkins/sync`),
    );
    await page.context().setOffline(false);
    expect((await syncResponse).status()).toBe(201);
    await expect(page.getByText('ALREADY USED', { exact: true })).toBeVisible();
    await expect(page.getByText(/0 offline scans queued/)).toBeVisible();

    await page.route(`**/events/${fixture.eventId}/checkins/sync`, (route) => route.abort());
    await page.context().setOffline(true);
    await page.getByRole('button', { name: 'Scan another' }).click();
    await expect(page.getByText(/1 offline scan queued/)).toBeVisible();
    const blockedSync = page.waitForEvent('requestfailed', {
      predicate: (failedRequest) =>
        failedRequest.method() === 'POST' &&
        failedRequest.url().endsWith(`/events/${fixture.eventId}/checkins/sync`),
    });
    await page.context().setOffline(false);
    await blockedSync;
    await expect(page.getByText(/1 offline scan queued/)).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    const localCounts = await page.evaluate(
      () =>
        new Promise<{ manifests: number; scans: number }>((resolve, reject) => {
          const request = indexedDB.open('uneventful-checkin', 1);
          request.onerror = () => reject(new Error('Could not verify scanner storage cleanup.'));
          request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction(['manifests', 'scans'], 'readonly');
            const manifests = transaction.objectStore('manifests').count();
            const scans = transaction.objectStore('scans').count();
            transaction.oncomplete = () => {
              resolve({ manifests: manifests.result, scans: scans.result });
              database.close();
            };
          };
        }),
    );
    expect(localCounts).toEqual({ manifests: 0, scans: 0 });
  } finally {
    await Promise.all([studentContext.close(), organizerContext.close()]);
    const cleanupResponse = await request.delete(
      `${apiBaseUrl}/__test/e2e/fixtures/${fixture.fixtureId}`,
      { headers: { 'x-uneventful-e2e-secret': bypassSecret } },
    );
    expect(cleanupResponse.status(), await cleanupResponse.text()).toBe(204);
  }
});

declare global {
  interface Window {
    __imageCspViolations: string[];
    __qrTicketToken: string;
  }
}
