import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { dataPayload, installBaselineWorld } from './page-fixtures';

// The rules the old tile strip and side panels held, carried onto the service
// board (2026-11-09). tests/overview-board.spec.ts holds the board's own shape;
// this file holds what the tiles used to promise: a bad count is named with its
// severity, a real zero is a zero, a zero over part of the hosts says so, and a
// saved layout naming panels the page no longer has does not break it.

const fulfillJson = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const row = (page: Page, name: string) => page.locator(`[data-board] [data-board-row="${name}"]`);
// Cells after the row header: measure, issues, last 10 days, state.
const measure = (page: Page, name: string) => row(page, name).locator('td').nth(0);

test('a row that counts something bad names it as an issue, with its severity and how much', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  await expect(row(page, 'Security')).toContainText('Critical', { timeout: 20_000 });
  await expect(row(page, 'Security')).toContainText('3 critical or high security events');
  await expect(measure(page, 'Security')).toContainText('3 critical or high events');
  await expect(measure(page, 'IPAM')).toContainText('1 of 3 subnets ≥90%');
  await expect(measure(page, 'IPAM')).toContainText('0 more at 70–89% · all subnets');
});

test('a healthy network is a real 0 and "none open", not a missing number', async ({ page }) => {
  await installBaselineWorld(page);
  const healthy = structuredClone(dataPayload()) as { hosts: Array<{ status: string }>; _totals: { subnetsCrit: number; subnetsWarn: number } };
  for (const h of healthy.hosts) h.status = 'online';
  healthy._totals.subnetsCrit = 0;
  healthy._totals.subnetsWarn = 1;
  await page.route('**/api/data', (route) => fulfillJson(route, healthy));
  await page.goto('/#overview');
  await expect(measure(page, 'Hosts')).toContainText('0 of 3 not online', { timeout: 20_000 });
  await expect(row(page, 'Hosts')).toContainText('none open');
  await expect(measure(page, 'IPAM')).toContainText('0 of 3 subnets ≥90%');
  await expect(measure(page, 'IPAM')).toContainText('1 more at 70–89%');
});

test('a zero counted over part of the hosts says so, and a missing whole-network count is not a zero', async ({ page }) => {
  await installBaselineWorld(page);
  const partial = structuredClone(dataPayload()) as { hosts: Array<{ status: string }>; _totals: Record<string, unknown> };
  for (const h of partial.hosts) h.status = 'online';
  partial._totals = { degraded: false, hosts: 40, subnets: 3 };
  await page.route('**/api/data', (route) => fulfillJson(route, partial));
  await page.goto('/#overview');
  await expect(measure(page, 'Hosts')).toContainText('0 of 3 not online', { timeout: 20_000 });
  await expect(measure(page, 'Hosts')).toContainText('3 loaded of 40');
  await expect(row(page, 'Hosts')).toContainText('none among the 3 loaded');
  await expect(row(page, 'Hosts')).not.toContainText('none open');
  await expect(measure(page, 'IPAM')).toContainText('unavailable');
});

test('each service row shows its state from the health feed, and a partial service list says so', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  await expect(row(page, 'DHCP')).toContainText('degraded', { timeout: 20_000 });
  await expect(row(page, 'DHCP')).toContainText('1 stopped · 1/2 up');
  await expect(page.locator('[data-coverage]')).toContainText('services: partial list (500-row limit)');
  // An incident no service claims is still shown, and leads to Incidents.
  await expect(row(page, 'Other')).toContainText('subnets close to full');
  await expect(row(page, 'Other').getByRole('link', { name: 'Other', exact: true })).toHaveAttribute('href', '#incidents');
});

test('below the board, only the DNS chart and licences remain as panels', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  await expect(page.locator('[data-panel-id="dns-hero"]')).toBeVisible({ timeout: 20_000 });
  const ids = await page.locator('[data-panel-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-panel-id')));
  expect(ids.sort()).toEqual(['dns-hero', 'license-inventory']);
});

test('a saved layout that names panels Overview no longer has does not list them as off the page', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/views', (route) => fulfillJson(route, { views: [{ name: '__layout_overview' }] }));
  await page.route('**/api/views/__layout_overview', (route) =>
    fulfillJson(route, {
      folder: '',
      name: '__layout_overview',
      saved_at: '2026-11-01T00:00:00Z',
      widgets: {},
      order: ['subnet-table', 'host-status', 'dns-hero', 'top-consumers', 'subnet-heatmap', 'services-incidents', 'license-inventory'],
      layout: { version: 1, spans: {}, hidden: ['kpi-stack', 'subnet-heatmap', 'host-status'] },
    }),
  );
  await page.goto('/#overview');
  await expect(page.locator('[data-panel-id]')).toHaveCount(2, { timeout: 20_000 });
  // "Take off the page" lives in every panel's menu, so match the notice, and
  // the old panels' names, rather than the bare phrase.
  await expect(page.getByText(/(is|are) off the page/)).toHaveCount(0);
  await expect(page.getByText(/Subnet Heatmap|Host Status/)).toHaveCount(0);
  await page.locator('[data-layout-arrange]').click();
  await expect(page.locator('[data-arrange-dialog]')).toBeVisible();
  await expect(page.locator('[data-arrange-dialog]')).not.toContainText(/Subnet Heatmap|Host Status|Off this page/);
  await page.keyboard.press('Escape');
  const ids = await page.locator('[data-panel-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-panel-id')));
  expect(ids).toEqual(['dns-hero', 'license-inventory']);
});
