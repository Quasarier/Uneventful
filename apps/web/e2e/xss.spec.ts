import { expect, test } from '@playwright/test';
import { mockStudentApi, testEvent } from './mock-api';

declare global {
  interface Window {
    __uneventfulXss?: number;
  }
}

const hostilePayloads = [
  '<script>window.__uneventfulXss=1</script>',
  '<img src=x onerror=window.__uneventfulXss=2>',
  '<svg onload=window.__uneventfulXss=3></svg>',
  '"><iframe src=javascript:window.__uneventfulXss=4></iframe>',
  '<a href="javascript:window.__uneventfulXss=5">click</a>',
  '<body onload=window.__uneventfulXss=6>',
  '<div onclick=window.__uneventfulXss=7>click</div>',
  '<math><mi xlink:href="javascript:window.__uneventfulXss=8">',
  '</p><script>window.__uneventfulXss=9</script>',
  '<input autofocus onfocus=window.__uneventfulXss=10>',
];

test('renders ten hostile event, description, and club payloads strictly as text', async ({
  page,
}) => {
  const title = hostilePayloads.join(' | ');
  const description = hostilePayloads.join('\n');
  const event = {
    ...testEvent,
    title,
    description,
    club: { ...testEvent.club, name: hostilePayloads.join(' | ') },
  };
  await page.addInitScript(() => {
    window.__uneventfulXss = 0;
  });
  await mockStudentApi(page, { event });
  await page.goto('/events');

  const eventLink = page.locator(`a[href="/events/${event.id}"]`);
  await expect(eventLink).toHaveText(title);
  await eventLink.click();
  await expect(page.locator('h1')).toHaveText(title);
  await expect(page.locator('p.whitespace-pre-wrap')).toHaveText(description);
  await expect(page.locator('header p').first()).toContainText(event.club.name);

  expect(
    await page.evaluate(() => ({
      executed: window.__uneventfulXss,
      injectedNodes: document.querySelectorAll(
        'img[src="x"], svg[onload], iframe, [onerror], [onclick], [onfocus], [href^="javascript:"], [src^="javascript:"]',
      ).length,
    })),
  ).toEqual({ executed: 0, injectedNodes: 0 });
});

test('renders hostile profile fields strictly as text', async ({ page }) => {
  const hostileValue = hostilePayloads.join(' | ');
  await page.addInitScript(() => {
    window.__uneventfulXss = 0;
  });
  await mockStudentApi(page, {
    profile: {
      id: '98de1d25-a8f7-4ee7-9510-cc04a59181ef',
      email: `${hostileValue}@example.edu`,
      firstName: hostileValue,
      lastName: hostileValue,
      avatarUrl: null,
      role: 'STUDENT',
    },
  });
  await page.goto('/profile');

  await expect(
    page.getByRole('heading', { name: `${hostileValue} ${hostileValue}` }),
  ).toBeVisible();
  await expect(page.locator('dd').first()).toHaveText(`${hostileValue}@example.edu`);
  expect(
    await page.evaluate(() => ({
      executed: window.__uneventfulXss,
      injectedNodes: document.querySelectorAll(
        'img[src="x"], svg[onload], iframe, [onerror], [onclick], [onfocus], [href^="javascript:"], [src^="javascript:"]',
      ).length,
    })),
  ).toEqual({ executed: 0, injectedNodes: 0 });
});
