import { test, expect } from './fixtures';
import { ASSETS_BY_ADDRESS_NONE, installBaselineWorld } from './page-fixtures';

// The dossier's Assets row asks /api/csp/assets?q=<query>. For an IP or MAC
// that is Infoblox's asset search, which only sees devices synced in the last
// 7 days (go/internal/dashboard/assetsearch.go). So an empty answer there must
// say "not seen in the last 7 days", the same words as the Assets search, not
// "the inventory holds none", which claims more than was asked.

test('an IP no device carries says "not seen in the last 7 days"', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/csp/assets?*', (r) => r.fulfill({ json: ASSETS_BY_ADDRESS_NONE }));
  await page.goto('/#dossier?q=10.9.9.9');

  const row = page.locator('[data-dossier-source="assets"]');
  await expect(row).toHaveAttribute('data-dossier-state', 'none');
  await expect(row).toContainText('No device with that address was seen in the last 7 days');
  await expect(row).not.toContainText('inventory holds none');
});

test('a name nothing carries keeps the inventory wording', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/csp/assets?*', (r) => r.fulfill({ json: {
    availability: 'ok', rows: [], total: 0, has_more: false, page: 0, page_size: 50, sort: 'last_seen', dir: 'desc',
  } }));
  await page.goto('/#dossier?q=nothing-here.example');

  const row = page.locator('[data-dossier-source="assets"]');
  await expect(row).toHaveAttribute('data-dossier-state', 'none');
  await expect(row).toContainText('the inventory holds none');
});
