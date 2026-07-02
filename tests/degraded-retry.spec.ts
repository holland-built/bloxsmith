import { test, expect, type Page } from '@playwright/test';

async function mockAuthedAsViewer(page: Page) {
  await page.route('**/auth/me', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ email: 'test@x.com', role: 'operator' }) })
  );
}

// Renders <SubnetsTable> (src/components/NetworkVertical.tsx requires at
// least one non-empty array to skip the empty-state branch), giving the
// post-retry success response something to prove landed by asserting on
// .subnets-table (src/components/SubnetsTable.tsx).
const NETWORK_DATA = {
  subnets: [
    {
      id: '1',
      name: 'core-net',
      addr: '10.0.0.0',
      cidr: 24,
      total: 100,
      used: 50,
      util: 50,
      severity: 'ok',
    },
  ],
  leases: [],
  zones: [],
  views: [],
};

test.describe('degraded state retry', () => {
  test('Retry button re-triggers the network fetch and renders real data', async ({
    page,
  }) => {
    await mockAuthedAsViewer(page);
    await page.route('**/api/alerts/incidents', (route) =>
      route.fulfill({ status: 200, body: JSON.stringify([]) })
    );

    // React 18 StrictMode (src/main.tsx) double-invokes useNetworkData's
    // effect on mount: the first fetch is aborted and re-issued (same
    // landmine documented in tests/triage-landing.spec.ts). Track whether
    // the retry button has actually been clicked yet, rather than counting
    // raw calls, so every call before that click fails and every call
    // after it (including the abort-and-retry pair on mount) succeeds.
    let retried = false;
    await page.route('**/api/verticals/network', (route) => {
      if (!retried) {
        return route.fulfill({ status: 500, body: JSON.stringify({ error: 'boom' }) });
      }
      return route.fulfill({ status: 200, body: JSON.stringify(NETWORK_DATA) });
    });

    await page.goto('/index-vite.html');

    const retryButton = page.locator('.degraded-retry');
    await expect(retryButton).toBeVisible();
    await expect(retryButton).toHaveText('Retry');
    await expect(page.getByText('No data — check connection')).toBeVisible();

    retried = true;
    await retryButton.click();

    await expect(page.locator('.subnets-table')).toBeVisible();
    await expect(page.getByText('core-net')).toBeVisible();
  });
});
