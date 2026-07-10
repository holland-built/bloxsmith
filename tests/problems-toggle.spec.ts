import { test, expect } from '@playwright/test';

// The subnet DataTable ships problemsOnly ON by default (util>70). Toggling the
// "Problems only" control OFF reveals the healthy rows too — visible row count grows.
// Mock a mix: 3 problem subnets (util>70) + 3 healthy (util<=70), none at 100.

const DATA = {
  subnets: [
    { id: 'p1', name: 'Prob 1', addr: '10.1.0.0', cidr: 24, util: 95, site: 'HQ', total: 256 },
    { id: 'p2', name: 'Prob 2', addr: '10.2.0.0', cidr: 24, util: 84, site: 'HQ', total: 256 },
    { id: 'p3', name: 'Prob 3', addr: '10.3.0.0', cidr: 24, util: 78, site: 'HQ', total: 256 },
    { id: 'h1', name: 'Heal 1', addr: '10.4.0.0', cidr: 24, util: 40, site: 'HQ', total: 256 },
    { id: 'h2', name: 'Heal 2', addr: '10.5.0.0', cidr: 24, util: 22, site: 'HQ', total: 256 },
    { id: 'h3', name: 'Heal 3', addr: '10.6.0.0', cidr: 24, util: 10, site: 'HQ', total: 256 },
  ],
  leases: [], zones: [], hosts: [], auditLogs: [], events: [],
};

test('toggling Problems only changes the visible subnet row count', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.goto('/#network', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  // Scope to the subnet table (first .dt; the page also has a DHCP-leases .dt).
  const rows = page.locator('table.dt').first().locator('tbody tr');

  // Default (problems only ON): the 3 util>70 rows.
  await expect.poll(() => rows.count()).toBe(3);

  const toggle = page.locator('.prob-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  // Turn it off -> all 6 rows show.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => rows.count()).toBe(6);
});
