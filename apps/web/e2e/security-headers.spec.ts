import { expect, test } from '@playwright/test';
import { mockStudentApi } from './mock-api';

const pagePaths = ['/login', '/events', '/clubs', '/calendar', '/tickets', '/profile'];

test('sets security headers and a per-response nonce on main pages', async ({ page }) => {
  await mockStudentApi(page);
  const nonces: string[] = [];

  for (const path of pagePaths) {
    const response = await page.goto(path);
    expect(response, `${path} should return a document response`).not.toBeNull();
    const headers = response!.headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
    expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(headers['strict-transport-security']).toBe('max-age=31536000');
    expect(headers['content-security-policy-report-only']).toBeUndefined();
    const policy = headers['content-security-policy'];
    if (!policy) {
      throw new Error(`${path} should enforce its content security policy.`);
    }
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("img-src 'self' data: blob:");
    expect(policy).not.toMatch(/'unsafe-(?:inline|eval)'/);
    const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    nonces.push(nonce!);
    expect(await response!.text()).toContain(`nonce="${nonce}"`);
  }
  expect(new Set(nonces).size).toBe(pagePaths.length);

  await page.goto('/login');
  const scriptPath = await page
    .locator('script[src^="/_next/static/"]')
    .first()
    .getAttribute('src');
  expect(scriptPath).toBeTruthy();
  const scriptResponse = await page.request.get(new URL(scriptPath!, page.url()).toString());
  expect(scriptResponse.headers()['x-content-type-options']).toBe('nosniff');
  expect(scriptResponse.headers()['permissions-policy']).toBe(
    'camera=(), microphone=(), geolocation=()',
  );
  expect(scriptResponse.headers()['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
  expect(scriptResponse.headers()['cross-origin-embedder-policy']).toBe('require-corp');
  expect(scriptResponse.headers()['cross-origin-resource-policy']).toBe('same-origin');

  const popupResponse = await page.goto('/auth/popup?status=success');
  expect(popupResponse?.headers()['cross-origin-opener-policy']).toBe('unsafe-none');
});

test('reports no CSP violations while rendering normal application pages', async ({ page }) => {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push({
        directive: event.effectiveDirective,
        blockedURI: event.blockedURI,
      });
    });
  });
  await mockStudentApi(page);
  await page.goto('/events');
  await expect(page.getByRole('heading', { name: 'Find your next campus moment' })).toBeVisible();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
});

test('blocks parser-injected inline scripts', async ({ page }) => {
  await mockStudentApi(page);
  await page.addInitScript(() => {
    window.__uneventfulInjectedScript = 0;
  });
  await page.route('**/events', async (route) => {
    if (route.request().resourceType() !== 'document') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const html = (await response.text()).replace(
      '</body>',
      '<script>window.__uneventfulInjectedScript = 1</script></body>',
    );
    await route.fulfill({ response, body: html });
  });
  await page.goto('/events');
  await expect(page.getByRole('heading', { name: 'Find your next campus moment' })).toBeVisible();
  expect(await page.evaluate(() => window.__uneventfulInjectedScript)).toBe(0);
});

test('allows same-origin service-worker registration under CSP', async ({ page }) => {
  await page.goto('/login');
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration('/');
          return registration?.active?.scriptURL ?? '';
        }),
      { timeout: 10_000 },
    )
    .toContain('/sw.js');
});

test('loads the offline stylesheet without CSP violations', async ({ page }) => {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push({
        directive: event.effectiveDirective,
        blockedURI: event.blockedURI,
      });
    });
  });
  await page.goto('/offline.html');
  await expect(page.getByRole('heading', { name: 'You’re offline' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.styleSheets].some((sheet) => sheet.href?.endsWith('/offline.css')),
      ),
    )
    .toBe(true);
  expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
});

declare global {
  interface Window {
    __cspViolations: Array<{ directive: string; blockedURI: string }>;
    __uneventfulInjectedScript: number;
  }
}
