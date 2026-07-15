import { test, expect } from '@playwright/test';

// Coverage for the v1 (Bloomberg-grid) Overview rebuild —
// brainstorms/design-bloxsmith-overview-plan-2026-07-12.md, mockup
// .mockups/design-bloxsmith-overview/v1.html. One block per acceptance fix.
// Only /api/data is mocked: the rebuilt OverviewTab no longer fetches
// /api/hub/health, /api/hub/security, or /api/dns-analytics at all.

test.use({ colorScheme: 'dark' });

// 12 subnets across 3 sites, chosen so capacity-by-site produces three
// distinct, worst-first averages; the util spread also exercises every
// stat-strip number and every UTIL_BANDS bucket with a non-trivial count.
const SUBNETS = [
  { id: 's1', addr: '10.1.0.0', cidr: 24, util: 100, site: 'HQ', used: 256, total: 256 },
  { id: 's2', addr: '10.1.1.0', cidr: 24, util: 100, site: 'HQ', used: 256, total: 256 },
  { id: 's3', addr: '10.1.2.0', cidr: 24, util: 99, site: 'HQ', used: 253, total: 256 },
  { id: 's4', addr: '10.1.3.0', cidr: 24, util: 97, site: 'HQ', used: 248, total: 256 },
  { id: 's5', addr: '10.1.4.0', cidr: 24, util: 95, site: 'HQ', used: 243, total: 256 },
  { id: 's6', addr: '10.1.5.0', cidr: 24, util: 93, site: 'HQ', used: 238, total: 256 },
  { id: 's7', addr: '10.1.6.0', cidr: 24, util: 87, site: 'HQ', used: 222, total: 256 },
  { id: 's8', addr: '10.2.0.0', cidr: 24, util: 90, site: 'DC-WEST', used: 230, total: 256 },
  { id: 's9', addr: '10.2.1.0', cidr: 24, util: 80, site: 'DC-WEST', used: 205, total: 256 },
  { id: 's10', addr: '10.2.2.0', cidr: 24, util: 72, site: 'DC-WEST', used: 184, total: 256 },
  { id: 's11', addr: '10.3.0.0', cidr: 24, util: 50, site: 'LAB', used: 128, total: 256 },
  { id: 's12', addr: '10.3.1.0', cidr: 24, util: 20, site: 'LAB', used: 51, total: 256 },
];

const LEASES = [
  { addr: '10.1.0.5', host: 'ws-01', state: 'active', mac: null, subnet: '10.1.0.0/24' },
  { addr: '10.1.0.6', host: 'ws-02', state: 'active', mac: null, subnet: '10.1.0.0/24' },
  { addr: '10.1.1.5', host: 'ws-03', state: 'active', mac: null, subnet: '10.1.1.0/24' },
  { addr: '10.1.1.6', host: 'ws-04', state: 'expired', mac: null, subnet: '10.1.1.0/24' },
];

const HOSTS = [
  { name: 'host-on-1', ip: '10.9.0.1', status: 'online' },
  { name: 'host-on-2', ip: '10.9.0.2', status: 'online' },
  { name: 'host-on-3', ip: '10.9.0.3', status: 'online' },
  { name: 'host-warn-1', ip: '10.9.0.4', status: 'degraded' },
  { name: 'host-off-1', ip: '10.9.0.5', status: 'offline' },
  { name: 'host-off-2', ip: '10.9.0.6', status: 'offline' },
];

const DATA = { subnets: SUBNETS, leases: LEASES, zones: [], hosts: HOSTS, auditLogs: [] };

async function gotoOverview(page, data = DATA) {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
  );
  await page.goto('/#overview', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();
}

test('fix 7 — compact stat strip replaces the big banner', async ({ page }) => {
  await gotoOverview(page);
  const strip = page.locator('.statstrip');
  await expect(strip).toBeVisible();
  await expect(strip.locator('.stat', { hasText: 'Subnets' })).toContainText('12');
  await expect(strip.locator('.stat', { hasText: 'Near exhaustion' })).toContainText('7');
  await expect(strip.locator('.stat', { hasText: '>85%' })).toContainText('8');
  await expect(strip.locator('.stat', { hasText: 'Watch 70-85%' })).toContainText('2');
  await expect(strip.locator('.stat', { hasText: 'Active leases' })).toContainText('3');
  await expect(strip.locator('.stat', { hasText: 'Hosts' })).toContainText('6');
  await expect(strip.locator('.stat', { hasText: 'Hosts' })).toContainText('3/1/2');
  // the old KPI-tile banner is gone.
  await expect(page.locator('.kpis')).toHaveCount(0);
});

test('fix 1 — capacity heatmap is real, varied, worst-first (replaces the site bar list)', async ({ page }) => {
  await gotoOverview(page);
  // the old scrolling .siterow bar list is gone entirely.
  await expect(page.locator('.siterow')).toHaveCount(0);
  // one heat cell per site, worst-first, colored by band — HQ (96% avg) →
  // crit, DC-WEST (81% avg) → warn, LAB (35% avg) → ok.
  const cells = page.locator('.heatcell');
  await expect(cells).toHaveCount(3);
  await expect(cells.nth(0)).toHaveClass(/crit/);
  await expect(cells.nth(1)).toHaveClass(/warn/);
  await expect(cells.nth(2)).toHaveClass(/ok/);
  await cells.nth(0).hover();
  const card = page.locator('.hoverdetail.show');
  await expect(card).toContainText('HQ');
  await expect(card).toContainText('96%');
});

