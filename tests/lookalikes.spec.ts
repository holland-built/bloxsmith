import { test, expect } from '@playwright/test';

// SECURITY SecLookalikes panel (/api/lookalikes). Renders a DataTable of domains,
// or a "Not entitled" empty state when the endpoint reports unavailable.

const EMPTY_SEC = { counts: {}, blocked: 0, logged: 0, total: 0, events: [] };

async function mockSec(page: any, lookalikes: any) {
  await page.route('**/api/hub/security', (r: any) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY_SEC) }));
  await page.route('**/api/lookalikes', (r: any) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lookalikes) }));
}

test('lookalikes panel renders the returned domains', async ({ page }) => {
  await mockSec(page, {
    domains: [
      { lookalike: 'g00gle.com', target: 'google.com', reason: 'homoglyph' },
      { lookalike: 'paypa1.com', target: 'paypal.com', reason: 'typosquat' },
    ],
  });

  await page.goto('/#security');

  await expect(page.getByText('Lookalike domains')).toBeVisible();
  await expect(page.getByText('g00gle.com')).toBeVisible();
  await expect(page.getByText('paypa1.com')).toBeVisible();
});

test('an unavailable lookalikes feed shows the not-entitled empty state', async ({ page }) => {
  await mockSec(page, { unavailable: 'Lookalike domains not entitled' });

  await page.goto('/#security');

  await expect(page.getByText('Lookalike domains')).toBeVisible();
  await expect(page.getByText(/Not entitled/)).toBeVisible();
});
