import { test, expect } from './fixtures';
import { installFixtures, dataPayload, FIXED_NOW } from './page-fixtures';

// Daily shows each count once, in its tile, with what is behind it in a tip
// (the dashboard restyle, 2026-11-10). Before it, the zones count was printed
// three times (the row, "N zones" over the table, "View all N" under it) and
// every number had a sentence under it.

test.use({ timezoneId: 'UTC', locale: 'en-US' });

const ZONES = Array.from({ length: 12 }, (_, i) => ({ id: `z${i}`, fqdn: `zone-${i}.example.`, issues: ['High Neg-TTL'] }));

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await installFixtures(page, 'daily');
  await page.route('**/api/data*', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...dataPayload(), zones: ZONES }) }),
  );
});

test('the zones count shows once, in its tile, not again over or under the table', async ({ page }) => {
  await page.goto('/#daily');
  const tile = page.locator('[data-daily-tile="zones"]');
  await expect(tile.getByText('12', { exact: true })).toBeVisible();

  const zones = page.locator('[data-panel-id="daily-dns-zone-issues"]');
  await expect(zones.locator('tbody tr')).toHaveCount(10);
  await expect(zones.getByText(/\b12\b/)).toHaveCount(0);
  await expect(zones.getByText(/View all/)).toHaveCount(0);
  await expect(zones.getByRole('link', { name: 'Open DNS' })).toHaveAttribute('href', '#dns?issues=1');
});

test('no sentence under a number: the detail opens as a tip on tap, and Escape closes it', async ({ page }) => {
  await page.goto('/#daily');
  const tile = page.locator('[data-daily-tile="zones"]');
  const tip = tile.locator('[role="tooltip"]');
  await expect(tile.getByText('12', { exact: true })).toBeVisible();
  await expect(tip).toBeHidden();
  await expect(tip).toHaveText(/Most common: remembers "not found" too long \(12\)\./);

  await tile.getByText('12', { exact: true }).click();
  await expect(tip).toBeVisible();
  await expect(page).toHaveURL(/#daily$/);
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
});

test('a click on the tile outside the number opens the list behind it', async ({ page }) => {
  await page.goto('/#daily');
  await page.locator('[data-daily-tile="hosts"]').getByText('of 3', { exact: true }).click();
  await expect(page).toHaveURL(/#infra\?status=offline/);
});

test('Hosts Needing Attention says how many it lists, a number the Hosts tile does not repeat', async ({ page }) => {
  const st = ['offline', 'error', 'degraded', 'degraded', 'degraded', 'pending'];
  const hosts = st.map((status, i) => ({ id: `h${i}`, name: `host-${i}`, ip: `10.0.0.${i + 1}`, status, type: 'onprem' }));
  await page.route('**/api/data*', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...dataPayload(), hosts }) }),
  );
  await page.goto('/#daily');
  await expect(page.locator('[data-daily-tile="hosts"]').getByText('2', { exact: true })).toBeVisible();
  const panel = page.locator('[data-panel-id="daily-hosts-attention"]');
  await expect(panel.getByText('6 listed', { exact: true })).toBeVisible();
  await expect(panel.locator('tbody tr')).toHaveCount(6);
  await expect(panel.getByRole('link', { name: 'Open Infra' })).toHaveAttribute('href', '#infra?status=not-online');
});
