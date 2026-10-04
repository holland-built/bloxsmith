import type { Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { dataPayload, installBaselineWorld } from './page-fixtures';

// The Status page as the owner chose it on 2026-10-03: a row of number tiles,
// then panels edge to edge. Three things changed shape and each is held here:
//
//   - the numbers that sat in a panel of their own ("Leases & Subnets") and in
//     a side column are tiles now, and a tile that reports a state is coloured
//     by it;
//   - the side column's service and incident summaries are one panel in the
//     grid, "Services and incidents";
//   - the donut panel names the hosts that are not running.
//
// What a tile must never do is the rule the rest of the app already follows: a
// count nobody could read is a dash with no colour, not a green zero.

const fulfillJson = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const strip = (page: import('@playwright/test').Page) => page.getByRole('list', { name: 'Headline numbers' });
const tile = (page: import('@playwright/test').Page, label: string) =>
  strip(page).getByRole('listitem').filter({ has: page.getByText(label, { exact: true }) }).locator('a, button');

test('six tiles lead the page, in this order', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  await expect(strip(page).getByRole('listitem')).toHaveCount(6);
  await expect(strip(page).getByRole('button', { name: /^Hosts \d/ })).toBeVisible({ timeout: 20_000 });
  const labels = await strip(page).getByRole('listitem').evaluateAll((els) => els.map((el) => el.querySelector('span')?.textContent));
  expect(labels).toEqual(['DNS queries', 'Hosts', 'Hosts offline', 'Subnets ≥90%', 'Active Leases', 'Security events']);
});

test('a tile that counts something bad is red or amber when there is any, and says how much', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  // The baseline world: one host offline, one subnet past 90%, and one critical
  // plus two high security events.
  await expect(tile(page, 'Hosts offline')).toHaveAttribute('data-tone', 'crit', { timeout: 20_000 });
  await expect(tile(page, 'Hosts offline')).toContainText('1');
  await expect(tile(page, 'Subnets ≥90%')).toHaveAttribute('data-tone', 'crit');
  await expect(tile(page, 'Subnets ≥90%')).toContainText('0 at 70–89%');
  await expect(tile(page, 'Security events')).toHaveAttribute('data-tone', 'crit');
  await expect(tile(page, 'Security events')).toContainText('3 critical or high');
  // A plain count carries no state and so no colour.
  await expect(tile(page, 'Hosts')).not.toHaveAttribute('data-tone');
  await expect(tile(page, 'Active Leases')).not.toHaveAttribute('data-tone');
});

test('a count of zero is green, and only then', async ({ page }) => {
  await installBaselineWorld(page);
  const healthy = structuredClone(dataPayload()) as {
    hosts: Array<{ status: string }>;
    _totals: { subnetsCrit: number; subnetsWarn: number };
  };
  for (const h of healthy.hosts) h.status = 'online';
  healthy._totals.subnetsCrit = 0;
  healthy._totals.subnetsWarn = 1;
  await page.route('**/api/data', (route) => fulfillJson(route, healthy));
  await page.goto('/#overview');
  await expect(tile(page, 'Hosts offline')).toHaveAttribute('data-tone', 'ok', { timeout: 20_000 });
  await expect(tile(page, 'Hosts offline')).toContainText('0');
  await expect(tile(page, 'Subnets ≥90%')).toHaveAttribute('data-tone', 'ok');
  await expect(tile(page, 'Subnets ≥90%')).toContainText('1 at 70–89%');
});

test('a zero counted over part of the estate is not painted green', async ({ page }) => {
  await installBaselineWorld(page);
  // Every host that loaded is online, but the estate says there are more of
  // them than loaded; and no estate-wide count of full subnets was published,
  // so that zero is over the loaded rows only. Neither is an all-clear.
  const partial = structuredClone(dataPayload()) as {
    hosts: Array<{ status: string }>;
    subnets: Array<{ util: number }>;
    _totals: Record<string, unknown>;
  };
  for (const h of partial.hosts) h.status = 'online';
  for (const sn of partial.subnets) sn.util = 10;
  partial._totals = { degraded: false, hosts: 40, subnets: 3 };
  await page.route('**/api/data', (route) => fulfillJson(route, partial));
  await page.goto('/#overview');
  const offline = tile(page, 'Hosts offline (of 3 loaded)');
  await expect(offline).toContainText('0', { timeout: 20_000 });
  await expect(offline).not.toHaveAttribute('data-tone');
  const full = tile(page, 'Subnets ≥90% (loaded rows)');
  await expect(full).toContainText('0');
  await expect(full).not.toHaveAttribute('data-tone');
});

test('a tile whose feed is dead is a dash with no colour, and says unavailable', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/data*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down"}' }));
  await page.goto('/#overview');
  await expect(page.getByText('Hosts feed unavailable').first()).toBeVisible({ timeout: 20_000 });
  const offline = strip(page).getByRole('button', { name: 'Hosts offline —', exact: true });
  await expect(offline).toBeVisible();
  await expect(offline).not.toHaveAttribute('data-tone');
  const full = tile(page, 'Subnets ≥90% (loaded rows)');
  await expect(full).toContainText('—');
  await expect(full).toContainText('unavailable');
  await expect(full).not.toHaveAttribute('data-tone');
});

test('a tile about another tab is a link to that tab', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  await expect(tile(page, 'Subnets ≥90%')).toHaveAttribute('href', '#network?minUtil=90');
  await expect(tile(page, 'Active Leases')).toHaveAttribute('href', '#network?focus=leases');
  await expect(tile(page, 'Security events')).toHaveAttribute('href', '#security');
});

