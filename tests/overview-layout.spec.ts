import { test, expect } from '@playwright/test';

// Global layout fix: .main no longer smears edge-to-edge on ultrawide monitors,
// dense capacity-bar tracks stay readable, and the stat strip + 12-col detail
// grid keep their intended proportions at normal-to-wide viewports.
// See index.html ~L252 (.main), ~L622 (.siterow .track), ~L3339 (.ovx-detail).

test.use({ colorScheme: 'dark' });

// Enough sites/subnets to populate "Capacity by site" with real, varied bars.
const SUBNETS = [
  { id: 's1', addr: '10.1.0.0', cidr: 24, util: 100, site: 'HQ', used: 256, total: 256 },
  { id: 's2', addr: '10.1.1.0', cidr: 24, util: 95, site: 'HQ', used: 243, total: 256 },
  { id: 's3', addr: '10.2.0.0', cidr: 24, util: 80, site: 'DC-WEST', used: 205, total: 256 },
  { id: 's4', addr: '10.2.1.0', cidr: 24, util: 72, site: 'DC-WEST', used: 184, total: 256 },
  { id: 's5', addr: '10.3.0.0', cidr: 24, util: 50, site: 'LAB', used: 128, total: 256 },
  { id: 's6', addr: '10.3.1.0', cidr: 24, util: 20, site: 'LAB', used: 51, total: 256 },
];
const LEASES = [
  { addr: '10.1.0.5', host: 'ws-01', state: 'active', mac: null, subnet: '10.1.0.0/24' },
  { addr: '10.1.0.6', host: 'ws-02', state: 'active', mac: null, subnet: '10.1.0.0/24' },
];
const HOSTS = [
  { name: 'host-on-1', ip: '10.9.0.1', status: 'online' },
  { name: 'host-on-2', ip: '10.9.0.2', status: 'online' },
  { name: 'host-warn-1', ip: '10.9.0.4', status: 'degraded' },
  { name: 'host-off-1', ip: '10.9.0.5', status: 'offline' },
];
const DATA = { subnets: SUBNETS, leases: LEASES, zones: [], hosts: HOSTS, auditLogs: [] };

async function gotoOverview(page, width: number) {
  await page.setViewportSize({ width, height: 1000 });
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.goto('/#overview', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();
  await expect(page.locator('.ovx-detail')).toBeVisible();
}

for (const width of [1440, 1920, 2560]) {
  test(`viewport ${width} — .main width discipline (no smear, no gutter at 1920)`, async ({ page }) => {
    await gotoOverview(page, width);
    const mainW = await page.locator('.main').first().evaluate(el => el.getBoundingClientRect().width);
    expect(mainW).toBeLessThanOrEqual(2045); // never smears past the ~2040 cap
    if (width === 1920) {
      expect(mainW).toBeGreaterThanOrEqual(1860); // fills a normal wide monitor, no big gutters
    }
    if (width === 1440) {
      expect(mainW).toBeLessThanOrEqual(1440); // no cap triggered below the cap
    }
  });

  test(`viewport ${width} — capacity bar tracks stay readable`, async ({ page }) => {
    await gotoOverview(page, width);
    const widths = await page.locator('.siterow .track').evaluateAll(
      els => els.map(el => el.getBoundingClientRect().width)
    );
    expect(widths.length).toBeGreaterThan(0);
    for (const w of widths) expect(w).toBeLessThanOrEqual(561);
  });

  test(`viewport ${width} — stat strip renders one row of 6 (no wrap)`, async ({ page }) => {
    if (width < 1440) test.skip();
    await gotoOverview(page, width);
    const stats = page.locator('.statstrip .stat');
    await expect(stats).toHaveCount(6);
    const tops = await stats.evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().top)));
    const distinct = new Set(tops);
    expect(distinct.size).toBe(1); // all 6 share the same row (top offset)
  });

  test(`viewport ${width} — ovx-detail grid holds 2-row proportions`, async ({ page }) => {
    await gotoOverview(page, width);
    const detail = page.locator('.ovx-detail');
    const capacity = detail.locator('> .span-6').first();
    const topConsumers = detail.locator('> .span-3').first();
    const leases = detail.locator('> .span-8').first();
    const triage = detail.locator('> .span-4').first();

    const [capW, topW, leaseW, triageW, detailW] = await Promise.all([
      capacity.evaluate(el => el.getBoundingClientRect().width),
      topConsumers.evaluate(el => el.getBoundingClientRect().width),
      leases.evaluate(el => el.getBoundingClientRect().width),
      triage.evaluate(el => el.getBoundingClientRect().width),
      detail.evaluate(el => el.getBoundingClientRect().width),
    ]);

    // row1: Capacity (span-6) ≈ half, Top consumers (span-3) ≈ quarter of the grid.
    expect(capW / detailW).toBeGreaterThan(0.42);
    expect(capW / detailW).toBeLessThan(0.58);
    expect(topW / detailW).toBeGreaterThan(0.17);
    expect(topW / detailW).toBeLessThan(0.33);
    // no single panel is smeared full-width.
    expect(capW).toBeLessThan(detailW * 0.9);

    // row2: leases (span-8) ≈ two-thirds, triage (span-4) ≈ one-third.
    expect(leaseW / detailW).toBeGreaterThan(0.58);
    expect(leaseW / detailW).toBeLessThan(0.75);
    expect(triageW / detailW).toBeGreaterThan(0.25);
    expect(triageW / detailW).toBeLessThan(0.42);
  });
}
