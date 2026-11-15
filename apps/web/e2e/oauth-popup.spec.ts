import { expect, test } from '@playwright/test';

const webOrigin = process.env.NEXT_PUBLIC_WEB_ORIGIN ?? 'http://localhost:3000';
const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api/v1';
const authStartUrl = `${apiBaseUrl}/auth/google`;
const refreshUrl = `${apiBaseUrl}/auth/refresh`;
const authMessage = { type: 'uneventful:auth', success: true };

test('rejects a matching popup source when the message origin is spoofed', async ({ page }) => {
  let refreshRequests = 0;
  await page
    .context()
    .route(authStartUrl, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: 'Mock OAuth' }),
    );
  await page.context().route(refreshUrl, (route) => {
    refreshRequests += 1;
    return route.fulfill({ status: 401 });
  });
  await page.context().route('https://attacker.example.invalid/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<script>window.opener.postMessage(${JSON.stringify(authMessage)}, ${JSON.stringify(webOrigin)});</script>`,
    }),
  );
  await page.goto('/');

  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  const popup = await popupPromise;
  await popup.goto('https://attacker.example.invalid/attack');

  await expect(page.getByRole('status')).toHaveText('Waiting for Google sign-in.');
  await expect.poll(() => refreshRequests).toBe(0);
  expect(new URL(popup.url()).origin).toBe('https://attacker.example.invalid');
});

test('rejects a correct-origin message whose source is not the opened popup', async ({ page }) => {
  let refreshRequests = 0;
  await page
    .context()
    .route(authStartUrl, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: 'Mock OAuth' }),
    );
  await page.context().route(refreshUrl, (route) => {
    refreshRequests += 1;
    return route.fulfill({ status: 401 });
  });
  await page.goto('/');

  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await page.evaluate(
    ({ message, origin }) => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: message,
          origin,
          source: window,
        }),
      );
    },
    { message: authMessage, origin: webOrigin },
  );

  await expect(page.getByRole('status')).toHaveText('Waiting for Google sign-in.');
  await expect.poll(() => refreshRequests).toBe(0);
  expect(popup.isClosed()).toBe(false);
});

test('fetches the session from the API only after a trusted popup success', async ({ page }) => {
  let refreshRequests = 0;
  const csrfHeaders: string[] = [];
  await page.context().route(authStartUrl, (route) =>
    route.fulfill({
      status: 303,
      headers: {
        location: `${webOrigin}/auth/popup?status=success`,
      },
    }),
  );
  await page.context().route(refreshUrl, (route) => {
    refreshRequests += 1;
    csrfHeaders.push(route.request().headers()['x-uneventful-csrf'] ?? '');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': webOrigin,
        'access-control-allow-credentials': 'true',
      },
      body: JSON.stringify({
        accessToken: 'test-token-returned-by-session-api',
        tokenType: 'Bearer',
        expiresIn: 900,
      }),
    });
  });
  await page.goto('/');
  await page.evaluate(() => {
    window.addEventListener('message', (event) => {
      if (event.origin === window.location.origin) {
        document.documentElement.dataset.authMessage = JSON.stringify(event.data);
      }
    });
  });

  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await popupPromise;

  await expect(page.getByRole('status')).toHaveText('Signed in.');
  await expect(page.locator('html')).toHaveAttribute(
    'data-auth-message',
    JSON.stringify(authMessage),
  );
  expect(refreshRequests).toBe(1);
  expect(csrfHeaders).toEqual(['1']);
});
