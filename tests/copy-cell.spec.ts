import { test, expect } from '@playwright/test';

// Copy-cell / copy-row. Uses the #security triage table (SecTriageInbox) because
// its rows are NOT onRowClick-clickable (no drill-down/peek nav claims the click),
// so a plain cell click is free to mean "copy" without fighting existing row-click
// navigation elsewhere in the app (subnets/infra rows keep click-to-open; those get
// the row-JSON copy button + the 'y' keyboard shortcut instead — see index.html).

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

test('clicking a data cell copies its raw value and announces via the aria-live toast', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');

  const rows = page.locator('table.dt tbody tr');
  await expect(rows.first()).toBeVisible();

  // qname column, critical sorts first -> "crit.example".
  const cell = rows.first().locator('td', { hasText: 'crit.example' });
  await cell.click();

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe('crit.example');

  // Scope to the toast bus specifically — SynthBand also carries aria-live="polite".
  const live = page.locator('.toasts[aria-live="polite"]');
  await expect(live).toContainText('Copied');
});

test('the row-copy affordance copies the whole row as JSON', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');

  const rows = page.locator('table.dt tbody tr');
  await expect(rows.first()).toBeVisible();
  const row = rows.first();
  await row.hover();

  const copyBtn = row.getByRole('button', { name: 'Copy row as JSON' });
  await copyBtn.click();

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const parsed = JSON.parse(clip);
  expect(parsed.qname).toBe('crit.example');
  expect(parsed.severity).toBe('critical');

  const live = page.locator('.toasts[aria-live="polite"]');
  await expect(live).toContainText('Row copied');
});

test('keyboard: cursor + "y" copies the cursor row as JSON', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');

  await expect(page.locator('#triage-r-0')).toBeVisible();
  const wrap = page.locator('div[tabindex="0"]:has(#triage-r-0)');
  await wrap.focus();

  await page.keyboard.press('j'); // cursor -> row 0 (crit.example)
  await page.keyboard.press('y'); // copy cursor row as JSON

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const parsed = JSON.parse(clip);
  expect(parsed.qname).toBe('crit.example');
});
