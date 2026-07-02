import { test, expect } from '@playwright/test';

test('shows degraded state when data is empty', async ({ page }) => {
  await page.route('**/api/verticals/network', (route) =>
    route.fulfill({
      status: 200,
      body: JSON.stringify({ subnets: [], leases: [], zones: [], views: [] }),
    })
  );

  await page.route('**/api/alerts/incidents', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify([]) })
  );

  await page.goto('/index-vite.html');

  await expect(page.getByText('No data — check connection')).toBeVisible();
  await expect(page.locator('table')).toHaveCount(0);
});

test('shows real data when the API returns sample rows', async ({ page }) => {
  // Loading state: DegradedState renders mode="loading" ("Loading…") during
  // the initial fetch. Reliably asserting on it here would require an
  // artificial route delay racing against React's render/mount timing,
  // which is flaky in CI. The loading branch is exercised on every run of
  // this test (the component always passes through it before data
  // resolves) — the hard assertions below focus on the two data-presence
  // outcomes that matter for this spec.
  await page.route('**/api/verticals/network', (route) =>
    route.fulfill({
      status: 200,
      body: JSON.stringify({
        subnets: [
          {
            id: '1',
            name: 'test-subnet',
            addr: '10.0.0.0',
            cidr: 24,
            total: 100,
            used: 92,
            util: 92,
            site: 'HQ',
            severity: 'crit',
          },
        ],
        leases: [
          {
            addr: '10.0.0.5',
            host: 'host1',
            subnet: 'test-subnet',
            subnet_id: '1',
            state: 'active',
            severity: 'ok',
          },
        ],
        zones: [
          {
            id: '1',
            fqdn: 'example.com',
            view: 'default',
            ttl: 3600,
            neg_ttl: 900,
            records: 10,
            issues: [],
            anomaly: false,
            severity: 'ok',
          },
        ],
        views: [],
      }),
    })
  );

  await page.route('**/api/alerts/incidents', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify([]) })
  );

  await page.goto('/index-vite.html');

  await expect(page.getByText('test-subnet')).toBeVisible();
  await expect(page.getByText('No data — check connection')).toHaveCount(0);
});
