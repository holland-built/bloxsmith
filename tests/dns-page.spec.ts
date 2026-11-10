import { test, expect } from './fixtures';

// The DNS page in the dashboard look (2026-11-10). Three things a review found
// wrong, each pinned here against the old code:
//  1. zones with issues were buried, because the table sorted A to Z;
//  2. the query-rate change compared the latest hour with the first hour on
//     the chart, a different time of day;
//  3. "Zones with issues" and "Zones needing attention" showed one number twice.

function fulfillJson(route: import('@playwright/test').Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const OK_META = { subnets: 'ok', leases: 'ok', dnsViews: 'ok', zones: 'ok', hosts: 'ok', secPolicies: 'ok', feeds: 'ok', auditLogs: 'ok' };
const dataPayload = (zones: unknown[]) => ({
  subnets: [], leases: [], hosts: [], zones, dnsViews: [], secPolicies: [], feeds: [], auditLogs: [], _totals: {}, _meta: OK_META,
});

// Healthy zones that sort before the problem ones A to Z.
const ZONES = [
  { id: 'z1', fqdn: 'aaa.example.', view: 'v', records: 1, ttl: 3600, neg_ttl: 900, issues: [], anomaly: false },
  { id: 'z2', fqdn: 'bbb.example.', view: 'v', records: 1, ttl: 3600, neg_ttl: 900, issues: [], anomaly: false },
  { id: 'z3', fqdn: 'ccc.example.', view: 'v', records: 1, ttl: 3600, neg_ttl: 900, issues: [], anomaly: false },
  { id: 'z4', fqdn: 'yyy.example.', view: 'v', records: 1, ttl: 30, neg_ttl: 900, issues: ['TTL Too Low'], anomaly: true },
  { id: 'z5', fqdn: 'zzz.example.', view: 'v', records: 1, ttl: 3600, neg_ttl: 7200, issues: ['High Neg-TTL'], anomaly: true },
  { id: 'z6', fqdn: '1.10.in-addr.arpa.', view: 'v', records: 1, ttl: 3600, neg_ttl: 900, issues: [], anomaly: false },
];

const H = 3600_000;
const qps = (n: number, value: (i: number) => number) => ({
  status: 'ok',
  count: n,
  rows: Array.from({ length: n }, (_, i) => ({ hour: new Date(Date.UTC(2026, 10, 10, 0) + i * H).toISOString(), avg_value: value(i) })),
});

async function setup(page: import('@playwright/test').Page, qpsBody: unknown) {
  await page.route('**/api/vault/status*', (route) => fulfillJson(route, { vaultMode: false, ready: true }));
  await page.route('**/api/data*', (route) => fulfillJson(route, dataPayload(ZONES)));
  await page.route('**/api/csp/dns-qps*', (route) => fulfillJson(route, qpsBody));
}

const zoneCard = (page: import('@playwright/test').Page) => page.locator('[data-panel-id="dns-zones"]');

test('zones with issues come first in the zone table, A to Z within', async ({ page }) => {
  await setup(page, qps(3, () => 10));
  await page.goto('/#dns');
  const first = zoneCard(page).locator('tbody tr td:first-child');
  await expect(first.first()).toHaveText('yyy.example.');
  await expect(first.nth(1)).toHaveText('zzz.example.');
  await expect(first.nth(2)).toHaveText('1.10.in-addr.arpa.');
});

test('the zone headline counts zones with issues once and opens them', async ({ page }) => {
  await setup(page, qps(3, () => 10));
  await page.goto('/#dns');
  const tiles = page.getByRole('list', { name: 'Headline numbers' });
  const zones = tiles.locator('[data-tile="zones"]');
  await expect(zones).toContainText('2 with issues');
  await expect(zones).toContainText('of 6');
  await expect(zones).toContainText('Act');
  // The old page said the same number twice, as two different names.
  await expect(page.getByText('Zones needing attention')).toHaveCount(0);
  await zones.click();
  await expect(page).toHaveURL(/#dns\?issues=1$/);
  await expect(zoneCard(page).locator('tbody tr')).toHaveCount(2);
});

test('Zone Counts lists issue kinds; a kind opens just those zones', async ({ page }) => {
  await setup(page, qps(3, () => 10));
  await page.goto('/#dns');
  const kpis = page.locator('[data-panel-id="dns-zone-kpis"]');
  await expect(kpis.getByRole('button', { name: /^cache time too short: 1 zones/ })).toBeVisible();
  await expect(kpis).toContainText('Forward5');
  await expect(kpis).toContainText('Reverse1');
  await kpis.getByRole('button', { name: /^remembers "not found" too long/ }).click();
  await expect(page).toHaveURL(/#dns\?issues=High%20Neg-TTL$/);
  await expect(zoneCard(page).locator('tbody tr')).toHaveCount(1);
  await expect(zoneCard(page).locator('tbody tr')).toContainText('zzz.example.');
});

test('query rate: a series with no hour from yesterday shows no change at all', async ({ page }) => {
  // The old panel printed "▲ 25.0% vs 2h ago" here: 3 PM against 1 PM.
  await setup(page, qps(3, (i) => [100, 150, 125][i]));
  await page.goto('/#dns');
  const hero = page.locator('[data-panel-id="dns-query-rate"]');
  await expect(hero.getByText('125', { exact: true })).toBeVisible();
  await expect(hero.getByText(/vs /)).toHaveCount(0);
  await expect(page.locator('[data-tile="queries"]')).not.toContainText('vs');
});

test('query rate: 24 hours compares with the same time yesterday, in grey', async ({ page }) => {
  await setup(page, qps(24, (i) => (i === 0 ? 10 : i === 23 ? 13 : 50)));
  await page.goto('/#dns');
  const change = page.locator('[data-panel-id="dns-query-rate"] [data-qps-change]');
  await expect(change).toHaveText(/^▲ 30% vs yesterday/);
  await expect(page.locator('[data-tile="queries"]')).toContainText('▲ 30% vs yesterday');
  // A rise in traffic is not good news: the text is the muted grey, not green.
  const color = await change.evaluate((el) => getComputedStyle(el).color);
  const muted = await page.evaluate(() => {
    const p = document.createElement('span');
    p.className = 'text-muted';
    document.body.appendChild(p);
    const c = getComputedStyle(p).color;
    p.remove();
    return c;
  });
  expect(color).toBe(muted);
});
