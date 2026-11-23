import { test, expect } from './fixtures';
import { FIXED_NOW, installFixtures } from './page-fixtures';

// Connection health on the Assets tab (2026-11): each discovery connection,
// failing ones first, with a plain status word, how long ago it last synced,
// and its message, cut short with the whole text one click away. Read-only.

const panel = (page: import('@playwright/test').Page) => page.locator('[data-panel-id="assets-connectors"]');

test('failing connections come first, in plain words, with when they last synced', async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  const fx = await installFixtures(page, 'assets');
  await page.goto('/#assets');

  const p = panel(page);
  await expect(p.getByRole('heading', { name: 'Discovery connections' })).toBeVisible();
  await expect(p).toContainText('1 failing · 1 partly working · 1 working');

  const rows = p.getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('baseline-aws');
  await expect(rows.nth(0)).toContainText('Amazon Web Services');
  await expect(rows.nth(0)).toContainText('Failing');
  await expect(rows.nth(0)).toContainText('12m ago');
  await expect(rows.nth(0)).toContainText('Access denied to resource');
  await expect(rows.nth(1)).toContainText('Partly working');

  // The working one waits behind a button, so the list stays short.
  await p.getByRole('button', { name: 'Show 1 working or turned off' }).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText('baseline-gcp');
  await expect(rows.nth(2)).toContainText('Working');

  // Nothing here changes a connection.
  await expect(p.getByRole('button', { name: /sync|delete|disable|enable|edit/i })).toHaveCount(0);
  expect(fx.unmatched()).toEqual([]);
  expect(fx.neverCalled()).toEqual([]);
});

test('a long message is cut short and opens to the whole text', async ({ page }) => {
  await installFixtures(page, 'assets');
  await page.goto('/#assets');
  const row = panel(page).getByRole('listitem').nth(1);
  const full = row.getByText('errors occurred while reconciling records in view baseline-view');
  await expect(full).toBeHidden();
  await row.locator('summary').click();
  await expect(full).toBeVisible();
});

test('a connection list that could not be read says so', async ({ page }) => {
  await installFixtures(page, 'assets');
  await page.route('**/api/csp/asset-connectors', (r) => r.fulfill({ json: {
    availability: 'error', reason: 'Infoblox returned an error (status 502).', connectors: [],
  } }));
  await page.goto('/#assets');
  await expect(panel(page)).toContainText('Connection list unavailable');
  await expect(panel(page)).toContainText('status 502');
});
