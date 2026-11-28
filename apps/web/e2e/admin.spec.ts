import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const pendingEventId = '20edc444-7f57-4e16-bdce-17cbe051b47c';

async function mockAdminApi(page: Page, role: 'ADMIN' | 'STUDENT') {
  const requests: string[] = [];
  await page.context().route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}`);
    if (url.pathname.endsWith('/auth/refresh')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accessToken: 'admin-ui-test-token',
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
          email: `${role.toLowerCase()}@example.edu`,
          firstName: 'Campus',
          lastName: role === 'ADMIN' ? 'Administrator' : 'Student',
          avatarUrl: null,
          role,
        }),
      });
      return;
    }
    if (url.pathname.endsWith('/admin/events/approval-queue')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: pendingEventId,
              title: 'Pending campus event',
              status: 'PENDING_APPROVAL',
              startAt: '2027-03-01T10:00:00.000Z',
              club: { name: 'Student Union' },
            },
          ],
          page: 1,
          limit: 50,
          total: 1,
          totalPages: 1,
        }),
      });
      return;
    }
    if (url.pathname.endsWith(`/admin/events/${pendingEventId}/approve`)) {
      await route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
      return;
    }
    if (url.pathname.startsWith('/api/v1/admin/')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: 1, limit: 50, total: 0 }),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: '{"message":"Not found"}',
    });
  });
  return requests;
}

test('admin console is accessible, confirms actions with reasons, and keeps CSP', async ({
  page,
}) => {
  const requests = await mockAdminApi(page, 'ADMIN');
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'prompt') await dialog.accept('Required moderation reason');
    else await dialog.accept();
  });
  const response = await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pending campus event' })).toBeVisible();

  const policy = response?.headers()['content-security-policy'];
  expect(policy).toContain("script-src 'self' 'nonce-");
  expect(policy).toContain('connect-src');
  expect(policy).not.toContain("'unsafe-inline'");

  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Action completed.', { exact: true })).toBeVisible();
  expect(requests).toContain('POST /api/v1/admin/events/' + pendingEventId + '/approve');

  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
});

test('non-admin users receive the masked admin page without loading its data bundle', async ({
  page,
}) => {
  const requests = await mockAdminApi(page, 'STUDENT');
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  expect(requests.some((request) => request.includes('/admin/'))).toBe(false);
});
