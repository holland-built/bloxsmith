import { test, expect } from '@playwright/test';

// Real app (vault unlocked live). Exercises the Cmd/Ctrl-K command palette.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.tabbar')).toBeVisible();
});

test('Meta+k opens palette and Escape closes it', async ({ page }) => {
  await page.keyboard.press('Meta+k');
  await expect(page.locator('.palette-in')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.palette-in')).toHaveCount(0);
});

test('Control+k opens palette, filter -> Go to Network -> Enter navigates', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const input = page.locator('.palette-in');
  await expect(input).toBeVisible();

  await input.fill('netw');
  await expect(page.locator('.pal-row').filter({ hasText: 'Go to Network' })).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#network$/);
  // Palette closes after navigation.
  await expect(page.locator('.palette-in')).toHaveCount(0);
});
