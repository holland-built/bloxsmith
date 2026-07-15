import { test, expect } from '@playwright/test';

// Feature 7 — multi-column sort. EXTENDS DataTable's existing single-column sort
// (header click cycles asc/desc/none, see view-state.spec.ts for the single-key
// hash-mirror contract this file must stay backward-compatible with). Uses the
// #security "triage" table (tableId="triage") — same fixture shape view-state.spec.ts
// uses, with two rows sharing the same severity so the secondary key is observable.

test.use({ baseURL: process.env.NOC_BASE || 'http://localhost:8091' });

// The "high" row's qname ('a.example') sorts BEFORE both criticals' qnames
// alphabetically — so a qname-ONLY sort would put it first, while a real
// severity-then-qname sort keeps both criticals ahead of it. That divergence is
// what makes the ordering assertion actually discriminate "shift-click adds a
// secondary key" from "shift-click behaves like a plain click" (old single-sort).
const SECURITY = {
  counts: { critical: 2, high: 1 }, blocked: 0, logged: 0, total: 3,
  events: [
    { severity: 'critical', qname: 'y.example', policy_action: 'block', feed_name: 'f1', device: 'd2', event_time: '2026-07-09T09:00:00Z' },
    { severity: 'critical', qname: 'm.example', policy_action: 'block', feed_name: 'f1', device: 'd1', event_time: '2026-07-09T10:00:00Z' },
    { severity: 'high',     qname: 'a.example', policy_action: 'log',   feed_name: 'f2', device: 'd3', event_time: '2026-07-09T08:00:00Z' },
  ],
};

async function mock(page) {
  await page.route('**/api/hub/security', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SECURITY) })
  );
}

// #security renders SEVERAL DataTables (triage, lookalikes, insights…) and more than
// one of them has a "Severity" column — an unscoped page.locator('th') is a strict-mode
// violation whose match count depends on which sibling tables have finished loading.
// Everything here is scoped to the triage table via its DataTable root (data-table-id).
const triage = (page) => page.locator('[data-table-id="triage"]');
const th = (page, name: string) => triage(page).locator('th').filter({ hasText: name });

test('shift-click appends a secondary sort key, applied stably in order', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');
  const rows = triage(page).locator('tbody tr');
  await expect(rows.first()).toBeVisible();

  // Primary: severity asc (critical < high alphabetically) — both criticals tie.
  await th(page, 'Severity').click();
  await expect(th(page, 'Severity').locator('.sort-ind')).toHaveText('↑');

  // Secondary: shift-click Query asc — breaks the tie between the two criticals.
  await th(page, 'Query').click({ modifiers: ['Shift'] });

  await expect(rows).toHaveCount(3);
  const texts = await rows.evaluateAll(trs => trs.map(tr => tr.textContent || ''));
  // severity asc groups both criticals first (m.example, y.example, tied on
  // severity so broken by qname asc); high (a.example) comes last DESPITE its
  // qname sorting alphabetically first — proves severity is still the primary key.
  expect(texts[0]).toContain('m.example');
  expect(texts[1]).toContain('y.example');
  expect(texts[2]).toContain('a.example');
});

test('order badges + aria-sort mark each active sort column', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');
  await expect(triage(page).locator('tbody tr').first()).toBeVisible();

  await th(page, 'Severity').click();
  await th(page, 'Query').click({ modifiers: ['Shift'] });

  const sevTh = th(page, 'Severity');
  const qTh = th(page, 'Query');
  await expect(sevTh.locator('.sort-ind')).toHaveText('1↑');
  await expect(qTh.locator('.sort-ind')).toHaveText('2↑');
  await expect(sevTh).toHaveAttribute('aria-sort', 'ascending');
  await expect(qTh).toHaveAttribute('aria-sort', 'ascending');
  await expect(th(page, 'Device')).toHaveAttribute('aria-sort', 'none');
});

test('hash carries the ordered multi-key list, and reloading it restores the order', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');
  await expect(triage(page).locator('tbody tr').first()).toBeVisible();

  await th(page, 'Severity').click();
  await th(page, 'Query').click({ modifiers: ['Shift'] });

  await expect(page).toHaveURL(/triage\.sort=severity%3Aasc%2Cqname%3Aasc/);

  await page.reload();
  await expect(triage(page).locator('tbody tr').first()).toBeVisible();
  await expect(th(page, 'Severity').locator('.sort-ind')).toHaveText('1↑');
  await expect(th(page, 'Query').locator('.sort-ind')).toHaveText('2↑');
});

test('a plain click resets to single-sort on that column, dropping secondary keys', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');
  await expect(triage(page).locator('tbody tr').first()).toBeVisible();

  await th(page, 'Severity').click();
  await th(page, 'Query').click({ modifiers: ['Shift'] });

  // Plain click on Query — collapses to single-sort on Query only.
  await th(page, 'Query').click();
  await expect(th(page, 'Query').locator('.sort-ind')).toHaveText('↑');
  await expect(th(page, 'Severity').locator('.sort-ind')).toHaveText('');
  await expect(th(page, 'Severity')).toHaveAttribute('aria-sort', 'none');
  await expect(page).toHaveURL(/triage\.sort=qname%3Aasc/);
  await expect(page).not.toHaveURL(/severity/);
});

test('single-sort hash format is unchanged (backward-compat with saved links)', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');
  await expect(triage(page).locator('tbody tr').first()).toBeVisible();
  await th(page, 'Query').click();
  await expect(page).toHaveURL(/triage\.sort=qname%3Aasc(?!%2C)/);
});
