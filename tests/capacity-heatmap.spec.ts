import { test, expect } from '@playwright/test';

// Coverage for the Capacity heatmap rebuild — replaces the scrolling
// "Capacity by site" .siterow bar list (502 rows) with (a) a utilization
// distribution segmented bar and (b) a dense per-site heatmap. See
// index.html OverviewTab() ~L3579 and .mockups/capacity-rethink.html
// (approved reference mockup).

test.use({ colorScheme: 'dark' });

// 3 sites, deliberately non-overlapping bands so worst-first order and band
// counts are unambiguous: HQ avg 100% (crit), DC-WEST avg 80% (warn),
// LAB avg 20% (ok).
const SUBNETS = [
  { id: 's1', addr: '10.1.0.0', cidr: 24, util: 100, site: 'HQ', used: 256, total: 256 },
  { id: 's2', addr: '10.1.1.0', cidr: 24, util: 100, site: 'HQ', used: 256, total: 256 },
  { id: 's3', addr: '10.2.0.0', cidr: 24, util: 80, site: 'DC-WEST', used: 205, total: 256 },
  { id: 's4', addr: '10.2.1.0', cidr: 24, util: 80, site: 'DC-WEST', used: 205, total: 256 },
  { id: 's5', addr: '10.3.0.0', cidr: 24, util: 20, site: 'LAB', used: 51, total: 256 },
  { id: 's6', addr: '10.3.1.0', cidr: 24, util: 20, site: 'LAB', used: 51, total: 256 },
];
const LEASES = [
  { addr: '10.1.0.5', host: 'ws-01', state: 'active', mac: null, subnet: '10.1.0.0/24' },
];
const HOSTS = [
  { name: 'host-on-1', ip: '10.9.0.1', status: 'online' },
];
const DATA = { subnets: SUBNETS, leases: LEASES, zones: [], hosts: HOSTS, auditLogs: [] };

async function gotoOverview(page) {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.goto('/#overview', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();
}

test('distribution bar renders 4 band segments with counts', async ({ page }) => {
  await gotoOverview(page);
  const segs = page.locator('.dist-seg');
  await expect(segs).toHaveCount(4);
  // counts surfaced via the adjacent legend (never color-only): 100%→2,
  // 90-99%→0, 70-89%→2, <70%→2.
  const legend = page.locator('.dist-legend');
  await expect(legend).toContainText('100%');
  await expect(legend).toContainText('90-99%');
  await expect(legend).toContainText('70-89%');
  await expect(legend).toContainText('<70%');
  const legendTxt = await legend.textContent();
  expect(legendTxt).toMatch(/100%\s*2/);
  expect(legendTxt).toMatch(/90-99%\s*0/);
  expect(legendTxt).toMatch(/70-89%\s*2/);
  expect(legendTxt).toMatch(/<70%\s*2/);
});

test('clicking a distribution segment toggles that band filter', async ({ page }) => {
  await gotoOverview(page);
  const seg100 = page.locator('.dist-seg').first(); // '100' band
  const chip100 = page.locator('.band-chip', { hasText: '100%' });
  await expect(chip100).toHaveAttribute('aria-pressed', 'true');
  await seg100.click();
  await expect(chip100).toHaveAttribute('aria-pressed', 'false');
  await expect(seg100).toHaveAttribute('aria-pressed', 'false');
  await expect(seg100).toHaveClass(/off/);
});

test('heatmap renders one cell per site, worst-first, colored by band', async ({ page }) => {
  await gotoOverview(page);
  const cells = page.locator('.heatcell');
  await expect(cells).toHaveCount(3); // 3 siteRows
  await expect(cells.nth(0)).toHaveClass(/crit/); // HQ avg 100
  await expect(cells.nth(1)).toHaveClass(/warn/); // DC-WEST avg 80
  await expect(cells.nth(2)).toHaveClass(/ok/);   // LAB avg 20
});

test('hovering a heatmap cell shows the detail popup with avg/worst/subnets', async ({ page }) => {
  await gotoOverview(page);
  const first = page.locator('.heatcell').first();
  await first.hover();
  const card = page.locator('.hoverdetail.show');
  await expect(card).toBeVisible();
  await expect(card).toContainText('HQ');
  await expect(card).toContainText('Avg');
  await expect(card).toContainText('100%');
  await expect(card).toContainText('Worst');
  await expect(card).toContainText('Subnets');
});

test('clicking a heatmap cell drills into Network scoped to that site', async ({ page }) => {
  await gotoOverview(page);
  const first = page.locator('.heatcell').first();
  await first.click();
  await expect(page).toHaveURL(/#network\?f=site%3AHQ/);
});

test('heatmap cell is keyboard-operable (role=button, tabIndex)', async ({ page }) => {
  await gotoOverview(page);
  const first = page.locator('.heatcell').first();
  await expect(first).toHaveAttribute('role', 'button');
  await expect(first).toHaveAttribute('tabindex', '0');
});

test('the old 502-row .siterow bar list is gone', async ({ page }) => {
  await gotoOverview(page);
  await expect(page.locator('.siterow')).toHaveCount(0);
  await expect(page.locator('.sites')).toHaveCount(0);
});

test('heatmap has a legend explaining the color bands (no color-only state)', async ({ page }) => {
  await gotoOverview(page);
  const legend = page.locator('.heatmap-legend');
  await expect(legend).toContainText('Exhausted');
  await expect(legend).toContainText('90%');
  await expect(legend).toContainText('Warning');
  await expect(legend).toContainText('Healthy');
  await expect(legend).toContainText('click a cell to drill');
});
