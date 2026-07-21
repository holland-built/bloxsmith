import { test, expect } from '@playwright/test';

// Design C: the Network tab's old "Capacity by site" GroupedBar (+ its click-to-
// filter-by-site pivot) was removed — the /16 site dimension went away with it.
// It is replaced by an ExceptionPanel titled "Which subnets run out first?":
// per-subnet exception rows (.exrow / .exrow-body) ranked by fewest free
// addresses, a ValueBands distribution strip (.band-chips), and a healthy-rollup
// defer button (.exrollup). Mocks /api/data so the subnet shape is deterministic.

const DATA = {
  subnets: [
    { id: 's-a', name: 'Alpha Net', addr: '10.10.10.0', cidr: 24, util: 92, site: 'HQ', used: 235, total: 256 },
    { id: 's-b', name: 'Beta Net',  addr: '10.20.0.0',  cidr: 20, util: 74, site: 'HQ', used: 3031, total: 4096 },
    { id: 's-c', name: 'Gamma Net', addr: '10.30.30.0', cidr: 26, util: 88, site: 'DR', used: 56, total: 64 },
    { id: 's-d', name: 'Delta Net', addr: '10.40.40.0', cidr: 24, util: 71, site: 'BR', used: 182, total: 256 },
  ],
  leases: [], zones: [], hosts: [], auditLogs: [], events: [],
};

// A variant with a healthy (<70%) subnet so the healthy rollup renders.
const DATA_HEALTHY = {
  ...DATA,
  subnets: [
    ...DATA.subnets,
    { id: 's-e', name: 'Echo Net', addr: '10.50.50.0', cidr: 24, util: 22, site: 'BR', used: 56, total: 256 },
  ],
};

const panel = (page) =>
  page.locator('.pcard').filter({ has: page.getByRole('heading', { name: /Which subnets run out first/ }) });

test('network capacity renders the Design C exhaustion panel, not the old GroupedBar', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );

  await page.goto('/#network', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  // The exhaustion ExceptionPanel is mounted under its Design C title.
  const ex = panel(page);
  await expect(page.getByRole('heading', { name: /Which subnets run out first/ })).toBeVisible();

  // At least one per-subnet exception row, each rendered with an .exrow-body.
  const rows = ex.locator('.exrow');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(0);
  await expect(ex.locator('.exrow-body').first()).toBeVisible();

  // The distribution strip is a ValueBands chip group.
  await expect(ex.locator('.band-chips')).toBeVisible();
  await expect(ex.locator('.band-chip').first()).toBeVisible();

  // Top consumers list still sits alongside it.
  await expect(page.getByText('Top consumers')).toBeVisible();

  // The old GroupedBar "Capacity by site" panel + Treemap are gone.
  await expect(page.locator('.groupbar')).toHaveCount(0);
  await expect(page.locator('.groupbar-row')).toHaveCount(0);
  await expect(page.locator('.tm-svg')).toHaveCount(0);
  await expect(page.getByText('Capacity map')).toHaveCount(0);
});

test('exhaustion rows are keyboard-operable (role=button, tabIndex 0)', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );

  await page.goto('/#network', { waitUntil: 'networkidle' });
  const row = panel(page).locator('.exrow').first();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('role', 'button');
  await expect(row).toHaveAttribute('tabindex', '0');
});

test('healthy subnets collapse into the .exrollup defer button', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA_HEALTHY) })
  );

  await page.goto('/#network', { waitUntil: 'networkidle' });
  const ex = panel(page);
  await expect(ex.locator('.exrow').first()).toBeVisible();

  // One subnet (Echo Net @22%) is under 70% → the healthy rollup surfaces.
  const rollup = ex.locator('.exrollup');
  await expect(rollup).toBeVisible();
  await expect(rollup).toContainText('healthy');
});
