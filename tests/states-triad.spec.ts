import { test, expect } from '@playwright/test';

// Shared loading / empty / error state triad (P0 slice 3). Every data surface
// must render one standard version of these three states so a blank dark panel
// never reads as "broken". Driven through InfraTab's Hosts table (fed by the
// shared /api/data feed), which exercises DataTable's empty state + the shared
// ErrorState component.

const HOSTS = [
  { id: 'h1', name: 'web-01', ip: '10.0.0.1', type: 'server', status: 'online' },
  { id: 'h2', name: 'web-02', ip: '10.0.0.2', type: 'server', status: 'online' },
];
const DATA = { subnets: [], leases: [], zones: [], hosts: HOSTS, auditLogs: [] };

// 1. LOADING → the shared Skeleton (not a bare/blank panel).
test('loading state renders the shared Skeleton', async ({ page }) => {
  await page.route('**/api/data', async route => {
    await new Promise(r => setTimeout(r, 1000));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) });
  });

  await page.goto('/#infra');
  // The skeleton is the one true loading skin (aria-busy region + .skel rows).
  await expect(page.locator('.skel').first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]').first()).toBeVisible();
});

// 2. EMPTY with an active filter → "No rows" + a working Clear-filters action.
test('empty table with an active filter shows No rows + Clear filters', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) }));

  // Cross-filter on status=decommissioned — no host matches, so the Hosts table
  // filters to zero rows.
  await page.goto('/#infra?f=status%3Adecommissioned');

  const empty = page.locator('table.dt .dt-empty-title', { hasText: 'No rows' });
  await expect(empty).toBeVisible();

  const clear = page.locator('table.dt .dt-clear-btn', { hasText: 'Clear filters' });
  await expect(clear).toBeVisible();
  await clear.click();

  // Clearing the filter brings the rows back.
  await expect(page.locator('table.dt tbody tr.clickable').filter({ hasText: 'web-01' })).toBeVisible();
});

// 3. ERROR → the actual message + a Retry button that actually retries.
test('error state shows the message and a working Retry', async ({ page }) => {
  let failed = false;
  await page.route('**/api/data', route => {
    if (!failed) {
      failed = true;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'upstream exploded' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) });
  });

  await page.goto('/#infra');

  const err = page.locator('.dt-error');
  await expect(err).toBeVisible();
  await expect(err).toContainText('upstream exploded');

  await err.locator('.fresh-retry', { hasText: 'Retry' }).click();

  await expect(page.locator('table.dt tbody tr.clickable').filter({ hasText: 'web-01' })).toBeVisible();
});
