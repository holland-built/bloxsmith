import { test, expect } from '@playwright/test';

// Group C, Feature #2 — pivot-on-cell. Ordinary (non-pivot) DataTable cells gain
// a "Filter by this value" affordance that funnels into the SAME fx.toggle /
// FilterCtx mechanism the existing .pivot-cell columns already use (F5's
// pivot-cell click-to-cross-filter, ~1177) — same chip, same FilterBar, same
// toast/aria-live announcement bus.
//
// Uses the #security triage table (SecTriageInbox): its rows are NOT
// onRowClick-clickable, so a plain left-click on an ordinary cell still means
// "copy" (see copy-cell.spec.ts) and the new pivot affordance rides a SEPARATE
// gesture — right-click (contextmenu) and, since these rows aren't row-click-
// owned, keyboard Shift+F10 / the Menu key on the cell itself.

const SECURITY = {
  counts: { critical: 1, high: 1, medium: 1 }, blocked: 0, logged: 0, total: 3,
  events: [
    { severity: 'critical', qname: 'crit.example', policy_action: 'block', feed_name: 'f1', device: 'd1', event_time: '2026-07-09T10:00:00Z' },
    { severity: 'high',     qname: 'high.example', policy_action: 'log',   feed_name: 'f2', device: 'd2', event_time: '2026-07-09T09:00:00Z' },
    { severity: 'medium',   qname: 'med.example',  policy_action: 'log',   feed_name: 'f3', device: 'd3', event_time: '2026-07-09T08:00:00Z' },
  ],
};

// #security renders several DataTables; an unscoped 'table.dt tbody tr' matches
// every one of them (700+ rows). Scope to the triage table via its DataTable root.
const triage = (page: any) => page.locator('[data-table-id="triage"]');

async function mock(page: any) {
  await page.route('**/api/hub/security', (route: any) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SECURITY) })
  );
}

test('right-click on an ordinary cell offers "Filter by this value" and narrows the table', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');

  const rows = triage(page).locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  await expect(rows).toHaveCount(3);

  const cell = rows.first().locator('td', { hasText: 'crit.example' });
  await cell.click({ button: 'right' });

  const menuItem = page.getByRole('menuitem', { name: /Filter by this value.*crit\.example/ });
  await expect(menuItem).toBeVisible();
  await menuItem.click();

  // Same chip / FilterBar the pivot-cell columns already produce.
  const chip = page.locator('.filter-bar .chip.active', { hasText: 'Query: crit.example' });
  await expect(chip).toBeVisible();
  await expect(rows).toHaveCount(1);

  // Announced via the shared toast/aria-live bus.
  const live = page.locator('.toasts[aria-live="polite"]');
  await expect(live).toContainText('Filtered to Query: crit.example');
});

test('keyboard: Shift+F10 on a focused ordinary cell opens the same pivot action', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');

  const rows = triage(page).locator('tbody tr');
  await expect(rows.first()).toBeVisible();

  const cell = rows.nth(1).locator('td', { hasText: 'high.example' });
  await cell.focus();
  await cell.press('Shift+F10');

  const menuItem = page.getByRole('menuitem', { name: /Filter by this value.*high\.example/ });
  await expect(menuItem).toBeVisible();
  await menuItem.press('Enter');

  const chip = page.locator('.filter-bar .chip.active', { hasText: 'Query: high.example' });
  await expect(chip).toBeVisible();
  await expect(rows).toHaveCount(1);
});

test('pivot columns are unaffected — no duplicate context menu on the existing .pivot-cell affordance', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');

  const rows = triage(page).locator('tbody tr');
  await expect(rows.first()).toBeVisible();

  // severity is already pivot:true — right-clicking it must NOT open the new
  // ordinary-cell menu (it already has its own click-to-pivot affordance).
  const sevCell = rows.first().locator('td .pivot-cell').first();
  await sevCell.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /Filter by this value/ })).toHaveCount(0);
});
