import { test, expect } from '@playwright/test';

// Phase B — the subnet DataTable filter input now feeds the BQL parser.
// Two guarantees under test:
//   (a) a bare word behaves exactly like the old substring filter (matches
//       filterKeys addr/name/site), and
//   (b) a `field>value` query (util>85) filters on a numeric column.
// The subnet table ships problemsOnly ON (util>70); we toggle it OFF so the
// BQL predicate operates over the full fixture, isolating its behaviour.

const DATA = {
  subnets: [
    { id: 's1', name: 'Alpha', addr: '10.1.0.0', cidr: 24, util: 95, site: 'HQ', total: 256 },
    { id: 's2', name: 'Bravo', addr: '10.2.0.0', cidr: 24, util: 88, site: 'HQ', total: 256 },
    { id: 's3', name: 'Charlie', addr: '10.3.0.0', cidr: 24, util: 75, site: 'HQ', total: 256 },
    { id: 's4', name: 'Delta', addr: '10.4.0.0', cidr: 24, util: 40, site: 'EU', total: 256 },
    { id: 's5', name: 'Echo', addr: '10.5.0.0', cidr: 24, util: 20, site: 'EU', total: 256 },
  ],
  leases: [], zones: [], hosts: [], auditLogs: [], events: [],
};

async function openNetwork(page) {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.goto('/#network', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();
  // Turn "Problems only" OFF so all 5 fixture rows form the pre-filter base.
  const toggle = page.locator('.prob-toggle').first();
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
}

test('bare word filters identically to a substring match', async ({ page }) => {
  await openNetwork(page);
  const table = page.locator('table.dt').first();
  const rows = table.locator('tbody tr');
  await expect.poll(() => rows.count()).toBe(5);

  const input = page.locator('.dt-filter').first();
  // "eu" is a substring of the two EU-site rows only (not in any addr/name).
  await input.fill('eu');
  await expect.poll(() => rows.count()).toBe(2);
  await expect(table).toContainText('Delta');
  await expect(table).toContainText('Echo');
});

test('field query util>85 filters on the numeric column', async ({ page }) => {
  await openNetwork(page);
  const table = page.locator('table.dt').first();
  const rows = table.locator('tbody tr');
  await expect.poll(() => rows.count()).toBe(5);

  const input = page.locator('.dt-filter').first();
  await input.fill('util>85');
  // Only the two rows above 85% util (95, 88) survive.
  await expect.poll(() => rows.count()).toBe(2);
  await expect(table).toContainText('Alpha');
  await expect(table).toContainText('Bravo');
  await expect(table).not.toContainText('Charlie');
});

test('sort headers and CSV export remain after filtering', async ({ page }) => {
  await openNetwork(page);
  const panel = page.locator('.dt-panel, .panel').filter({ has: page.locator('table.dt') }).first();
  const input = page.locator('.dt-filter').first();
  await input.fill('util>85');

  const table = page.locator('table.dt').first();
  await expect(table.locator('thead th').first()).toBeVisible();
  await expect(table.locator('thead th').nth(1)).toBeVisible();
  // CSV export button still present in the toolbar.
  await expect(page.getByRole('button', { name: 'CSV' }).first()).toBeVisible();
});