test('fix 2 — top consumers scrolls past the first few rows', async ({ page }) => {
  await gotoOverview(page);
  const issuesBox = page.locator('.panel:has-text("Top consumers"), .pcard:has-text("Top consumers")')
    .locator('.issues');
  const rows = issuesBox.locator('.issue');
  await expect.poll(() => rows.count()).toBe(10); // probPool (util>70) = 10 of 12
  const { scrollH, clientH } = await issuesBox.evaluate(el => ({ scrollH: el.scrollHeight, clientH: el.clientHeight }));
  expect(scrollH).toBeGreaterThan(clientH);
});

test('fix 3 + 4 — leases table has no MAC column and no horizontal overflow', async ({ page }) => {
  await gotoOverview(page);
  const headers = await page.locator('[table-id="ov-leases"] th, table.dt th').allTextContents();
  expect(headers.join(' ')).not.toMatch(/mac/i);
  await expect(page.getByText('MAC column hidden', { exact: false })).toBeVisible();

  const wrap = page.locator('.tbl-wrap').first();
  const { scrollW, clientW } = await wrap.evaluate(el => ({ scrollW: el.scrollWidth, clientW: el.clientWidth }));
  expect(scrollW).toBeLessThanOrEqual(clientW + 1); // +1: subpixel rounding tolerance
});

test('fix 5 — Problems-only/All-subnets segmented control has an explicit pressed state', async ({ page }) => {
  await gotoOverview(page);
  const probBtn = page.locator('.seg button', { hasText: 'Problems only' });
  const allBtn = page.locator('.seg button', { hasText: 'All subnets' });
  await expect(probBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(allBtn).toHaveAttribute('aria-pressed', 'false');

  // Scope by the HEADING, not by card text: the Triage queue card now carries a
  // "+N more — see Top consumers or open Network" hint, so `hasText:'Top consumers'`
  // matches BOTH cards and trips strict mode. The panel's own h3 is the identity.
  const consumersSide = page.locator('.pcard')
    .filter({ has: page.getByRole('heading', { name: /^Top consumers/ }) }).locator('.side');
  await expect(consumersSide).toContainText('10 matching');

  await allBtn.click();
  await expect(allBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(probBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(consumersSide).toContainText('12 matching');
});

test('fix 6 — utilization-band chips are individually removable', async ({ page }) => {
  await gotoOverview(page);
  const chip100 = page.locator('.band-chip', { hasText: '100%' });
  await expect(chip100).toHaveAttribute('aria-pressed', 'true');
  // Scope by the HEADING, not by card text: the Triage queue card now carries a
  // "+N more — see Top consumers or open Network" hint, so `hasText:'Top consumers'`
  // matches BOTH cards and trips strict mode. The panel's own h3 is the identity.
  const consumersSide = page.locator('.pcard')
    .filter({ has: page.getByRole('heading', { name: /^Top consumers/ }) }).locator('.side');
  await expect(consumersSide).toContainText('10 matching');

  await chip100.click();
  await expect(chip100).toHaveAttribute('aria-pressed', 'false');
  await expect(chip100).toHaveClass(/off/);
  await expect(consumersSide).toContainText('8 matching');

  await chip100.click(); // re-add
  await expect(chip100).toHaveAttribute('aria-pressed', 'true');
  await expect(consumersSide).toContainText('10 matching');
});

test('fix 8 — host status donut + counts + needs-attention list', async ({ page }) => {
  await gotoOverview(page);
  const panel = page.locator('.pcard', { hasText: 'Host status' });
  await expect(panel.locator('.donut-wrap')).toBeVisible();
  await expect(panel).toContainText('50%');
  await expect(panel).toContainText('online');
  await expect(panel.locator('.donut-leg', { hasText: 'online' })).toContainText('3');
  await expect(panel.locator('.donut-leg', { hasText: 'degraded' })).toContainText('1');
  await expect(panel.locator('.donut-leg', { hasText: 'offline' })).toContainText('2');
  await expect(panel.getByText('host-off-1')).toBeVisible();
});

test('fix 9 — triage queue has real worst-first rows with action buttons', async ({ page }) => {
  await gotoOverview(page);
  const rows = page.locator('.triage-row');
  await expect.poll(() => rows.count()).toBe(6);
  const first = rows.first();
  await expect(first).toContainText('10.1.0.0/24'); // worst (100%) subnet first
  for (const label of ['Provision →', 'Drift', 'Self-serve', 'Editor']) {
    await expect(first.locator('button', { hasText: label })).toBeVisible();
  }
});

test('fix 9b — triage queue shows a real empty state (not a skeleton) when clear', async ({ page }) => {
  await gotoOverview(page, { subnets: [], leases: [], zones: [], hosts: [], auditLogs: [] });
  await expect(page.getByText('No subnets need action')).toBeVisible();
  await expect(page.locator('.triage-row')).toHaveCount(0);
  await expect(page.locator('.skel')).toHaveCount(0);
});

test('fix 10 — triage action tooltips use the hovercard, never native title=', async ({ page }) => {
  await gotoOverview(page);
  const provisionBtn = page.locator('.triage-row').first().locator('button', { hasText: 'Provision →' });
  await expect(provisionBtn).not.toHaveAttribute('title', /.+/);
  await provisionBtn.hover();
  const card = page.locator('.hoverdetail.show');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Provision subnet');
});
