import { test, expect } from '@playwright/test';

// 24h activity trend on the #security triage table's "24h" column. It's now a
// MiniBars primitive (svg.rowspark), and only renders when a qname has >=2 distinct
// non-zero activity hours (no-fabrication guard):
//   - two events, same qname, different hours  -> svg.rowspark rendered
//   - each qname once (single hour)            -> NO svg.rowspark, even with rows

const TREND = {
  counts: { high: 2 },
  events: [
    { severity: 'high', qname: 'trend.example', policy_action: 'log', feed_name: 'f', device: 'd', event_time: '2026-07-09T08:00:00Z' },
    { severity: 'high', qname: 'trend.example', policy_action: 'log', feed_name: 'f', device: 'd', event_time: '2026-07-09T10:00:00Z' },
  ],
};

const FLAT = {
  counts: { high: 1, low: 1 },
  events: [
    { severity: 'high', qname: 'a.example', policy_action: 'log', feed_name: 'f', device: 'd', event_time: '2026-07-09T08:00:00Z' },
    { severity: 'low',  qname: 'b.example', policy_action: 'log', feed_name: 'f', device: 'd', event_time: '2026-07-09T09:00:00Z' },
  ],
};

test('a qname with >=2 active hours renders a sparkline', async ({ page }) => {
  await page.route('**/api/hub/security', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TREND) })
  );
  await page.goto('/#security');
  await expect(page.locator('table.dt tbody tr').first()).toBeVisible();
  await expect(page.locator('table.dt svg.rowspark').first()).toBeVisible();
});

test('single-occurrence series render NO sparkline (no fabrication)', async ({ page }) => {
  await page.route('**/api/hub/security', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FLAT) })
  );
  await page.goto('/#security');
  // Rows exist...
  await expect(page.locator('table.dt tbody tr').first()).toBeVisible();
  // ...but nothing qualifies for a 24h trend.
  await expect(page.locator('table.dt svg.rowspark')).toHaveCount(0);
});
