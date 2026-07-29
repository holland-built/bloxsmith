import { test, expect } from './fixtures';

// Third batch of "failure shown as absence" fixes. Same pattern as
// failure-not-absence.spec.ts / -2.spec.ts: stub the same endpoint twice —
// once as csp.go's on-demand-failure shape (HTTP 200 carrying status:"error"),
// once as a genuine empty/ok read — and assert the two render different,
// non-overlapping text. Genuine-empty wording must stay exactly as it was.

function fulfillJson(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

// ---------- Audit → CSP Portal Audit (csp.go:849-851 200+status:"error") ----------

test.describe('Audit → CSP Portal Audit panel (CspAuditTable)', () => {
  test('a 200 with status:"error" shows unavailable wording, not "no entries match"', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) =>
      fulfillJson(route, { rows: [], count: 0, truncated: false, status: 'error' }),
    );
    await page.goto('/#audit');
    const card = page.locator('text=CSP Portal Audit').locator('..').locator('..');
    await card.getByPlaceholder('Search user or resource…').fill('who deleted this zone');
    await card.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(card.getByText(/csp audit feed unavailable/i)).toBeVisible();
    await expect(card.getByText('no entries match', { exact: true })).toHaveCount(0);
  });

  test('a genuine empty result still renders "no entries match"', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) =>
      fulfillJson(route, { rows: [], count: 0, truncated: false, status: 'ok' }),
    );
    await page.goto('/#audit');
    const card = page.locator('text=CSP Portal Audit').locator('..').locator('..');
    await card.getByPlaceholder('Search user or resource…').fill('nobody-matches-this-query');
    await card.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(card.getByText('no entries match', { exact: true })).toBeVisible();
    await expect(card.getByText(/csp audit feed unavailable/i)).toHaveCount(0);
  });
});
