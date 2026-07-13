import { test, expect } from '@playwright/test';

// Shareable-URL view state (Feature 1): EXTENDS the existing "Copy link to this
// view" palette action (F3, copy-link.spec.ts) so the copied URL also reproduces
// the ACTIVE table view — its BQL search string, sort key/direction, and hidden
// columns — not just the section + pivot filters copy-link already covered.
// DataTable namespaces these under `<tableId>.q` / `<tableId>.sort` / `<tableId>.cols`
// in the hash (see index.html DataTable, the useState lazy initializers + the
// mirror-back useEffects right after togglePinCol). Uses the #security triage
// table (tableId="triage") — same fixture/table copy-cell.spec.ts already uses.

test.use({ baseURL: process.env.NOC_BASE || 'http://localhost:8091' });

const SECURITY = {
  counts: { critical: 1, high: 1, medium: 1 }, blocked: 0, logged: 0, total: 3,
  events: [
    { severity: 'critical', qname: 'crit.example', policy_action: 'block', feed_name: 'f1', device: 'd1', event_time: '2026-07-09T10:00:00Z' },
    { severity: 'high',     qname: 'high.example', policy_action: 'log',   feed_name: 'f2', device: 'd2', event_time: '2026-07-09T09:00:00Z' },
    { severity: 'medium',   qname: 'med.example',  policy_action: 'log',   feed_name: 'f3', device: 'd3', event_time: '2026-07-09T08:00:00Z' },
  ],
};

async function mock(page: any) {
  await page.route('**/api/hub/security', (route: any) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SECURITY) })
  );
}

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

test('copy-link encodes search + sort + hidden column, and loading it restores the view', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');

  const rows = page.locator('table.dt tbody tr');
  await expect(rows.first()).toBeVisible();

  // 1. Search: scope to the two "log" events (action alias -> policy_action).
  const filterInput = page.locator('.dt-filter');
  await filterInput.fill('action:log');
  await expect(rows).toHaveCount(2);

  // 2. Sort by Query (qname) ascending.
  await page.locator('th', { hasText: 'Query' }).click();
  await expect(page.locator('th', { hasText: 'Query' }).locator('.sort-ind')).toHaveText('↑');

  // 3. Hide the Device column via the Cols menu.
  await page.locator('button', { hasText: '⋯ Cols' }).click();
  await page.getByLabel('Hide Device column').uncheck();
  await page.keyboard.press('Escape');
  await expect(page.locator('th', { hasText: 'Device' })).toHaveCount(0);

  // 4. Copy link — the enriched hash must carry all three.
  await page.keyboard.press('Meta+k');
  await page.locator('.palette-in').fill('copy link');
  await page.locator('.pal-row', { hasText: 'Copy link to this view' }).click();

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(page.url());
  const hashParams = new URLSearchParams(new URL(clip).hash.split('?')[1] || '');
  expect(hashParams.get('triage.q')).toBe('action:log');
  expect(hashParams.get('triage.sort')).toBe('qname:asc');
  expect(hashParams.get('triage.cols')).toBe('device');

  // 5. Loading that URL fresh restores search, sort, and hidden column.
  await page.goto(clip);
  const rows2 = page.locator('table.dt tbody tr');
  await expect(rows2).toHaveCount(2);
  await expect(page.locator('.dt-filter')).toHaveValue('action:log');
  await expect(page.locator('th', { hasText: 'Query' }).locator('.sort-ind')).toHaveText('↑');
  await expect(page.locator('th', { hasText: 'Device' })).toHaveCount(0);
});
