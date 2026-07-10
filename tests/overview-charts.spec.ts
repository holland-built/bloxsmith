import { test, expect } from '@playwright/test';

// Overview "Fleet mix" renders a Donut (host health) + a HistogramBar (subnet
// utilization). Mock minimal /api/data so both have non-empty series.

const DATA = {
  hosts: [
    { id: 'h1', name: 'a', ip: '10.0.0.1', type: 'srv', status: 'online' },
    { id: 'h2', name: 'b', ip: '10.0.0.2', type: 'srv', status: 'online' },
    { id: 'h3', name: 'c', ip: '10.0.0.3', type: 'srv', status: 'offline' },
  ],
  subnets: [
    { id: 's1', name: 'n1', addr: '10.1.0.0', cidr: 24, util: 92, site: 'HQ', total: 256 },
    { id: 's2', name: 'n2', addr: '10.2.0.0', cidr: 24, util: 55, site: 'HQ', total: 256 },
    { id: 's3', name: 'n3', addr: '10.3.0.0', cidr: 24, util: 20, site: 'DR', total: 256 },
  ],
  leases: [], zones: [], auditLogs: [], events: [],
};

test('overview shows a Donut svg and a HistogramBar svg', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.goto('/#overview', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  await expect(page.locator('svg.donut-svg')).toBeVisible();
  await expect(page.locator('svg.histbar-svg')).toBeVisible();
});
