import { test, expect } from '@playwright/test';

test('light theme from localStorage applies pre-paint', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('theme', 'light'));
  await page.goto('/');
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(theme).toBe('light');
});

test('default theme is dark; topbar pill can switch to light and it persists', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.getByRole('button', { name: 'Light theme' }).click();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const stored = await page.evaluate(() => localStorage.getItem('theme'));
  expect(stored).toBe('light');

  await page.reload();
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(theme).toBe('light');
});

test('charts recolor under light theme', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('theme', 'light'));
  await page.goto('/#overview');

  // Grid lines are zero-height <line> elements (horizontal gridlines), so
  // Playwright's bounding-box visibility check reports them "hidden" even
  // though they render — assert on the parent group instead.
  await expect(page.locator('.recharts-cartesian-grid').first()).toBeVisible();
  const grid = page.locator('.recharts-cartesian-grid line').first();
  await grid.waitFor({ state: 'attached' });
  const stroke = await grid.getAttribute('stroke');

  expect(stroke).not.toBeNull();
  expect(stroke).not.toBe('#222');
  const isLight = stroke === 'var(--color-grid)' || /^#(f|e|d|c)/i.test(stroke as string);
  expect(isLight).toBe(true);
});
