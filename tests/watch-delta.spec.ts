import { test, expect } from '@playwright/test';

// Defaults to the shared 8080 base (like the sibling specs); override with
// WD_BASE_URL to point at a throwaway working-tree server on a spare port.
if (process.env.WD_BASE_URL) test.use({ baseURL: process.env.WD_BASE_URL });

// P1 slice 7 — watch expressions + delta-since-last-visit. Both REUSE the
// existing client-side infra (saved-query surface / sq= hash, useSnapshots +
// diffRows, the bx. LS helper) — no backend alert engine, no second snapshot
// store. Runs against the real app (live server, vault unlocked), routing
// /api/data and seeding localStorage deterministically like snapshot-diff.spec.

const SUBNETS = [
  { id: 's1', addr: '10.0.0.1', cidr: 24, util: 95, name: 'Net Alpha', site: 'HQ' },   // baseline 95 → unchanged
  { id: 's2', addr: '10.0.0.2', cidr: 24, util: 88, name: 'Net Bravo', site: 'HQ' },   // baseline 60 → changed
  { id: 's3', addr: '10.0.0.3', cidr: 24, util: 72, name: 'Net Charlie', site: 'HQ' }, // absent in baseline → added
];
const DATA = { subnets: SUBNETS, leases: [], zones: [], hosts: [], auditLogs: [], events: [] };

// A prior daily snapshot in the SAME store the app already reads (bx.snap).
// subnets.top is the per-row shape SnapshotWriter/diffRows already use.
const BASELINE_SNAP = {
  date: '2020-01-01', ts: 0,
  subnets: { n: 3, gt85: 0, b7085: 0, top: [
    { a: '10.0.0.1', u: 95 }, // unchanged
    { a: '10.0.0.2', u: 60 }, // → 88 (changed)
    { a: '10.0.0.9', u: 80 }, // gone below (removed ghost)
  ] },
  leases: { n: 0, active: 0 }, zones: { n: 0, issues: 0 },
  hosts: { n: 0, online: 0, offline: 0 },
  sec: { crit: 0, high: 0, med: 0, low: 0, blocked: 0, logged: 0, total: 0 }, dns7d: null,
};

test('watch = saved BQL query + live match count; save persists, count is live, click applies', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('bx.watches'));
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) }));

  // window.prompt('Save current query as a watch:') supplies the name.
  page.on('dialog', d => d.accept('high-util'));

  // Seed the current query via the existing sq= hash surface.
  await page.goto('/#network?sq=util>85', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();
  await expect(page.locator('input.dt-filter').first()).toHaveValue('util>85');

  // Save the current query as a watch.
  const watchesBtn = page.getByRole('button', { name: 'Watches' });
  await expect(watchesBtn).toBeVisible();
  await watchesBtn.click();
  await page.locator('.views-item', { hasText: 'Watch current query' }).click();
  await expect(page.locator('.toast', { hasText: 'high-util' })).toBeVisible();

  // Persisted client-side in the shared bx. LS namespace (no server round-trip).
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('bx.watches') || '[]'));
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ name: 'high-util', tab: 'network', query: 'util>85' });

  // Live match count (menu is still open): util>85 matches 10.0.0.1(95) +
  // 10.0.0.2(88) = 2, computed against current data via parseQuery/buildPredicate.
  const row = page.locator('.watch-row', { hasText: 'high-util' });
  await expect(row.locator('.watch-count')).toHaveText('2');

  // Close the menu, then move to another tab so applying the watch remounts
  // Network fresh (and its search seeds from the sq= hash).
  await page.locator('.views-overlay').click();
  await page.locator('.tabbar .tab', { hasText: 'Overview' }).click();
  await expect(page.locator('.tabbar .tab.active', { hasText: 'Overview' })).toBeVisible();

  await page.getByRole('button', { name: 'Watches' }).click();
  await expect(page.locator('.watch-row', { hasText: 'high-util' }).locator('.watch-count')).toHaveText('2');
  await page.locator('.watch-row', { hasText: 'high-util' }).locator('.watch-item').click();

  // Clicking the watch runs it: the query is applied to the tab.
  await expect(page.locator('.tabbar .tab.active', { hasText: 'Network' })).toBeVisible();
  await expect(page.locator('input.dt-filter').first()).toHaveValue('util>85');
  const table = page.locator('table.dt').first();
  await expect(table.locator('tr', { hasText: 'Net Alpha' })).toBeVisible();
  await expect(table.locator('tr', { hasText: 'Net Charlie' })).toHaveCount(0); // util 72 filtered out
});

test('delta chip shows +N new / ~M changed since last visit and surfaces those rows (glyph+text, monochrome)', async ({ page }) => {
  await page.addInitScript((snap) => {
    localStorage.setItem('bx.snap', JSON.stringify({ v: 1, days: [snap] }));
    // Last visit was 2020-01-02 → baseline = the 2020-01-01 snapshot.
    localStorage.setItem('bx.tabVisit', JSON.stringify({ network: { ts: Date.parse('2020-01-02T00:00:00Z'), date: '2020-01-02' } }));
  }, BASELINE_SNAP);
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) }));

  await page.goto('/#network', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  // Chip = glyph + count text (never color-only). +1 new (10.0.0.3), ~1 changed (10.0.0.2).
  const chip = page.locator('.delta-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('1 new');
  await expect(chip).toContainText('1 changed');
  await expect(chip).toHaveAttribute('aria-label', /since your last visit/i);

  // Clicking surfaces the new/changed rows.
  await chip.click();
  const pop = page.locator('.delta-pop');
  await expect(pop).toBeVisible();

  const added = pop.locator('.delta-pop-row', { hasText: 'Net Charlie' }).locator('.dt-diff span');
  await expect(added).toHaveText('+');
  await expect(added).toHaveAttribute('aria-label', 'added');

  const changed = pop.locator('.delta-pop-row', { hasText: 'Net Bravo' }).locator('.dt-diff span');
  await expect(changed).toHaveText('~');
  await expect(changed).toHaveAttribute('aria-label', 'changed');

  // HARD GATE — glyph is monochrome text (--text), not a red/green tint.
  const [glyphColor, textColor, critColor, okColor] = await Promise.all([
    added.evaluate(el => getComputedStyle(el).color),
    page.evaluate(() => getComputedStyle(document.body).color),
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--crit').trim()),
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ok').trim()),
  ]);
  expect(glyphColor).toBe(textColor);
  expect(glyphColor.toLowerCase()).not.toContain(critColor.toLowerCase());
  expect(glyphColor.toLowerCase()).not.toContain(okColor.toLowerCase());
});
