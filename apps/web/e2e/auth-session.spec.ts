import { expect, test, type BrowserContext } from '@playwright/test';

const webOrigin = process.env.NEXT_PUBLIC_WEB_ORIGIN ?? 'http://localhost:3000';
const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api/v1';
const apiOrigin = new URL(apiBaseUrl).origin;
const corsHeaders = {
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'Authorization,Content-Type,X-Uneventful-CSRF',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-origin': webOrigin,
};

function installRefreshMocks(context: BrowserContext) {
  let currentRefreshToken = 'refresh-initial';
  let nextRefreshToken = 0;
  let refreshRequests = 0;

  const ready = context.addCookies([
    {
      name: 'uneventful_refresh',
      value: currentRefreshToken,
      url: apiOrigin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const routes = context.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }

    if (url.pathname.endsWith('/auth/refresh')) {
      refreshRequests += 1;
      const requestCookie = request.headers().cookie ?? '';
      const match = requestCookie.match(/(?:^|;\s*)uneventful_refresh=([^;]+)/);
      if (match?.[1] !== currentRefreshToken) {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          headers: corsHeaders,
          body: JSON.stringify({ statusCode: 401, message: 'Session expired.' }),
        });
        return;
      }

      currentRefreshToken = `refresh-${++nextRefreshToken}`;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          ...corsHeaders,
          'set-cookie': `uneventful_refresh=${currentRefreshToken}; Path=/api/v1/auth; SameSite=Lax; HttpOnly`,
        },
        body: JSON.stringify({
          accessToken: `in-memory-access-${nextRefreshToken}`,
          tokenType: 'Bearer',
          expiresIn: 900,
        }),
      });
      return;
    }

    if (url.pathname.endsWith('/auth/logout')) {
      currentRefreshToken = '';
      await route.fulfill({
        status: 204,
        headers: {
          ...corsHeaders,
          'set-cookie': 'uneventful_refresh=; Max-Age=0; Path=/api/v1/auth; SameSite=Lax; HttpOnly',
        },
      });
      return;
    }

    if (url.pathname.endsWith('/auth/me')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders,
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

    if (url.pathname.endsWith('/events')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({ data: [], page: 1, limit: 20, total: 0, totalPages: 0 }),
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

  return {
    ready: Promise.all([ready, routes]).then(() => undefined),
    refreshCount: () => refreshRequests,
  };
}

test('silently refreshes the in-memory access token after a page reload', async ({ page }) => {
  const sessionMocks = installRefreshMocks(page.context());
  await sessionMocks.ready;
  await page.goto('/events');
  await expect(page.getByRole('heading', { name: 'No events match those filters' })).toBeVisible();
  await expect.poll(sessionMocks.refreshCount).toBe(1);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'No events match those filters' })).toBeVisible();
  await expect.poll(sessionMocks.refreshCount).toBe(2);
  await expect
    .poll(() => page.evaluate(() => [localStorage.length, sessionStorage.length]))
    .toEqual([0, 0]);
});

test('serializes silent refresh across two tabs sharing the refresh cookie', async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: webOrigin });
  const sessionMocks = installRefreshMocks(context);
  await sessionMocks.ready;
  const firstTab = await context.newPage();
  const secondTab = await context.newPage();

  await Promise.all([firstTab.goto('/events'), secondTab.goto('/events')]);
  await expect(
    firstTab.getByRole('heading', { name: 'No events match those filters' }),
  ).toBeVisible();
  await expect(
    secondTab.getByRole('heading', { name: 'No events match those filters' }),
  ).toBeVisible();
  await expect.poll(sessionMocks.refreshCount).toBe(2);

  await context.close();
});

test('logout clears the other tab session and Uneventful caches', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: webOrigin });
  const sessionMocks = installRefreshMocks(context);
  await sessionMocks.ready;
  const firstTab = await context.newPage();
  const secondTab = await context.newPage();

  await firstTab.goto('/events');
  await expect(
    firstTab.getByRole('heading', { name: 'No events match those filters' }),
  ).toBeVisible();
  await secondTab.goto('/events');
  await expect(
    secondTab.getByRole('heading', { name: 'No events match those filters' }),
  ).toBeVisible();
  await firstTab.evaluate(async () => {
    const cache = await caches.open('uneventful-user-data-test');
    await cache.put('/private-test', new Response('private'));
  });

  await firstTab.getByRole('button', { name: 'Sign out' }).click();
  await expect(firstTab).toHaveURL(/\/login$/);
  await expect(secondTab).toHaveURL(/\/login$/);
  await expect
    .poll(() =>
      firstTab.evaluate(async () =>
        (await caches.keys()).filter((name) => name.startsWith('uneventful-')),
      ),
    )
    .toEqual([]);

  await context.close();
});
