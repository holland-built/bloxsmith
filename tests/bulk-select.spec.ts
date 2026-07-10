import { test, expect } from '@playwright/test';

// Bulk selection + the floating action bar. Two surfaces:
//  A) #network subnets table (has csvName -> Export CSV built-in).
//  B) #security triage table -> Ack flow (flash + undo toast + persisted acks).

const WRAP = 'div[tabindex="0"]:has(tr.clickable)'; // subnets wrapper (clickable rows)

// All three subnets are util>70 so they survive the table's default
// problemsOnly (util>70) filter — the "select all visible" assertion needs all
// three rendered (none at 100, so collapseIdentical never fires).
const DATA = {
  subnets: [
    { id: 's-a', name: 'Alpha Net', addr: '10.10.10.0', cidr: 24, util: 90, site: 'HQ' },
    { id: 's-b', name: 'Beta Net',  addr: '10.20.20.0', cidr: 24, util: 80, site: 'DR' },
    { id: 's-c', name: 'Gamma Net', addr: '10.30.30.0', cidr: 24, util: 72, site: 'BR' },
  ],
  leases: [], zones: [], hosts: [], auditLogs: [],
};

const SECURITY = {
  counts: { critical: 1, high: 1, medium: 1 }, blocked: 0, logged: 0, total: 3,
  events: [
    { severity: 'critical', qname: 'crit.example', policy_action: 'block', feed_name: 'f1', device: 'd1', event_time: '2026-07-09T10:00:00Z' },
    { severity: 'high',     qname: 'high.example', policy_action: 'log',   feed_name: 'f2', device: 'd2', event_time: '2026-07-09T09:00:00Z' },
    { severity: 'medium',   qname: 'med.example',  policy_action: 'log',   feed_name: 'f3', device: 'd3', event_time: '2026-07-09T08:00:00Z' },
  ],
};

test('selecting rows surfaces the action bar with Export CSV / Copy / Watchlist', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.goto('/#network');

  const rows = page.locator(`${WRAP} tbody tr`);
  await expect(rows.first()).toBeVisible();

  // Select one row via its select checkbox.
  await rows.first().locator('input[aria-label="Select row"]').check();

  const bar = page.locator('.action-bar');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('1 selected');
  await expect(bar.getByRole('button', { name: 'Export CSV' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Watchlist' })).toBeVisible();

  // Header checkbox selects all visible rows.
  await page.locator(`${WRAP} th.dt-check input`).check();
  await expect(bar).toContainText('3 selected');
});

test('acking selected triage events flashes rows, toasts undo, and persists', async ({ page }) => {
  await page.route('**/api/hub/security', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SECURITY) })
  );
  await page.goto('/#security');

  const rows = page.locator('table.dt tbody tr');
  await expect(rows.first()).toBeVisible();

  // Triage now ships "Hide acked" ON by default, which would drop acked rows out
  // of the visible set the instant they're acked (so the flash never renders).
  // Turn it OFF first so acked rows stay put and can flash.
  const hideAcked = page.locator('.prob-toggle').filter({ hasText: 'Hide acked' });
  await expect(hideAcked).toHaveAttribute('aria-pressed', 'true');
  await hideAcked.click();
  await expect(hideAcked).toHaveAttribute('aria-pressed', 'false');

  // Select the first two events via the row-SELECT checkbox (not the ack column).
  await rows.nth(0).locator('input[aria-label="Select row"]').check();
  await rows.nth(1).locator('input[aria-label="Select row"]').check();

  const bar = page.locator('.action-bar');
  await expect(bar).toContainText('2 selected');
  const ack = bar.getByRole('button', { name: /^Ack 2/ });
  await expect(ack).toBeVisible();
  await ack.click();

  // Acked rows flash (400ms tint).
  await expect(page.locator('tr.flash').first()).toBeVisible();

  // Undo toast.
  await expect(page.locator('.toast', { hasText: 'acked' })).toBeVisible();
  const undo = page.locator('.toast-action', { hasText: 'Undo' });
  await expect(undo).toBeVisible();

  // Two acks persisted to localStorage['bx.acks'].
  const acked = await page.evaluate(() => JSON.parse(localStorage.getItem('bx.acks') || '{}'));
  expect(Object.keys(acked).length).toBe(2);

  // Undo restores the prior (empty) ack state.
  await undo.click();
  const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('bx.acks') || '{}'));
  expect(Object.keys(restored).length).toBe(0);
});
