import { test, expect } from '@playwright/test';

test('vault locked: shows passphrase input, no tab nav', async ({ page }) => {
  await page.route('**/api/vault/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ vaultMode: true, exists: true, unlocked: false, ready: false, tenants: [] }),
    }),
  );

  await page.goto('/');

  await expect(page.locator('input[type="password"]').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Overview' })).toHaveCount(0);
});

test('vault not in use: tabs visible', async ({ page }) => {
  await page.route('**/api/vault/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ vaultMode: false, ready: true }),
    }),
  );

  await page.goto('/');

  await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
});
