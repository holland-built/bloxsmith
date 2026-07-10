import { test, expect } from '@playwright/test';

// /api/data fails (500) on the first call, succeeds afterward. NetworkTab surfaces
// a "failed · Retry" indicator (Freshness error). Retry refetches -> table renders.

// util>70 so the row survives the subnet table's default problemsOnly filter
// and is actually rendered once the retry succeeds.
const DATA = {
  subnets: [
    { id: 's1', name: 'Prod Net', addr: '172.16.0.0', cidr: 24, util: 80, site: 'HQ' },
  ],
  leases: [{ addr: '172.16.0.10', mac: 'de:ad:be:ef:00:10', state: 'active', host: 'prod-1' }],
  zones: [],
  hosts: [],
  auditLogs: [],
};

test('degraded /api/data shows Retry, then renders after retry', async ({ page }) => {
  let retried = false;
  await page.route('**/api/data', route => {
    if (!retried) {
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) });
  });

  await page.goto('/#network');

  // Error indicator with Retry.
  await expect(page.locator('.fresh.err')).toContainText('failed');
  const retry = page.locator('.fresh-retry', { hasText: 'Retry' });
  await expect(retry).toBeVisible();

  retried = true;
  await retry.click();

  // Table renders after the successful retry.
  await expect(page.locator('table.dt tbody tr.clickable').first()).toContainText('Prod Net');
});
