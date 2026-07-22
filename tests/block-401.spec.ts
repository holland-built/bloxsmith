import { test, expect } from '@playwright/test';

test('block-domain 401 with no dashToken surfaces "token required" message', async ({ page }) => {
  await page.route('**/api/block-domain', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'unauthorized' }),
    }),
  );

  await page.goto('/#security');

  const dashToken = await page.evaluate(() => localStorage.getItem('dashToken'));
  expect(dashToken).toBeNull();

  const rows = page.locator('table tbody tr');
  try {
    await expect(rows.first()).toBeVisible({ timeout: 15000 });
  } catch {
    test.skip(true, 'no triage rows returned by live server within 15s');
  }

  await rows.first().getByRole('button', { name: 'Block' }).click();
  await expect(page.getByText(/token required.*Settings/)).toBeVisible();
});
