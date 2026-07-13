import { test, expect } from '@playwright/test';

// Feature 9 — Heatmap -> table cross-filter. EXTENDS the capacity heatmap
// (capacity-heatmap.spec.ts covers the base render/hover/nav-drill behavior;
// this file only covers the NEW cross-filter wiring on top of it):
//   - a distribution-band segment (or its legend-swatch twin) now ALSO writes a
//     live FilterCtx filter (toggleBandCross, index.html ~OverviewTab), using the
//     "lo-hi" range convention filterMatchesRow understands — in place, no nav.
//   - a heatmap cell funnels into fx.toggle instead of nav ONLY when a DataTable
//     with a matching column is already mounted on the page (PowerCtx.hasField);
//     Overview's own table (All leases) has no `site` column, so cell clicks
//     still nav-drill exactly as before (regression coverage).
//   - the range-matching mechanism itself is proven against a REAL table by
//     loading Network directly with the same `f=util:lo-hi` hash a band click
//     would produce.

test.use({ colorScheme: 'dark', baseURL: process.env.NOC_BASE || 'http://localhost:8091' });

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
const OV_DATA = { subnets: SUBNETS, leases: LEASES, zones: [], hosts: [], auditLogs: [] };

async function gotoOverview(page) {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OV_DATA) })
  );
  await page.goto('/#overview', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();
}

test('clicking a distribution-band segment cross-filters via FilterCtx in place (no navigation)', async ({ page }) => {
  await gotoOverview(page);
  const seg7089 = page.locator('.dist-seg').nth(2); // bandCounts order: 100,90-99,70-89,lt70
  await seg7089.click();

  await expect(page).toHaveURL(/#overview/); // stayed in place
  await expect(page).toHaveURL(/f=util%3A70-89/);
  const chip = page.locator('.filter-bar .chip', { hasText: 'Utilization' });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('70-89');

  // Clicking again removes the cross-filter (fx.toggle is symmetric).
  await seg7089.click();
  await expect(page.locator('.filter-bar')).toHaveCount(0);
  await expect(page).not.toHaveURL(/f=util/);
});

test('a legend swatch is an equivalent trigger to the segment', async ({ page }) => {
  await gotoOverview(page);
  const swatch = page.locator('.dist-legend-sw', { hasText: '70-89%' });
  await expect(swatch).toHaveAttribute('aria-pressed', 'true');
  await swatch.click();
  await expect(swatch).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveURL(/f=util%3A70-89/);
  await expect(page.locator('.filter-bar .chip', { hasText: 'Utilization' })).toBeVisible();
});

test('heatmap cell still nav-drills when no co-located table has a matching field (regression)', async ({ page }) => {
  await gotoOverview(page);
  const first = page.locator('.heatcell').first(); // HQ, worst-first
  await first.click();
  await expect(page).toHaveURL(/#network\?f=site%3AHQ/);
});

test('the util lo-hi range filter actually narrows a real table (Network subnets)', async ({ page }) => {
  const NET_DATA = {
    subnets: [
      { id: 'n1', addr: '10.5.0.0', cidr: 24, util: 60, site: 'X' },
      { id: 'n2', addr: '10.5.1.0', cidr: 24, util: 75, site: 'Y' },
      { id: 'n3', addr: '10.5.2.0', cidr: 24, util: 82, site: 'Z' },
      { id: 'n4', addr: '10.5.3.0', cidr: 24, util: 95, site: 'W' },
    ],
    leases: [], zones: [], hosts: [], auditLogs: [],
  };
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(NET_DATA) })
  );
  // Same `f=util:lo-hi` hash the Overview 70-89% band click writes.
  await page.goto('/#network?f=util%3A70-89', { waitUntil: 'networkidle' });

  const subnetsWrap = page.locator('div[tabindex="0"]:has(tr.clickable)');
  await expect(subnetsWrap.locator('tr.clickable')).toHaveCount(2);
  await expect(subnetsWrap).toContainText('10.5.1.0');
  await expect(subnetsWrap).toContainText('10.5.2.0');
  await expect(subnetsWrap).not.toContainText('10.5.0.0');
  await expect(subnetsWrap).not.toContainText('10.5.3.0');
});