test('Services and incidents names each service and each incident', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  const panel = page.locator('[data-panel-id="services-incidents"]');
  await expect(panel.getByRole('heading', { name: 'Services and incidents' })).toBeVisible();
  // A service row is its name, how many of its machines are up, and its state.
  const dhcp = panel.getByRole('listitem').filter({ hasText: 'DHCP' });
  await expect(dhcp).toContainText('1 stopped · 1/2 up');
  await expect(dhcp).toContainText('degraded');
  // The baseline incident counts two subnets, so it is the category's sentence
  // and not one signal's.
  await expect(panel.getByRole('listitem').filter({ hasText: 'subnets close to full' })).toBeVisible();
  // A service the inventory could not account for is labelled partial, in words.
  await expect(panel).toContainText('partial: service inventory truncated');
  await expect(panel.getByRole('link', { name: 'Incidents', exact: true })).toHaveAttribute('href', '#incidents');
});

test('the services list is the height of the chart beside it and can be scrolled by keyboard', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  const list = page.getByRole('region', { name: 'Services and incidents list' });
  await expect(list).toBeVisible({ timeout: 20_000 });
  await expect(list).toHaveAttribute('tabindex', '0');
  const chart = page.locator('[data-panel-id="top-consumers"] .recharts-wrapper').first();
  await expect(chart).toBeVisible({ timeout: 20_000 });
  const a = (await list.boundingBox())!.height;
  const b = (await chart.boundingBox())!.height;
  expect(Math.abs(a - b), `the list is ${a}px and the chart beside it ${b}px, so one of them sets the row's height alone`).toBeLessThanOrEqual(1);
});

test('a dead incidents feed says so, and is not an empty list', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/incidents*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down"}' }));
  await page.goto('/#overview');
  const panel = page.locator('[data-panel-id="services-incidents"]');
  await expect(panel.getByText('Incidents feed unavailable')).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText('No open incidents')).toHaveCount(0);
});

test('the hosts that are not active are named under the donut, worst first', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  const rows = page.locator('[data-panel-id="host-status"] ul li');
  await expect(rows).toHaveCount(3, { timeout: 20_000 });
  await expect(rows.nth(0)).toContainText('baseline-host-c');
  await expect(rows.nth(0)).toContainText('Offline');
  await expect(rows.nth(1)).toContainText('baseline-host-b');
  await expect(rows.nth(1)).toContainText('Degraded');
});

test('the old numbers panel and the side column are gone', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  await expect(page.locator('[data-panel-id="dns-hero"]')).toBeVisible();
  await expect(page.locator('[data-panel-id="kpi-stack"]')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Other areas' })).toHaveCount(0);
  await expect(page.locator('[data-panel-id]')).toHaveCount(7);
});

test('a saved layout that hid the old numbers panel does not list it as off the page', async ({ page }) => {
  await installBaselineWorld(page);
  // What an operator who had tidied that panel away before 2026-10-03 has on
  // disk: an order and a hidden list that both name a panel the page no longer
  // has, and no mention of the one added since.
  await page.route('**/api/views', (route) => fulfillJson(route, { views: [{ name: '__layout_overview' }] }));
  await page.route('**/api/views/__layout_overview', (route) =>
    fulfillJson(route, {
      folder: '',
      name: '__layout_overview',
      saved_at: '2026-09-30T00:00:00Z',
      widgets: {},
      order: ['dns-hero', 'kpi-stack', 'top-consumers', 'subnet-heatmap', 'host-status', 'subnet-table', 'license-inventory'],
      layout: { version: 1, spans: {}, hidden: ['kpi-stack'] },
    }),
  );
  await page.goto('/#overview');
  await expect(page.locator('[data-panel-id]')).toHaveCount(7, { timeout: 20_000 });
  // Asked of the strip above the panels, which is where "1 tile is off the
  // page." is said. It used to be asked of the whole page; since 2026-10-04
  // every panel's "…" menu holds a button that reads "Take off the page", so
  // the whole page always contains those words.
  const strip = page.getByTestId('hidden-tiles');
  await expect(strip).toHaveCount(1);
  await expect(strip.getByText(/off the page/)).toHaveCount(0);
  // The panel added since that layout was saved is there, after the ones it placed.
  const ids = await page.locator('[data-panel-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-panel-id')));
  expect(ids.at(-1)).toBe('services-incidents');
});

test('on a 390px phone the tiles are two across and nothing scrolls sideways', async ({ page }) => {
  await installBaselineWorld(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/#overview');
  await expect(strip(page).getByRole('button', { name: /^Hosts \d/ })).toBeVisible({ timeout: 20_000 });
  const boxes = await strip(page).getByRole('listitem').evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right) };
  }));
  // Six tiles in three rows of two.
  expect(new Set(boxes.map((b) => b.top)).size).toBe(3);
  expect(new Set(boxes.map((b) => b.left)).size).toBe(2);
  for (const b of boxes) expect(b.right).toBeLessThanOrEqual(390);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);
});

test('each host-status legend row is a 24px target, on the pitch it always had', async ({ page }) => {
  // The rows were 16px tall with an 8px gap: two click targets whose 24px
  // circles overlap (axe `target-size`). They are 24px with no gap now. The
  // pitch is asserted too, because that is what says no word moved.
  await installBaselineWorld(page);
  await page.goto('/#overview');
  const rows = page.locator('[data-panel-id="host-status"] [role="button"]');
  await expect(rows).toHaveCount(3, { timeout: 20_000 });
  const boxes = await rows.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ top: r.top, h: r.height })));
  for (const b of boxes) expect(b.h).toBeGreaterThanOrEqual(24);
  expect(boxes[1].top - boxes[0].top).toBeCloseTo(24, 0);
  expect(boxes[2].top - boxes[1].top).toBeCloseTo(24, 0);
});
