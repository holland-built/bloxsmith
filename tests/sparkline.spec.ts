import { test, expect } from '@playwright/test';

// Sparklines on the #security triage table's "24h" column. A series only renders
// when a qname has >=2 distinct non-zero activity hours (no-fabrication guard):
//   - two events, same qname, different hours  -> svg.spark rendered
//   - each qname once (single hour)            -> NO svg.spark, even with rows

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
  await expect(page.locator('svg.spark').first()).toBeVisible();
});

test('single-occurrence series render NO sparkline (no fabrication)', async ({ page }) => {
  await page.route('**/api/hub/security', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FLAT) })
  );
  await page.goto('/#security');
  // Rows exist...
  await expect(page.locator('table.dt tbody tr').first()).toBeVisible();
  // ...but nothing qualifies for a sparkline.
  await expect(page.locator('svg.spark')).toHaveCount(0);
});
