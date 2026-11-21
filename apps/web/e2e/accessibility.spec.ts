import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockStudentApi, testEvent } from './mock-api';

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
