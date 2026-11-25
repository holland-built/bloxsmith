import { test, expect } from './fixtures';
import { installFixtures, FIXED_NOW } from './page-fixtures';

// Security leads with headline numbers, and Block is a quiet action at the end
// of the Triage Inbox row instead of a column of boxed buttons (review of
// 2026-11-10: "15 panels, no headline numbers; the eye lands on a stack of
// Block buttons"). The fixture's /api/hub/security counts 1 critical and 2 high;
// /api/lookalikes has 1 suspicious of 1; /api/axur has 9 credentials.

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await installFixtures(page, 'security');
  await page.request.delete('/api/views/__layout_security').catch(() => {});
});

test('the headline answers "am I under attack" from the feeds the page loads', async ({ page }) => {
  await page.goto('/#security');
  const head = page.getByRole('region', { name: 'Headline numbers' });
  await expect(head).toBeVisible();
  const tile = (key: string) => head.locator(`[data-key="${key}"]`);
  await expect(tile('attacks')).toContainText('Critical or high');
  await expect(tile('attacks').locator('.sec-num')).toHaveText('3 events');
  await expect(tile('attacks')).toHaveAttribute('data-tone', 'crit');
  await expect(tile('blocked').locator('.sec-num')).toHaveText('12 events');
  await expect(tile('blocked')).not.toHaveAttribute('data-tone', /.+/);
  await expect(tile('lookalikes').locator('.sec-num')).toHaveText('1');
  await expect(tile('credentials').locator('.sec-num')).toHaveText('9 exposed');

  // A tile is a jump to the panel its number came from.
  await tile('lookalikes').click();
  await expect(page.locator('[data-panel-id="security-lookalike-domains"]')).toBeFocused();
});

test('Block is the last column, absent on a row already blocked, and shows at rest on every row it can act on', async ({ page }) => {
  await page.goto('/#security');
  const inbox = page.locator('[data-panel-id="security-triage-inbox"]');
  await expect(inbox.locator('thead th').last()).toHaveText('Block');
  // The high row's lookup was already blocked by policy (GUI audit R2-C1).
  const high = inbox.locator('tbody tr', { hasText: 'bad.baseline.example' });
  const medium = inbox.locator('tbody tr', { hasText: 'watch.baseline.example' }).getByRole('button', { name: 'Block' });
  await page.mouse.move(0, 0);
  await expect(high.getByRole('button', { name: 'Block' })).toHaveCount(0);
  await expect(high.locator('td').last()).toHaveText('Blocked');
  // Shown without hovering: hidden at rest, the only row that could be blocked
  // showed an empty cell (GUI audit R2-C1, round 3).
  await expect(medium).toHaveCSS('opacity', '1');
  await inbox.locator('tbody tr', { hasText: 'watch.baseline.example' }).hover();
  await expect(medium).toHaveCSS('opacity', '1');
});

test('a feed that answers without its counts shows Unknown, not 0', async ({ page }) => {
  // Registered after the fixtures, so these win for the two routes.
  const json = (body: unknown) => (route: import('@playwright/test').Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/hub/security*', json({ availability: 'ok', events: [] }));
  await page.route('**/api/axur*', json({ configured: true, vendors: [] }));
  await page.goto('/#security');
  const head = page.getByRole('region', { name: 'Headline numbers' });
  for (const key of ['attacks', 'blocked', 'credentials']) {
    await expect(head.locator(`[data-key="${key}"] .sec-num`)).toHaveText('Unknown');
  }
  await expect(head.locator('[data-key="attacks"]')).not.toHaveAttribute('data-tone', /.+/);
});

test('an empty exposures answer reads None reported on the tile, matching the panel', async ({ page }) => {
  // The fixture's /api/csp/exposures is ok with data: {}.
  await page.goto('/#security');
  await expect(page.locator('[data-panel-id="security-exposures"]')).toContainText('No exposures found');
  const num = page.getByRole('region', { name: 'Headline numbers' }).locator('[data-key="exposures"] .sec-num');
  await expect(num).toHaveText('None reported');
  await expect(num).toHaveClass(/sec-none/);
});
