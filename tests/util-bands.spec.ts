import { test, expect } from './fixtures';

// AMBER STARTS AT 70% AND RED AT 90%, ON EVERY PAGE.
//
// Until 2026-10-04 the pages kept four different pairs. A subnet at 88% was
// amber in the Status table and red on Network's chart and in Daily's count; a
// subnet at 91% was counted as critical in the Status tile and drawn amber in
// the table under it. The two subnets below are those two. ui/src/lib/
// utilBands.js is the one place the pair lives now, and its unit test covers
// the rule; this file is that the pages actually draw by it.
//
// Every /api/ response the pages need is faked here, in the shape
// tests/estate-headlines.spec.ts uses.

function fulfillJson(route: import('@playwright/test').Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const OK_META = {
  subnets: 'ok', leases: 'ok', dnsViews: 'ok', zones: 'ok',
  hosts: 'ok', secPolicies: 'ok', feeds: 'ok', auditLogs: 'ok',
};

// One subnet in each place that used to disagree, plus one clearly amber and
// one clearly green. All /24, so Daily's "tiny networks left out" rule drops
// none of them.
const SUBNETS = [
  { id: 'r', addr: '10.0.91.0', cidr: 24, total: 256, used: 233, util: 91 },
  { id: 'a', addr: '10.0.88.0', cidr: 24, total: 256, used: 225, util: 88 },
  { id: 'b', addr: '10.0.72.0', cidr: 24, total: 256, used: 184, util: 72 },
  { id: 'g', addr: '10.0.50.0', cidr: 24, total: 256, used: 128, util: 50 },
];

const DATA = {
  subnets: SUBNETS, leases: [], hosts: [], zones: [],
  dnsViews: [], secPolicies: [], feeds: [], auditLogs: [],
  // What the server would publish for these four rows: 3 at 70 or more, 1 at
  // 90 or more.
  _totals: { subnets: 4, subnetsWarn: 3, subnetsCrit: 1 },
  _meta: OK_META,
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/vault/status*', (route) => fulfillJson(route, { vaultMode: false, ready: true }));
  await page.route('**/api/data*', (route) => fulfillJson(route, DATA));
});

// The status badge in the row for one subnet, in the panel given.
const badge = (page: import('@playwright/test').Page, panel: string, addr: string) =>
  page.locator(`[data-panel-id="${panel}"] tbody tr`).filter({ hasText: addr }).locator('span.rounded-full');

// Overview's table and heatmap legend went on 2026-11-09; its IPAM board row
// is what still counts by the bands. Network's table below still grades rows.
test('Status: the IPAM board row counts by the same bands', async ({ page }) => {
  await page.goto('/#overview');
  const ipam = page.locator('[data-board] [data-board-row="IPAM"]');
  await expect(ipam).toContainText('1 of 4 subnets ≥90%', { timeout: 20_000 });
  await expect(ipam).toContainText('2 more at 70–89%');
});

test('Network: the tiles, the chart labels and the table agree with Status', async ({ page }) => {
  await page.goto('/#network');
  const tiles = page.getByRole('list', { name: 'Headline numbers' });
  await expect(tiles.getByRole('button', { name: /^≥90% 1$/ })).toBeVisible({ timeout: 20_000 });
  // 88 and 72. 88 was "Over 85" here, and red.
  await expect(tiles.getByRole('button', { name: /^70–89% 2$/ })).toBeVisible();

  await expect(badge(page, 'network-exhaustion', '10.0.91.0')).toHaveText('Critical');
  await expect(badge(page, 'network-exhaustion', '10.0.88.0')).toHaveText('Warning');
});

test('Daily: the subnet count is the red band, and opens Network at it', async ({ page }) => {
  await page.goto('/#daily');
  // The Subnets tile holds the number.
  const row = page.locator('[data-daily-tile="subnets"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  // One: 91. It counted 88 as well, from 85, until 2026-10-04.
  await expect(row.getByText('1', { exact: true })).toBeVisible();
  await expect(row.getByText('2', { exact: true })).toHaveCount(0);

  await row.getByRole('link', { name: 'Subnets', exact: true }).click();
  await expect(page).toHaveURL(/#network\?minUtil=90&links=1$/);
  // And the list it opens holds that one subnet and not the 88% one.
  const table = page.locator('[data-panel-id="network-exhaustion"] tbody');
  await expect(table.getByText('10.0.91.0')).toBeVisible();
  await expect(table.getByText('10.0.88.0')).toHaveCount(0);
});
