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

test('Assets: a refused inventory read names the reason and Try again reads it again', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/csp/assets*', (route) => {
    calls += 1;
    if (calls === 1) {
      return json(route, {
        availability: 'error', reason: REFUSED, dir: 'desc', page: 0, page_size: 50,
        sort: 'last_seen', rows: [], total: null, has_more: false,
      });
    }
    return json(route, {
      availability: 'ok', dir: 'desc', has_more: false, page: 0, page_size: 50, sort: 'last_seen', total: 1,
      rows: [{ cqid: 'c1', last_seen: '2026-08-10T17:54:44.000', name: 'retry-host.example.internal', provider: 'AWS', type: 'Workstation', vendor: 'Dell' }],
    });
  });
  await page.route('**/api/csp/asset-filters*', (route) => json(route, { availability: 'ok', total: 1, types: [] }));

  await page.goto('/#assets');
  const list = page.locator('[data-panel-id="assets-list"]');
  await expect(list.getByText(REFUSED)).toBeVisible();
  await list.getByRole('button', { name: 'Try again' }).click();
  await expect(list.getByText('retry-host.example.internal')).toBeVisible();
  await expect(list.locator('[data-feed-unavailable]')).toHaveCount(0);
  expect(calls).toBe(2);
});

test('Incidents: a refused IQ Actions read names the reason and Try again reads it again', async ({ page }) => {
  let calls = 0;
  await page.route(/\/api\/actions(\?.*)?$/, (route) => {
    calls += 1;
    if (calls === 1) return json(route, { actions: [], unavailable: REFUSED, availability: 'error' });
    return route.fallback();
  });

  await page.goto('/#incidents');
  const queue = page.locator('[data-panel-id="incidents-soc-queue"]');
  await expect(queue.getByText(REFUSED)).toBeVisible();
  await queue.getByRole('button', { name: 'Try again' }).click();
  await expect(queue.locator('[data-feed-unavailable]')).toHaveCount(0);
  expect(calls).toBeGreaterThanOrEqual(2);
});

test('Threat lookup: a refused search names the reason and Try again runs it again', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/threat-lookup*', (route) => {
    calls += 1;
    if (calls === 1) return json(route, { entities: [], availability: 'error', reason: REFUSED });
    return json(route, { entities: [], availability: 'ok' });
  });

  await page.goto('/#ai');
  const lookup = page.locator('[data-panel-id="ai-threat-lookup"]');
  await lookup.getByPlaceholder('domain, IP, or host…').fill('example.com');
  await lookup.getByRole('button', { name: 'Lookup', exact: true }).click();
  await expect(lookup.getByText(REFUSED)).toBeVisible();
  await lookup.getByRole('button', { name: 'Try again' }).click();
  await expect(lookup.getByText('No matches')).toBeVisible();
  expect(calls).toBe(2);
});

test('Block on the Ask tab: a timed-out write asks to be re-checked, and only a click sends it again', async ({ page }) => {
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
  await lookup.getByRole('button', { name: 'Lookup', exact: true }).click();
  await lookup.getByRole('button', { name: 'Block domain' }).click();
  await expect(lookup.getByText(/did not answer within 12s/)).toBeVisible();

  // Nothing sends it a second time on its own.
  await page.waitForTimeout(1000);
  expect(writes).toBe(1);

  await lookup.getByRole('button', { name: 'Re-check' }).click();
  await expect.poll(() => writes).toBe(2);
});
