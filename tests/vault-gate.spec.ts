import { test, expect } from './fixtures';

// What these two protect has not changed: locked -> the dashboard's tab nav is
// not there at all; not in use -> the tabs are on screen and reachable.
//
// Only the way that is read off the page changed. The 14-tab flat strip is
// gone, so "Overview" is no longer a top-level link — it is a menu item inside
// the Status group. Asserting on the five group buttons AND on reaching the
// Overview item through one is deliberately stricter than the old single-link
// check: a page that rendered the header shell but no working nav passed the
// old assertion's inverse and fails this one.
test('vault locked: shows passphrase input, no tab nav', async ({ page }) => {
  await page.route('**/api/vault/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ vaultMode: true, exists: true, unlocked: false, ready: false, tenants: [] }),
    }),
  );

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');

  await expect(page.locator('input[type="password"]').first()).toBeVisible();
  await expect(page.locator('header button[data-group]')).toHaveCount(0);
  await expect(page.locator('a[href="#overview"]')).toHaveCount(0);
});

test('vault not in use: tabs visible', async ({ page }) => {
  await page.route('**/api/vault/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ vaultMode: false, ready: true }),
    }),
  );

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');

  const groups = page.locator('header button[data-group]');
  await expect(groups).toHaveCount(5);
  await expect(groups.first()).toBeVisible();
  await page.locator('header button[data-group="status"]').click();
  await expect(page.locator('header a[role="menuitem"][href="#overview"]')).toBeVisible();
});
