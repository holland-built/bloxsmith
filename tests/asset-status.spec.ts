import { test, expect } from './fixtures';

// Server contract (go/internal/dashboard/assetcounts.go): scalarCount used to
// return status: "empty" whenever its cube query FAILED, making a dead query
// indistinguishable from a tenant that genuinely has zero assets. It now
// returns status: "error" on a failed query (or MCP init failure), and
// reserves status: "empty" for a successful query that genuinely returned
// zero. These specs prove the two panels that consume this payload — Infra's
// Discovered assets tile and Security's Asset Insights card — tell the two
// cases apart: "error" renders the shared FeedUnavailable wording (never the
// zero-count "no ... for this tenant" language), while "empty" still renders
// the original empty-state wording, and "ok" renders the real total.

function fulfillJson(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

function scalarCountPayload(overrides: { total?: number; status: string }) {
  return {
    total: overrides.total ?? 0,
    breakdown_available: false,
    note: '',
    status: overrides.status,
  };
}

test.describe('Infra → Discovered assets tile (discovery-status feed)', () => {
  const tile = (page: import('@playwright/test').Page) =>
    page.getByRole('list', { name: 'Headline numbers' }).getByRole('link', { name: /Discovered assets/ });

  test('discovery feed error shows a dash and says unavailable, never a zero', async ({ page }) => {
    await page.route('**/api/csp/discovery-status*', (route) =>
      fulfillJson(route, scalarCountPayload({ status: 'error' })),
    );
    await page.goto('/#infra');
    await expect(tile(page)).toContainText('unavailable');
    await expect(tile(page)).toContainText('—');
    await expect(tile(page)).not.toContainText('0');
  });

  test('discovery feed empty shows a real zero', async ({ page }) => {
    await page.route('**/api/csp/discovery-status*', (route) =>
      fulfillJson(route, scalarCountPayload({ status: 'empty' })),
    );
    await page.goto('/#infra');
    await expect(tile(page)).toContainText('0');
    await expect(tile(page)).not.toContainText('unavailable');
  });

  test('discovery feed ok shows the real total and opens Assets', async ({ page }) => {
    await page.route('**/api/csp/discovery-status*', (route) =>
      fulfillJson(route, scalarCountPayload({ total: 42, status: 'ok' })),
    );
    await page.goto('/#infra');
    await expect(tile(page)).toContainText('42');
    await expect(tile(page)).toHaveAttribute('href', '#assets');
  });
});

test.describe('Security → Asset Insights panel (asset-insights feed)', () => {
  test('asset insights feed error renders unavailable wording, not "no asset insights"', async ({ page }) => {
    await page.route('**/api/csp/asset-insights*', (route) =>
      fulfillJson(route, scalarCountPayload({ status: 'error' })),
    );
    await page.goto('/#security');
    const card = page.locator('text=Asset Insights').locator('..').locator('..');
    await expect(card.getByText(/asset insights unavailable/i)).toBeVisible();
    await expect(card.getByText(/no asset insights for this tenant/i)).toHaveCount(0);
  });

  test('asset insights feed empty renders the original empty-state wording', async ({ page }) => {
    await page.route('**/api/csp/asset-insights*', (route) =>
      fulfillJson(route, scalarCountPayload({ status: 'empty' })),
    );
    await page.goto('/#security');
    const card = page.locator('text=Asset Insights').locator('..').locator('..');
    await expect(card.getByText(/no asset insights for this tenant/i)).toBeVisible();
    await expect(card.getByText(/asset insights unavailable/i)).toHaveCount(0);
  });

  test('asset insights feed ok renders the real total', async ({ page }) => {
    await page.route('**/api/csp/asset-insights*', (route) =>
      fulfillJson(route, scalarCountPayload({ total: 7, status: 'ok' })),
    );
    await page.goto('/#security');
    const card = page.locator('text=Asset Insights').locator('..').locator('..');
    await expect(card.getByText('7')).toBeVisible();
    await expect(card.getByText(/asset insights unavailable/i)).toHaveCount(0);
    await expect(card.getByText(/no asset insights for this tenant/i)).toHaveCount(0);
  });
});
