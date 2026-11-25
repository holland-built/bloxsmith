import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';
import type { Route } from '@playwright/test';

// When Infoblox refuses or is slow, a failing panel says why and offers Try
// again. The server's wording is stubbed here exactly as
// go/internal/mcp/mcp.go's RefusedReason writes it; the Go tests hold the words,
// these tests hold that the panel shows them and the button runs the read again.

const REFUSED =
  "Infoblox refused the call (HTTP 403). This key's user probably needs the ib-mcp-server-user group (Infoblox ticket PTCI-4674).";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.setViewportSize({ width: 1440, height: 900 });
});

// A refusal will not change on a retry, so these name the reason with no Try again.
test('Assets: a refused inventory read is a permission problem and names the reason', async ({ page }) => {
  await page.route('**/api/csp/assets*', (route) => json(route, {
    availability: 'error', reason: REFUSED, dir: 'desc', page: 0, page_size: 50,
    sort: 'last_seen', rows: [], total: null, has_more: false,
  }));
  await page.route('**/api/csp/asset-filters*', (route) => json(route, { availability: 'ok', total: 1, types: [] }));

  await page.goto('/#assets');
  const list = page.locator('[data-panel-id="assets-list"]');
  await expect(list.getByText(REFUSED)).toBeVisible();
  await expect(list.getByText('No permission')).toBeVisible();
  await expect(list.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test('Threat lookup: a refused search names the reason, and Lookup runs it again', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/threat-lookup*', (route) => {
    calls += 1;
    if (calls === 1) return json(route, { entities: [], availability: 'error', reason: REFUSED });
    return json(route, { entities: [], availability: 'ok' });
  });

  await page.goto('/#ai');
  const lookup = page.locator('[data-panel-id="ai-threat-lookup"]');
  await lookup.getByPlaceholder('domain, IP, or host…').fill('example.com');
  await lookup.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(lookup.getByText(REFUSED)).toBeVisible();
  await expect(lookup.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await lookup.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(lookup.getByText('No matches')).toBeVisible();
  expect(calls).toBe(2);
});

test('Block on the Ask tab: a timed-out write says to check first, and only a click sends it again', async ({ page }) => {
  await page.route('**/api/threat-lookup*', (route) => json(route, { entities: [], availability: 'ok' }));
  let writes = 0;
  await page.route('**/api/block-domain', (route) => {
    writes += 1;
    return json(route, {
      ok: false, outcome: 'unverified',
      error: 'Infoblox did not answer within 12s. The change may already have applied: refresh and re-check before retrying.',
    }, 502);
  });

  await page.goto('/#ai');
  const lookup = page.locator('[data-panel-id="ai-threat-lookup"]');
  await lookup.getByPlaceholder('domain, IP, or host…').fill('bad.example.com');
  await lookup.getByRole('button', { name: 'Look up', exact: true }).click();
  await lookup.getByRole('button', { name: 'Block domain' }).click();
  await expect(lookup.getByText(/did not answer within 12s/)).toBeVisible();

  // Nothing sends it a second time on its own.
  await page.waitForTimeout(1000);
  expect(writes).toBe(1);

  // The button says what it does: it sends the block again.
  await expect(lookup.getByRole('button', { name: 'Re-check' })).toHaveCount(0);
  await expect(lookup.getByText(/refresh and re-check before retrying/)).toBeVisible();
  await lookup.getByRole('button', { name: 'Send the block again' }).click();
  await expect.poll(() => writes).toBe(2);
});

const WRITABLE = { known: true, tenant: 't/-', label: 'Test Tenant', writable: true };
const UNCONFIRMED = {
  ok: false, outcome: 'unverified',
  error: 'Infoblox did not answer within 12s. The change may already have applied: refresh and re-check before retrying.',
};

test('Unblock on the Ask tab: the button after a timeout says it sends the unblock again', async ({ page }) => {
  await page.route('**/api/threat-lookup*', (route) => json(route, { entities: [], availability: 'ok' }));
  await page.route('**/api/block-domain', (route) => json(route, { ok: true }));
  let unblocks = 0;
  await page.route('**/api/unblock-domain', (route) => { unblocks += 1; return json(route, UNCONFIRMED, 502); });

  await page.goto('/#ai');
  const lookup = page.locator('[data-panel-id="ai-threat-lookup"]');
  await lookup.getByPlaceholder('domain, IP, or host…').fill('bad.example.com');
  await lookup.getByRole('button', { name: 'Look up', exact: true }).click();
  await lookup.getByRole('button', { name: 'Block domain' }).click();
  await lookup.getByRole('button', { name: 'Unblock' }).click();
  await expect(lookup.getByText(/refresh and re-check before retrying/)).toBeVisible();
  await lookup.getByRole('button', { name: 'Send the unblock again' }).click();
  await expect.poll(() => unblocks).toBe(2);
});

test('Security: the button after a timeout names the block or unblock it sends again', async ({ page }) => {
  await page.route('**/api/vault/write-target*', (route) => json(route, WRITABLE));
  let blocks = 0;
  let unblocks = 0;
  await page.route('**/api/block-domain', (route) => {
    blocks += 1;
    return blocks === 1 ? json(route, UNCONFIRMED, 502) : json(route, { ok: true, outcome: 'verified' });
  });
  await page.route('**/api/unblock-domain', (route) => { unblocks += 1; return json(route, UNCONFIRMED, 502); });

  await page.goto('/#security');
  await page.locator('button.sec-block').first().click({ force: true });
  await expect(page.getByText(/refresh and re-check before retrying/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Re-check' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Send the block again' }).first().click();
  await expect.poll(() => blocks).toBe(2);

  await page.getByRole('button', { name: 'Unblock' }).first().click();
  await page.getByRole('button', { name: 'Send the unblock again' }).first().click();
  await expect.poll(() => unblocks).toBe(2);
});
