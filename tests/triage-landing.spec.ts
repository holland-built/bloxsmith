import { test, expect } from '@playwright/test';

// Mocks /api/hub/security (SecTriageInbox). Events sort unacked-first, then by
// severity rank (critical < high < medium < low), then event_time desc.
// Ack state persists to localStorage key 'bx.acks' (key = event_time|qname).

const CRIT_QNAME = 'evil-critical.example';

const SECURITY = {
  counts: { critical: 1, high: 2, medium: 0, low: 1 },
  blocked: 2, logged: 2, total: 4,
  events: [
    { severity: 'high', qname: 'high-one.example', policy_action: 'log', feed_name: 'f1', device: 'dev-h1', event_time: '2026-07-09T09:00:00Z' },
    { severity: 'low', qname: 'low-one.example', policy_action: 'log', feed_name: 'f2', device: 'dev-l1', event_time: '2026-07-09T08:00:00Z' },
    { severity: 'critical', qname: CRIT_QNAME, policy_action: 'block', feed_name: 'f3', device: 'dev-c1', event_time: '2026-07-09T10:00:00Z' },
    { severity: 'high', qname: 'high-two.example', policy_action: 'block', feed_name: 'f4', device: 'dev-h2', event_time: '2026-07-09T07:00:00Z' },
  ],
};

test('critical event sorts first, ack persists across reload', async ({ page }) => {
  await page.route('**/api/hub/security', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SECURITY) })
  );
  // Fresh Playwright context starts with empty localStorage, so acks begin clean.
  // (Do NOT use addInitScript to clear acks — it re-runs on reload and would wipe
  // the very ack this test asserts persists.)

  await page.goto('/#security');

  const rows = page.locator('table.dt tbody tr');
  await expect(rows.first()).toBeVisible();

  // Critical is first (severity cell rendered uppercase).
  await expect(rows.first()).toContainText('critical');
  await expect(rows.first()).toContainText(CRIT_QNAME);

  // Ack the critical event via its ack checkbox. The triage table is now also
  // selectable (adds a leading "Select row" checkbox), so target the ack box by
  // its aria-label rather than the ambiguous input[type="checkbox"].
  const critRow = rows.filter({ hasText: CRIT_QNAME });
  const critBox = critRow.locator('input[aria-label="Acknowledge event"]');
  await critBox.check();
  await expect(critBox).toBeChecked();
  // The rebuilt generic DataTable no longer dims acked rows (opacity 0.45 was
  // dropped); ack now registers via the checked box + the row sinking below all
  // still-unacked events. Assert that sink: the (formerly first) critical event
  // is no longer the top row.
  await expect(rows.first()).not.toContainText(CRIT_QNAME);
  await expect(critRow.locator('input[aria-label="Acknowledge event"]')).toBeChecked();

  // Reload with the same mock -> ack restored from localStorage.
  await page.reload();
  const critRowAfter = page.locator('table.dt tbody tr').filter({ hasText: CRIT_QNAME });
  await expect(critRowAfter.locator('input[aria-label="Acknowledge event"]')).toBeChecked();
});
