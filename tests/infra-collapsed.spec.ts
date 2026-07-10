import { test, expect } from '@playwright/test';

// InfraTab hides the overwhelming PRTG-style sensor grid behind a disclosure:
// showSensors defaults false, so .sensor-wrap is absent on load. Clicking
// "Show sensor grid" mounts it. Mock /api/host-metrics so the grid has metrics.

const DATA = {
  hosts: [
    { id: 'h1', name: 'host-a', ip: '10.0.0.1', type: 'srv', status: 'online' },
    { id: 'h2', name: 'host-b', ip: '10.0.0.2', type: 'srv', status: 'online' },
  ],
  subnets: [], leases: [], zones: [], auditLogs: [], events: [],
};

const METRICS = {
  metrics: [
    { 'HostMetrics.host_name': 'host-a', 'HostMetrics.metric_name': 'CPU', 'HostMetrics.avg_value': 40 },
    { 'HostMetrics.host_name': 'host-b', 'HostMetrics.metric_name': 'CPU', 'HostMetrics.avg_value': 90 },
    { 'HostMetrics.host_name': 'host-a', 'HostMetrics.metric_name': 'MEM', 'HostMetrics.avg_value': 30 },
    { 'HostMetrics.host_name': 'host-b', 'HostMetrics.metric_name': 'MEM', 'HostMetrics.avg_value': 70 },
  ],
};

test('infra sensor grid is collapsed on load and expands on click', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.route('**/api/host-metrics', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(METRICS) })
  );

  await page.goto('/#infra', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  // Collapsed by default: sensor grid not in the DOM.
  await expect(page.locator('.sensor-wrap')).toHaveCount(0);

  // The disclosure button is present.
  const btn = page.getByRole('button', { name: /Show sensor grid/ });
  await expect(btn).toBeVisible();

  // Click -> the grid mounts.
  await btn.click();
  await expect(page.locator('.sensor-wrap')).toBeVisible();
});
