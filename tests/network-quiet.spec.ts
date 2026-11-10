import { test, expect } from './fixtures';
import { installFixtures, ALL_PAGES, FIXED_NOW } from './page-fixtures';

// Network in the dashboard look (2026-11-10): healthy is quiet and only
// problems carry colour, and a lease reads the way a person says it.

test.use({ timezoneId: 'UTC', locale: 'en-US' });

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await installFixtures(page, ALL_PAGES);
});

test('the full band is coloured, healthy is not', async ({ page }) => {
  await page.goto('/#network');
  const strip = page.getByRole('list', { name: 'Headline numbers' });
  const full = strip.getByRole('button', { name: /^≥90% 1$/ });
  await expect(full).toBeVisible({ timeout: 20_000 });
  // The tile is not filled; its number carries the colour instead.
  expect(await full.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  const num = full.locator('.net-num');
  const numColor = await num.evaluate((el) => getComputedStyle(el).color);
  const subnetsColor = await strip.getByRole('button', { name: /^Subnets/ }).locator('.net-num').evaluate((el) => getComputedStyle(el).color);
  expect(numColor).not.toBe(subnetsColor);
  // The explanation is the tile's description, not part of its name.
  await expect(full).toHaveAccessibleDescription(/90% full or more/);

  // In the table, Healthy is a plain word; Critical keeps its fill.
  const rows = page.locator('[data-panel-id="network-exhaustion"] tbody tr');
  const healthy = rows.filter({ hasText: '10.10.0.0' }).locator('span.rounded-full');
  await expect(healthy).toHaveText('Healthy');
  expect(await healthy.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  const crit = rows.filter({ hasText: '10.30.0.0' }).locator('span.rounded-full');
  expect(await crit.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
});

test('a lease that never ends says never, and names lose their quote marks', async ({ page }) => {
  await page.route('**/api/csp/dhcp-leases*', (route) => route.fulfill(json({
    status: 'ok', count: 1,
    rows: [{ address: '10.10.10.55', hostname: '"Mac"', ends: '9999-12-31T23:59:59Z', hardware: 'de:ad:be:ef:d0:0d', state: 'used' }],
  })));
  await page.goto('/#network');
  const row = page.locator('[data-panel-id="network-dhcp-leases"] tbody tr').first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByRole('cell').nth(1)).toHaveText('Mac');
  await expect(row.getByRole('cell').nth(2)).toHaveText('never');
});
