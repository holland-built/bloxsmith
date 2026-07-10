import { test, expect } from '@playwright/test';

// SECURITY AiExplain modal. Selecting triage rows surfaces an "Explain N" bulk
// action that POSTs the rows to /api/query (mocked) and shows the answer in a
// modal (.palette-scrim / role=dialog aria-label="AI analysis"). Escape closes it.

const SECURITY = {
  counts: { critical: 1, high: 1 }, blocked: 0, logged: 2, total: 2,
  events: [
    { severity: 'critical', qname: 'crit.example', policy_action: 'block', feed_name: 'f1', device: 'd1', event_time: '2026-07-09T10:00:00Z' },
    { severity: 'high',     qname: 'high.example', policy_action: 'log',   feed_name: 'f2', device: 'd2', event_time: '2026-07-09T09:00:00Z' },
  ],
};

test('Explain bulk action opens the AI modal with the answer; Escape closes it', async ({ page }) => {
  await page.route('**/api/hub/security', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SECURITY) }));
  await page.route('**/api/query', route =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ answer: 'Correlated summary: two related events.', suggestions: [], trace: [] }),
    }));

  await page.goto('/#security');

  const rows = page.locator('table.dt tbody tr');
  await expect(rows.first()).toBeVisible();
  await rows.nth(0).locator('input[aria-label="Select row"]').check();
  await rows.nth(1).locator('input[aria-label="Select row"]').check();

  const bar = page.locator('.action-bar');
  await expect(bar).toContainText('2 selected');
  await bar.getByRole('button', { name: /^Explain 2/ }).click();

  const modal = page.getByRole('dialog', { name: 'AI analysis' });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('Correlated summary');

  await page.keyboard.press('Escape');
  await expect(page.locator('.palette-scrim')).toHaveCount(0);
});
