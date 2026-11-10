import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Overview as a service board (2026-11-09, plans/ui-audit/AUDIT.md problem 1).
// One row per service, its open issues first with their age, and each measure
// beside the scope it was counted over. The rules carried over from the old
// tiles (overview-wall.spec.ts) hold here too: a feed nobody could read says so,
// and is never "none" or a zero.

const down = (route: Route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down"}' });
const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const row = (page: Page, name: string) => page.locator(`[data-board] [data-board-row="${name}"]`);

test('the board has a row per service, each linking to its page', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  for (const [name, href] of [['DNS', '#dns'], ['DHCP', '#network?focus=leases'], ['IPAM', '#network?minUtil=90'], ['Hosts', '#infra?status=offline'], ['Security', '#security']]) {
    await expect(row(page, name).getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
  }
  // The six number tiles and the folded "Needs a look" are gone.
  await expect(page.getByRole('list', { name: 'Headline numbers' })).toHaveCount(0);
  await expect(page.locator('[data-needs-a-look]')).toHaveCount(0);
});

test('an offline host is an open issue on the Hosts row, not "none"', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  const hosts = row(page, 'Hosts');
  await expect(hosts).toContainText('1 of 3 hosts is not online', { timeout: 20_000 });
  await expect(hosts).toContainText('Critical');
  await expect(hosts).not.toContainText('none open');
  await expect(hosts).toContainText('1 of 3 not online');
  await expect(hosts).toContainText('all hosts');
});

test('an issue first seen today says new; one the board cannot place goes under Other', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  // The baseline incident is a "capacity" kind seen 8 hours ago, which no
  // service row claims, so it must still be shown.
  const other = row(page, 'Other');
  await expect(other).toContainText('subnets close to full', { timeout: 20_000 });
  await expect(other).toContainText('Warning, new');
});

test('a real zero is shown as 0, with the scope it was counted over', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/csp/dns-qps*', (route) => json(route, { count: 2, rows: [{ hour: '2026-01-01T10:00:00.000', avg_value: 3 }, { hour: '2026-01-01T11:00:00.000', avg_value: 0 }] }));
  await page.goto('/#overview');
  await expect(row(page, 'DNS')).toContainText('0.0 queries/s', { timeout: 20_000 });
  await expect(row(page, 'DNS')).toContainText('hourly average, last hour');
});

test('a dead inventory feed says unavailable and not checked, never a number or "none"', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/data*', down);
  await page.goto('/#overview');
  for (const name of ['IPAM', 'Hosts', 'DHCP']) await expect(row(page, name)).toContainText('unavailable', { timeout: 20_000 });
  await expect(row(page, 'Hosts')).toContainText('not checked: feed unavailable');
  await expect(row(page, 'Hosts')).not.toContainText('none open');
  await expect(page.locator('[data-coverage]')).toContainText('Inventory feed unavailable');
});

test('a dead incidents feed leaves the service rows "not checked", not "none open"', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/incidents*', down);
  await page.goto('/#overview');
  await expect(row(page, 'DNS')).toContainText('not checked: feed unavailable', { timeout: 20_000 });
  await expect(row(page, 'IPAM')).not.toContainText('none open');
});

test('the board scrolls inside its own box at 390px, and the page does not', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installBaselineWorld(page);
  await page.goto('/#overview');
  const box = page.getByRole('region', { name: 'Service board' });
  await expect(box).toBeVisible({ timeout: 20_000 });
  await expect(box).toHaveAttribute('tabindex', '0');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'the document scrolls sideways').toBeLessThanOrEqual(0);
});

test('a clear Security row over a truncated sample says it is only clear for that sample', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/hub/security*', (route) => json(route, { availability: 'ok', counts: { critical: 0, high: 0 }, truncated: true, returned: 50, rows: [] }));
  await page.goto('/#overview');
  await expect(row(page, 'Security')).toContainText('none in the latest 50 events', { timeout: 20_000 });
  await expect(row(page, 'Security')).not.toContainText('none open');
});

// The tiles above the board (owner's pick, 2026-11-10) say one word per
// service. "Healthy" is only said when every feed that could have reported a
// problem answered; a dead one is "Not checked", and no day is drawn green.
const tile = (page: Page, name: string) => page.getByRole('region', { name: 'Services at a glance' }).getByRole('button', { name: new RegExp(`^${name} `) });

test('with the incidents and health feeds dead, no tile or row says Healthy and no day is green', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/incidents*', down);
  await page.route('**/api/hub/health*', down);
  await page.goto('/#overview');
  await expect(tile(page, 'DNS')).toContainText('Not checked', { timeout: 20_000 });
  for (const name of ['DNS', 'DHCP', 'Security']) await expect(tile(page, name)).not.toContainText('Healthy');
  await expect(page.locator('[data-board]')).not.toContainText('Healthy');
  await expect(page.locator('[data-board] .ov-day.ok')).toHaveCount(0);
});

test('a service whose health check answers unknown is not Healthy', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/incidents*', (route) => json(route, { incidents: [] }));
  await page.route('**/api/hub/health*', (route) => json(route, ['DNS', 'DHCP', 'Security'].map((name) => ({ name, status: 'unknown', meta: '' }))));
  await page.goto('/#overview');
  await expect(tile(page, 'DNS')).toContainText('Not checked', { timeout: 20_000 });
  await expect(row(page, 'DNS')).not.toContainText('Healthy');
});

test('a past day with no issue on record is an outline, never green', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/incidents*', (route) => json(route, { incidents: [] }));
  await page.goto('/#overview');
  const days = row(page, 'DNS').locator('.ov-day');
  await expect(days).toHaveCount(10, { timeout: 20_000 });
  for (let i = 0; i < 9; i++) await expect(days.nth(i)).toHaveClass(/\bnone\b/);
});

test("a service whose own check says healthy still shows Act when a critical issue is open on it", async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/hub/health*', (route) => json(route, [{ name: 'Security', status: 'ok', statusLabel: 'healthy', meta: '' }]));
  await page.goto('/#overview');
  await expect(row(page, 'Security')).toContainText('3 critical or high security events', { timeout: 20_000 });
  await expect(row(page, 'Security').locator('.ov-chip')).toHaveText('Act');
});
