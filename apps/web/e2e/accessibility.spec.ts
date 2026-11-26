import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { components } from '@/lib/api-schema';
import { mockStudentApi, testEvent } from './mock-api';

declare global {
  interface Window {
    __notificationPermissionCalls?: number;
  }
}

const accessibilityTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test('login page has no WCAG A/AA accessibility violations', async ({ page }) => {
  await page.goto('/login');
  const results = await new AxeBuilder({ page }).withTags(accessibilityTags).analyze();
  expect(results.violations).toEqual([]);
});

test('event list has no WCAG A/AA accessibility violations', async ({ page }) => {
  await mockStudentApi(page);
  await page.goto('/events');
  await expect(page.getByRole('heading', { name: 'Find your next campus moment' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(accessibilityTags).analyze();
  expect(results.violations).toEqual([]);
});

test('event detail has no WCAG A/AA accessibility violations', async ({ page }) => {
  await mockStudentApi(page);
  await page.goto(`/events/${testEvent.id}`);
  await expect(page.getByRole('heading', { name: testEvent.title })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(accessibilityTags).analyze();
  expect(results.violations).toEqual([]);
});

test('event detail displays venue name and building', async ({ page }) => {
  await mockStudentApi(page, {
    event: {
      ...testEvent,
      venue: { id: '32bb590f-f720-4f4a-9b14-2a50764234c5', name: 'Main Hall', building: 'Library' },
    },
  });
  await page.goto(`/events/${testEvent.id}`);

  await expect(page.getByText('Location: Main Hall · Library')).toBeVisible();
});

test('tickets page has no WCAG A/AA accessibility violations', async ({ page }) => {
  await mockStudentApi(page);
  await page.goto('/tickets');
  await expect(page.getByRole('heading', { name: 'My tickets' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(accessibilityTags).analyze();
  expect(results.violations).toEqual([]);
});

test('profile page has no WCAG A/AA accessibility violations', async ({ page }) => {
  await mockStudentApi(page);
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(accessibilityTags).analyze();
  expect(results.violations).toEqual([]);
});

test('event analytics page has aggregate data and no WCAG A/AA accessibility violations', async ({
  page,
}) => {
  await mockStudentApi(page, {
    profile: {
      id: '98de1d25-a8f7-4ee7-9510-cc04a59181ef',
      email: 'organizer@example.edu',
      firstName: 'Campus',
      lastName: 'Organizer',
      avatarUrl: null,
      role: 'ORGANIZER',
    },
  });
  await page.goto(`/events/${testEvent.id}/analytics`);
  await expect(page.getByRole('heading', { name: 'Event analytics' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'RSVP and check-in trends' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(accessibilityTags).analyze();
  expect(results.violations).toEqual([]);
});

test('recommendation preference opt-out is saved from profile settings', async ({ page }) => {
  await mockStudentApi(page);
  await page.goto('/profile');
  const preference = page.getByRole('checkbox', {
    name: 'Use my activity to personalize recommendations',
  });
  await expect(preference).toBeChecked();
  await preference.click();
  await expect(page.getByRole('status')).toContainText('Your preference has been saved.');
  await expect(preference).not.toBeChecked();
});

test('attendee CSV export downloads from the organizer analytics page', async ({ page }) => {
  await mockStudentApi(page, {
    profile: {
      id: '98de1d25-a8f7-4ee7-9510-cc04a59181ef',
      email: 'organizer@example.edu',
      firstName: 'Campus',
      lastName: 'Organizer',
      avatarUrl: null,
      role: 'ORGANIZER',
    },
  });
  await page.goto(`/events/${testEvent.id}/analytics`);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export attendees' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('event-attendees.csv');
});

test('notification settings have no WCAG A/AA accessibility violations', async ({ page }) => {
  await mockStudentApi(page);
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(accessibilityTags).analyze();
  expect(results.violations).toEqual([]);
});

test('notification settings save channel and type preferences', async ({ page }) => {
  await mockStudentApi(page);
  await page.goto('/notifications');
  const preference = page.getByRole('region', { name: 'Email' }).getByRole('checkbox', {
    name: 'Rsvp Confirmed',
  });
  await expect(preference).toBeChecked();
  await preference.click();
  await expect(page.getByRole('status')).toContainText('Notification preference saved.');
  await expect(preference).not.toBeChecked();
});

test('push permission is requested only after the user activates the button', async ({ page }) => {
  await page.addInitScript(() => {
    window.__notificationPermissionCalls = 0;
    Notification.requestPermission = () => {
      window.__notificationPermissionCalls = (window.__notificationPermissionCalls ?? 0) + 1;
      return Promise.resolve('denied');
    };
  });
  await mockStudentApi(page);
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();

  await expect.poll(() => page.evaluate(() => window.__notificationPermissionCalls)).toBe(0);
  await page.getByRole('button', { name: 'Enable push on this device' }).click();
  await expect(page.getByText('Browser notification permission was not granted.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__notificationPermissionCalls)).toBe(1);
});

test('check-in scanner has no WCAG A/AA accessibility violations', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'BarcodeDetector', {
      configurable: true,
      value: undefined,
    });
  });
  await mockStudentApi(page);
  await page.goto(`/events/${testEvent.id}/scanner`);
  await expect(page.getByRole('heading', { name: 'Event check-in' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(accessibilityTags).analyze();
  expect(results.violations).toEqual([]);
});

test('clears the event manifest and offline scan queue when the event has ended', async ({
  page,
}) => {
  const checkinManifest: components['schemas']['CheckinManifest'] = {
    eventId: testEvent.id,
    eventEndAt: new Date(Date.now() - 60_000).toISOString(),
    publicKeys: { currentKid: 'test-key', keys: [{ kid: 'test-key', publicKey: 'AA' }] },
    data: [{ ticketIdHash: 'a'.repeat(64), status: 'ISSUED' }],
  };
  await mockStudentApi(page, { checkinManifest });
  await page.goto('/events');

  await page.evaluate(
    async ({ eventId, manifest }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('uneventful-checkin', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('manifests', { keyPath: 'eventId' });
          const scans = db.createObjectStore('scans', { keyPath: 'key' });
          scans.createIndex('eventId', 'eventId', { unique: false });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('Could not seed scanner storage.'));
      });
      const transaction = database.transaction(['manifests', 'scans'], 'readwrite');
      transaction.objectStore('manifests').put(manifest);
      transaction.objectStore('scans').put({
        key: `${eventId}:${'a'.repeat(64)}`,
        eventId,
        ticketIdHash: 'a'.repeat(64),
        deviceId: 'expiry-test-device',
        scannedAt: new Date().toISOString(),
      });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(new Error('Could not seed scanner storage.'));
        transaction.onabort = () => reject(new Error('Could not seed scanner storage.'));
      });
      database.close();
    },
    { eventId: testEvent.id, manifest: checkinManifest },
  );

  await page.goto(`/events/${testEvent.id}/scanner`);
  await expect(
    page.getByText('This event has ended. Its offline manifest and scan queue were cleared.'),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<{ manifests: number; scans: number }>((resolve, reject) => {
            const request = indexedDB.open('uneventful-checkin', 1);
            request.onerror = () => reject(new Error('Could not inspect scanner storage.'));
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
      ),
    )
    .toEqual({ manifests: 0, scans: 0 });
});
