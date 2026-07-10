import { test, expect } from '@playwright/test';

// SECURITY VolumeHistogram (display-form primitive). Mocks /api/hub/security with
// 20 events: 14 clustered at the earliest timestamp (bucket 0) + 6 spread later.
// Clicking bucket 0's bar sets a single-bucket range that narrows the triage inbox
// to the 14 clustered rows; Clear restores the full list.

const BASE = Date.parse('2026-07-09T00:00:00Z');
const events: any[] = [];
for (let i = 0; i < 14; i++) {
  events.push({
    severity: 'high', qname: `cluster${i}.example`, policy_action: 'log',
    feed_name: 'f', device: `d${i}`, event_time: new Date(BASE).toISOString(),
  });
}
for (let k = 1; k <= 6; k++) {
  events.push({
    severity: 'medium', qname: `spread${k}.example`, policy_action: 'log',
    feed_name: 'f', device: `s${k}`, event_time: new Date(BASE + k * 3600_000).toISOString(),
  });
}

const SECURITY = {
  counts: { critical: 0, high: 14, medium: 6 }, blocked: 0, logged: 20, total: 20,
  events,
};

test('histogram bars render and a bar click narrows the triage inbox; Clear restores', async ({ page }) => {
  await page.route('**/api/hub/security', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SECURITY) })
  );

  await page.goto('/#security');

  const svg = page.locator('.vh-svg');
  await expect(svg).toBeVisible();
  const bars = svg.locator('.vh-bar');
  expect(await bars.count()).toBeGreaterThanOrEqual(2);

  const rows = page.locator('table.dt tbody tr');
  await expect(rows.first()).toBeVisible();
  const initial = await rows.count();
  expect(initial).toBeGreaterThan(14);

  // Click the leftmost (tallest) bar = bucket 0 = the 14-event cluster.
  await bars.first().click();

  await expect.poll(async () => await rows.count()).toBeLessThan(initial);
  const narrowed = await rows.count();
  expect(narrowed).toBeGreaterThan(0);

  // Clear the selection -> full inbox returns.
  await page.locator('.vh-clear').click();
  await expect.poll(async () => await rows.count()).toBe(initial);
});
