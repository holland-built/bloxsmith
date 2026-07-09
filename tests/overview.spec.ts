import { test, expect } from '@playwright/test';

// Mocks /api/hub/health and /api/data so the Overview health strip + KPI row
// render deterministically. Secondary feeds are stubbed empty to keep it quiet.

const HEALTH = [{ name: 'DNS', status: 'ok', statusLabel: 'healthy', meta: '3/3 up' }];

const DATA = {
  subnets: [{ id: 's1', name: 'Net A', addr: '10.0.0.0', cidr: 24, util: 30, site: 'HQ' }],
  leases: [{ addr: '10.0.0.5', mac: 'aa:aa:aa:aa:aa:aa', state: 'active', host: 'h1' }],
  zones: [{ fqdn: 'example.com', view: 'default', ttl: 3600 }],
  hosts: [{ name: 'host-1', ip: '10.0.0.2', type: 'dns', status: 'online' }],
  auditLogs: [],
};

test('overview renders the DNS health cell and KPI numbers', async ({ page }) => {
  await page.route('**/api/hub/health', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HEALTH) })
  );
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.route('**/api/hub/security', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ counts: {}, events: [] }) })
  );
  await page.route('**/api/dns-analytics', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ volume: [] }) })
  );

  await page.goto('/#overview');

  // Service-health cell with DNS + healthy label + an ok (green) dot.
  const dnsCell = page.locator('.ov-cell').filter({ hasText: 'DNS' });
  await expect(dnsCell).toBeVisible();
  await expect(dnsCell).toContainText('healthy');
  const dot = dnsCell.locator('.ov-dot');
  await expect(dot).toHaveCSS('background-color', 'rgb(12, 206, 107)'); // var(--ok)

  // KPI numbers render (subnets/leases/zones/hosts/threats).
  const kpis = page.locator('.ov-kpi-n');
  await expect(kpis.first()).toBeVisible();
  expect(await kpis.count()).toBeGreaterThan(0);
  await expect(page.locator('.ov-kpi').filter({ hasText: 'Subnets' })).toContainText('1');
});
