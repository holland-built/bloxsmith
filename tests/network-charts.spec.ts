import { test, expect } from '@playwright/test';

// Network tab "Capacity by site" now renders a GroupedBar (per-site worst-util
// bars) + a "Top capacity consumers" list — replacing the old sparse Treemap.
// Mocks /api/data so the subnet/site shape is deterministic.

const DATA = {
  subnets: [
    { id: 's-a', name: 'Alpha Net', addr: '10.10.10.0', cidr: 24, util: 92, site: 'HQ',  total: 256 },
    { id: 's-b', name: 'Beta Net',  addr: '10.20.0.0',  cidr: 20, util: 74, site: 'HQ',  total: 4096 },
    { id: 's-c', name: 'Gamma Net', addr: '10.30.30.0', cidr: 26, util: 88, site: 'DR',  total: 64 },
    { id: 's-d', name: 'Delta Net', addr: '10.40.40.0', cidr: 24, util: 71, site: 'BR',  total: 256 },
  ],
  leases: [], zones: [], hosts: [], auditLogs: [], events: [],
};

test('network capacity renders per-site GroupedBar and no treemap', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );

  await page.goto('/#network', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  // GroupedBar (per-site bars) is mounted; there should be one row per distinct site (HQ/DR/BR = 3).
  const bar = page.locator('.groupbar');
  await expect(bar).toBeVisible();
  await expect(page.locator('.groupbar-row')).toHaveCount(3);

  // Top consumers list is present.
  await expect(page.getByText('Top consumers')).toBeVisible();

  // The old Treemap is gone: no SVG treemap, and the "Capacity map" label is absent.
  await expect(page.locator('.tm-svg')).toHaveCount(0);
  await expect(page.getByText('Capacity map')).toHaveCount(0);
});

test('clicking a site bar filters the subnet table by that site', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );

  await page.goto('/#network', { waitUntil: 'networkidle' });
  await expect(page.locator('.groupbar')).toBeVisible();

  // Every subnet is listed before any site filter is applied.
  const row = (n: string) => page.getByRole('row').filter({ hasText: n });
  for (const n of ['Alpha Net', 'Beta Net', 'Gamma Net', 'Delta Net'])
    await expect(row(n)).toHaveCount(1);

  // Click the first (worst) site bar -> the site filter engages as a removable
  // pivot in the global FilterBar, and the subnet table scopes to that site.
  // (HQ is worst: Alpha Net @92%. HQ owns Alpha + Beta; DR/BR drop out.)
  await page.locator('.groupbar-row').first().click();
  const chip = page.locator('.filter-bar .chip').filter({ hasText: 'Site: HQ' });
  await expect(chip).toBeVisible();
  await expect(row('Alpha Net')).toHaveCount(1);
  await expect(row('Beta Net')).toHaveCount(1);
  await expect(row('Gamma Net')).toHaveCount(0);
  await expect(row('Delta Net')).toHaveCount(0);

  // The chip drops the filter: every subnet comes back and the bar goes away.
  await chip.click();
  await expect(page.locator('.filter-bar')).toHaveCount(0);
  for (const n of ['Alpha Net', 'Beta Net', 'Gamma Net', 'Delta Net'])
    await expect(row(n)).toHaveCount(1);
});
