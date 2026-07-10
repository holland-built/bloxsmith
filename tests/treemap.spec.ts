import { test, expect } from '@playwright/test';

// NETDNS "Capacity map" Treemap (display-form primitive). Mocks /api/data so the
// subnet count is deterministic. Map auto-opens only when subnets.length >= 3
// (mapOpen = showMap==null ? subnets.length>=3 : showMap), so:
//   - 3 subnets  -> .tm-svg renders with clickable .tm-cell rects
//   - 2 subnets  -> treemap is not mounted (map collapsed)

const THREE = {
  subnets: [
    { id: 's-a', name: 'Alpha Net', addr: '10.10.10.0', cidr: 24, util: 92, site: 'HQ', total: 256 },
    { id: 's-b', name: 'Beta Net',  addr: '10.20.0.0',  cidr: 20, util: 55, site: 'DR', total: 4096 },
    { id: 's-c', name: 'Gamma Net', addr: '10.30.30.0', cidr: 26, util: 18, site: 'BR', total: 64 },
  ],
  leases: [], zones: [], hosts: [], auditLogs: [],
};

const TWO = {
  subnets: [
    { id: 's-a', name: 'Alpha Net', addr: '10.10.10.0', cidr: 24, util: 90, site: 'HQ', total: 256 },
    { id: 's-b', name: 'Beta Net',  addr: '10.20.20.0', cidr: 24, util: 40, site: 'DR', total: 256 },
  ],
  leases: [], zones: [], hosts: [], auditLogs: [],
};

test('capacity map renders a treemap and a cell click drills into a subnet', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(THREE) })
  );

  await page.goto('/#network');

  const svg = page.locator('.tm-svg');
  await expect(svg).toBeVisible();
  await expect(svg.locator('rect')).not.toHaveCount(0);

  // Clickable cells carry the .tm-cell class (role=button). Dispatch the click on
  // the rect directly so an overlaid <text> label can't intercept the hit-test.
  const cell = svg.locator('.tm-cell').first();
  await expect(cell).toHaveCount(1);
  await cell.dispatchEvent('click');

  await expect(page).toHaveURL(/subnet=/);
});

test('capacity treemap is not mounted when there are fewer than 3 subnets', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TWO) })
  );

  await page.goto('/#network');
  // The subnet table still renders, but the collapsed capacity map means no treemap.
  await expect(page.locator('table.dt tbody tr').first()).toBeVisible();
  await expect(page.locator('.tm-svg')).toHaveCount(0);
});
