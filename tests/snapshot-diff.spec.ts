import { test, expect } from '@playwright/test';

// Compare-to-snapshot: diffs the Subnets table's current rows against the prior
// day's snapshot already captured by useSnapshots/SnapshotWriter (bx.snap in
// localStorage). HARD GATE: the diff signal is a glyph (+/-/~) + aria/text
// label per row — never a red/green background. This spec seeds a prior day
// directly into localStorage (same store the app already reads/writes) so the
// diff is deterministic, then asserts glyph+label on added/changed/removed rows
// and that the unchanged row carries no mark.

const PREV_SNAP_DAY = {
  date: '2020-01-01', // always < "today" — deterministic "prev" pick
  ts: 0,
  subnets: {
    n: 3, gt85: 0, b7085: 0,
    top: [
      { a: '10.0.0.1', u: 80 }, // present unchanged below (still 80)
      { a: '10.0.0.2', u: 60 }, // present but util changes to 90 below
      { a: '10.0.0.5', u: 75 }, // absent below -> removed/ghost
    ],
  },
  leases: { n: 0, active: 0 },
  zones: { n: 0, issues: 0 },
  hosts: { n: 0, online: 0, offline: 0 },
  sec: { crit: 0, high: 0, med: 0, low: 0, blocked: 0, logged: 0, total: 0 },
  dns7d: null,
};

const SUBNETS = [
  { id: 's1', addr: '10.0.0.1', cidr: 24, util: 80, name: 'Net A', site: 'HQ' }, // unchanged
  { id: 's2', addr: '10.0.0.2', cidr: 24, util: 90, name: 'Net B', site: 'HQ' }, // changed 60->90
  { id: 's3', addr: '10.0.0.9', cidr: 24, util: 95, name: 'Net C', site: 'HQ' }, // added (new addr)
];
const DATA = { subnets: SUBNETS, leases: [], zones: [], hosts: [], auditLogs: [], events: [] };

test('Compare to snapshot marks +/~/- rows with glyph+aria label, never color alone', async ({ page }) => {
  await page.addInitScript((snap) => {
    localStorage.setItem('bx.snap', JSON.stringify({ v: 1, days: [snap] }));
  }, PREV_SNAP_DAY);

  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );

  await page.goto('/#network', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  const compareBtn = page.getByRole('button', { name: 'Compare to snapshot' });
  await expect(compareBtn).toBeEnabled();
  await compareBtn.click();
  await expect(page.getByRole('button', { name: 'Comparing' })).toBeVisible();

  const table = page.locator('table.dt').first();

  // Added row: '+' glyph, aria-label "added".
  const addedGlyph = table.locator('tr', { hasText: 'Net C' }).locator('.dt-diff span');
  await expect(addedGlyph).toHaveText('+');
  await expect(addedGlyph).toHaveAttribute('aria-label', 'added');

  // Changed row: '~' glyph, aria-label "changed".
  const changedGlyph = table.locator('tr', { hasText: 'Net B' }).locator('.dt-diff span');
  await expect(changedGlyph).toHaveText('~');
  await expect(changedGlyph).toHaveAttribute('aria-label', 'changed');

  // Unchanged row: gutter cell renders, but with no glyph/label (no mark).
  const unchangedGlyph = table.locator('tr', { hasText: 'Net A' }).locator('.dt-diff span');
  await expect(unchangedGlyph).toHaveCount(0);

  // Removed row: struck-through ghost row, '-' glyph (U+2212), aria-label "removed".
  const ghostRow = table.locator('tr.dt-ghost');
  await expect(ghostRow).toHaveCount(1);
  const ghostGlyph = ghostRow.locator('.dt-diff span');
  await expect(ghostGlyph).toHaveText('−');
  await expect(ghostGlyph).toHaveAttribute('aria-label', 'removed');
  await expect(ghostRow.locator('td').nth(1)).toHaveCSS('text-decoration-line', 'line-through');

  // HARD GATE — glyph is monochrome text, not a red/green tint: the diff glyph's
  // color must equal the page's ordinary text color (--text), not the crit/ok
  // tokens (red/green), in whichever theme is active.
  const [glyphColor, textColor, critColor, okColor] = await Promise.all([
    addedGlyph.evaluate(el => getComputedStyle(el).color),
    page.evaluate(() => getComputedStyle(document.body).color),
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--crit').trim()),
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ok').trim()),
  ]);
  expect(glyphColor).toBe(textColor);
  expect(glyphColor.toLowerCase()).not.toContain(critColor.toLowerCase());
  expect(glyphColor.toLowerCase()).not.toContain(okColor.toLowerCase());
});
