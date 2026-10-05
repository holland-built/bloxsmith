import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Every /api/ response is faked from tests/page-fixtures.ts.
//
// "IPAM SPACES — TOP USED" SAYS WHEN IT ONLY SAW PART OF THE LIST.
//
// The server makes one read of at most 500 IP spaces and the page ranks what
// comes back. Seen on a live tenant on 2026-10-04: exactly 500 rows came back,
// the panel said "top 12 of 496", and its busiest space showed 24 addresses
// while single subnets on the same page used 512. The server now says when its
// read came back full (`atLimit`), and the panel says it on screen.
//
// go/internal/dashboard/ipam_spaces_limit_test.go is the server's half. This is
// that the page says it, and says nothing when there is nothing to say.
test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

const spaces = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `ipam/ip_space/${i}`, label: `space-${i}`, pct: '', total: 1024, used: i }));

const panel = (page: import('@playwright/test').Page) => page.locator('[data-panel-id="network-ipam-spaces"]');

test('a read that came back full is named as the first 500, with a line saying why', async ({ page }) => {
  await page.route('**/api/csp/ipam-util', (route) =>
    route.fulfill({ json: { status: 'ok', count: 500, rows: spaces(500), atLimit: true, limit: 500 } }),
  );
  await page.goto('/#network');
  await expect(panel(page).getByText('space-499')).toBeVisible({ timeout: 20_000 });

  // Not "top 12 of 499", which would claim a ranking over every space.
  await expect(panel(page)).toContainText('top 12 of the first 500 read');
  await expect(panel(page)).not.toContainText(/top 12 of 4\d\d/);
  const note = panel(page).locator('[data-ipam-partial]');
  await expect(note).toBeVisible();
  await expect(note).toContainText('Only the first 500 spaces were read');
  await expect(note).toContainText('A busier space may be missing from this list.');
});

test('a short list is ranked as before, with no line under it', async ({ page }) => {
  // 31 spaces and no atLimit: the whole list was read, so "of 30" is true
  // (space-0 has used 0 of 1024 and still counts; all 31 report a total).
  await page.route('**/api/csp/ipam-util', (route) =>
    route.fulfill({ json: { status: 'ok', count: 31, rows: spaces(31) } }),
  );
  await page.goto('/#network');
  await expect(panel(page).getByText('space-30')).toBeVisible({ timeout: 20_000 });
  await expect(panel(page)).toContainText('top 12 of 31');
  await expect(panel(page)).not.toContainText('first');
  await expect(panel(page).locator('[data-ipam-partial]')).toHaveCount(0);
});
