import { test, expect, type Page } from '@playwright/test';

async function mockAuthedAsViewer(page: Page) {
  await page.route('**/auth/me', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ email: 'test@x.com', role: 'operator' }) })
  );
}

// Matches the Incident shape from src/types/alerts.ts. entity_type: 'subnet'
// plus sample_entities[0] === 'subnet-1' drives src/lib/drilldown.ts's
// drillTo('subnet', 'subnet-1'), which targets #subnet-subnet-1 (see the
// PREFIX map in that file: subnet -> 'subnet-').
const INCIDENT = {
  key: 'subnet-utilization',
  category: 'subnet-utilization',
  entity_type: 'subnet',
  severity: 'crit',
  count: 1,
  sample_entities: ['subnet-1'],
  first_detected_at: 0,
  message: '1 subnet utilization',
};

// Minimal NetworkData that renders real content (not the empty/degraded
// state) — see src/components/NetworkVertical.tsx and
// tests/triage-landing.spec.ts's NETWORK_DATA comment for the same pattern.
// The subnet's id 'subnet-1' makes SubnetsTable render <tr id="subnet-subnet-1">
// (src/components/SubnetsTable.tsx: id={`subnet-${s.id}`}).
const NETWORK_DATA = {
  subnets: [
    {
      id: 'subnet-1',
      name: 'test-subnet',
      addr: '10.0.0.0',
      cidr: 24,
      total: 100,
      used: 90,
      util: 90,
      severity: 'crit',
    },
  ],
  leases: [],
  zones: [],
  views: [],
};

test.describe('drill-down', () => {
  test('clicking a triage row\'s View button highlights the target subnet row', async ({
    page,
  }) => {
    await mockAuthedAsViewer(page);
    await page.route('**/api/alerts/incidents', (route) =>
      route.fulfill({
        status: 200,
        body: JSON.stringify([INCIDENT]),
      })
    );
    await page.route('**/api/verticals/network', (route) =>
      route.fulfill({
        status: 200,
        body: JSON.stringify(NETWORK_DATA),
      })
    );

    await page.goto('/index-vite.html');

    const triageRow = page.locator('.triage-row');
    await expect(triageRow).toBeVisible();

    const subnetRow = page.locator('#subnet-subnet-1');
    await expect(subnetRow).toBeVisible();

    await triageRow.locator('.triage-view').click();

    // drillTo (src/lib/drilldown.ts) adds 'drill-highlight' synchronously
    // on click; toHaveClass polls/retries so this is not a race even though
    // React 18 StrictMode (src/main.tsx) double-invokes effects on mount —
    // the highlight is applied imperatively via the DOM, not through React
    // state, so it isn't affected by the double-fetch landmine documented
    // in tests/triage-landing.spec.ts.
    await expect(subnetRow).toHaveClass(/drill-highlight/);

    // drillTo removes the class again after HIGHLIGHT_MS (2000ms).
    await expect(subnetRow).not.toHaveClass(/drill-highlight/, {
      timeout: 3000,
    });
  });
});
