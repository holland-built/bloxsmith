import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Two findings from the 2026-11-10 review of Incidents.
//
// 1. The severity counts sat below the whole Triage table (1,804 rows live),
//    so the page's answer was the last thing on it. They now lead the page,
//    and a tile picks the severity Triage shows.
// 2. Every IQ Actions row said "Reopen", because every action on the tenant
//    was resolved and the row showed only the button. An action is either
//    active or resolved (the only two values /api/actions/{id}/status takes),
//    so each row now says which, open ones first, with the action that fits.

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

test('the severity tiles sit above Triage, and a tile filters it', async ({ page }) => {
  await page.goto('/#incidents');
  const tiles = page.locator('[data-panel-id="incidents-severity"]');
  const triage = page.locator('[data-panel-id="incidents-triage"]');
  await expect(triage.getByRole('row')).toHaveCount(3);
  const [t, r] = await Promise.all([tiles.boundingBox(), triage.boundingBox()]);
  expect(t!.y).toBeLessThan(r!.y);

  const critical = tiles.getByRole('button', { name: /^Critical 1 of 2/ });
  await critical.click();
  await expect(critical).toHaveAttribute('aria-pressed', 'true');
  await expect(triage.getByRole('row')).toHaveCount(2);
  await expect(triage).toContainText('baseline-net-c is 98% used');
  await expect(triage).not.toContainText('other.example is unsigned');
  await triage.getByRole('button', { name: 'Clear filter' }).click();
  await expect(triage.getByRole('row')).toHaveCount(3);
});

const action = (id: string, status: string, priority: string) => ({
  id, status, priority, title: `Action ${id}`, type: 'investigation', last_activity: '2025-12-31T10:00:00Z',
});

test('each IQ action says its state, open ones first, with the action that fits', async ({ page }) => {
  await page.route(/\/api\/actions(\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true, availability: 'ok', actions_truncated: false,
        actions: [action('a1', 'resolved', 'high'), action('a2', 'resolved', 'low'), action('a3', 'active', 'low'), action('a4', 'resolved', 'medium')],
      }),
    }),
  );
  await page.goto('/#incidents');
  const queue = page.locator('[data-panel-id="incidents-soc-queue"]');
  const rows = queue.getByRole('row');
  await expect(rows).toHaveCount(5);
  // The one open action leads, and it is the only row offering Resolve.
  await expect(rows.nth(1)).toContainText('Action a3');
  await expect(rows.nth(1)).toContainText('Open');
  await expect(queue.getByRole('button', { name: 'Resolve' })).toHaveCount(1);
  for (const i of [2, 3, 4]) await expect(rows.nth(i)).toContainText('Resolved');
  // Open and resolved add up to the rows the queue holds.
  await expect(queue).toContainText('1 open · 3 resolved');
});
