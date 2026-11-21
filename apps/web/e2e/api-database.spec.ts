import { expect, test, type BrowserContext } from '@playwright/test';

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api/v1';
function getBypassSecret(): string {
  const secret = process.env.E2E_TEST_AUTH_BYPASS_SECRET;
  if (!secret) {
    throw new Error('E2E_TEST_AUTH_BYPASS_SECRET is required for the real API E2E test.');
  }
  return secret;
}

const bypassSecret = getBypassSecret();

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
    expect(cleanupResponse.status()).toBe(204);
  }
});
