import { test, expect } from '@playwright/test';

// Coverage for the Overview "hover everything for a plain-English description"
// pass. Reuses the overview-redesign.spec.ts fixture shape (12 subnets / 3
// sites / 6 hosts) with one subnet's site tag blanked out to exercise the
// lonely-dash fix in Top consumers.

test.use({ colorScheme: 'dark' });

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
  // no site tag — backend sentinel "–"; must never render as a lonely "—" line.
  { id: 's10', addr: '10.2.2.0', cidr: 24, util: 72, site: '–', used: 184, total: 256 },
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

async function gotoOverview(page) {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.goto('/#overview', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();
}

test('stat KPI hover shows the real threshold in plain English', async ({ page }) => {
  await gotoOverview(page);
  const stat = page.locator('.stat', { hasText: 'Near exhaustion' });
  await stat.hover();
  const card = page.locator('.hoverdetail.show');
  await expect(card).toBeVisible();
  await expect(card).toContainText('90');
  await expect(card).toContainText('failing');
});

test('stat KPI is keyboard-accessible via focus, not just hover', async ({ page }) => {
  await gotoOverview(page);
  const stat = page.locator('.stat', { hasText: 'Hosts' });
  await stat.focus();
  const card = page.locator('.hoverdetail.show');
  await expect(card).toBeVisible();
  await expect(card).toContainText('online');
  await expect(card).toContainText('degraded');
  await expect(card).toContainText('offline');
});

test('capacity-heatmap cell hover shows avg + worst + subnet count', async ({ page }) => {
  await gotoOverview(page);
  const cell = page.locator('.heatcell').first();
  await cell.hover();
  const card = page.locator('.hoverdetail.show');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Avg');
  await expect(card).toContainText('Worst');
  await expect(card).toContainText('Subnets');
});

test('capacity-heatmap panel side badge explains the site grouping', async ({ page }) => {
  await gotoOverview(page);
  const side = page.locator('.pcard', { hasText: 'Capacity heatmap' }).locator('.side');
  await side.hover();
  const card = page.locator('.hoverdetail.show');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Subnets grouped by tagged site');
});

test('utilization-band chip hover explains the toggle', async ({ page }) => {
  await gotoOverview(page);
  const chip = page.locator('.band-chip', { hasText: '90-99%' });
  await chip.hover();
  const card = page.locator('.hoverdetail.show');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Show only subnets in this utilization range');
});

test('host status donut center + legend rows decode online/degraded/offline', async ({ page }) => {
  await gotoOverview(page);
  const panel = page.locator('.pcard', { hasText: 'Host status' });

  await panel.locator('.donut-svg').hover();
  const centerCard = page.locator('.hoverdetail.show');
  await expect(centerCard).toBeVisible();
  await expect(centerCard).toContainText('online');

  await panel.locator('.donut-leg', { hasText: 'degraded' }).hover();
  const legCard = page.locator('.hoverdetail.show');
  await expect(legCard).toBeVisible();
  await expect(legCard).toContainText('warning');
});

test('host attention row hover decodes the status and offers to investigate', async ({ page }) => {
  await gotoOverview(page);
  const row = page.getByText('host-off-1');
  await row.hover();
  const card = page.locator('.hoverdetail.show');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Unreachable');
  await expect(card).toContainText('investigate');
});

test('top consumers row hover states site + utilization', async ({ page }) => {
  await gotoOverview(page);
  const issuesBox = page.locator('.pcard:has-text("Top consumers")').locator('.issues');
  const first = issuesBox.locator('.issue').first();
  await first.hover();
  const card = page.locator('.hoverdetail.show');
  await expect(card).toBeVisible();
  await expect(card).toContainText('% of pool used');
});

test('no lonely "—" line renders in Top consumers when a subnet has no site tag', async ({ page }) => {
  await gotoOverview(page);
  const issuesBox = page.locator('.pcard:has-text("Top consumers")').locator('.issues');
  // s10 (10.2.2.0/24, site "–") is in the Problems-only pool (util 72 > 70).
  const untaggedRow = issuesBox.locator('.issue', { hasText: '10.2.2.0/24' });
  await expect(untaggedRow).toBeVisible();
  await expect(untaggedRow.locator('.d')).toHaveCount(0);
  // No row anywhere in the panel renders a bare em-dash description line.
  await expect(issuesBox.locator('.d', { hasText: '—' })).toHaveCount(0);
});
