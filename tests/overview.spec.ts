import { test, expect } from '@playwright/test';

// Mocks /api/data so the Overview stat strip renders deterministically.
// v1 (Bloomberg-grid) rebuild — brainstorms/design-bloxsmith-overview-plan-2026-07-12.md —
// replaced the old SynthBand verdict banner + service-health chips + KPI tile
// row with a compact inline stat strip; Overview no longer fetches
// /api/hub/health, /api/hub/security, or /api/dns-analytics at all, so those
// routes and the old .svc/.kpi assertions are gone (see tests/overview-redesign.spec.ts
// for the full new-structure coverage).

// v2 has a light/dark theme; Playwright's Desktop Chrome defaults to
// colorScheme:'light', which the boot script honors (prefers-color-scheme).
// Pin dark for a deterministic screenshot-free run.
test.use({ colorScheme: 'dark' });

const DATA = {
  subnets: [{ id: 's1', name: 'Net A', addr: '10.0.0.0', cidr: 24, util: 30, site: 'HQ' }],
  leases: [{ addr: '10.0.0.5', mac: 'aa:aa:aa:aa:aa:aa', state: 'active', host: 'h1' }],
  zones: [{ fqdn: 'example.com', view: 'default', ttl: 3600 }],
  hosts: [{ name: 'host-1', ip: '10.0.0.2', type: 'dns', status: 'online' }],
  auditLogs: [],
};

test('overview renders the stat strip with real subnet/lease/host numbers', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );

  await page.goto('/#overview');

  const strip = page.locator('.statstrip');
  await expect(strip).toBeVisible();
  await expect(strip.locator('.stat', { hasText: 'Subnets' })).toContainText('1');
  await expect(strip.locator('.stat', { hasText: 'Active leases' })).toContainText('1');
  await expect(strip.locator('.stat', { hasText: 'Hosts' })).toContainText('1');
});
