import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The Status pages (Overview, Daily, Best practices, Value) say only what is
// true, and say a failure once with what to do next. Findings A3-A15 and step
// 12 of the 2026-11-25 screen audit, one test each.

const down = (route: Route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down"}' });
const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const fact = (page: Page, label: string) => page.locator('.br-fact', { hasText: label });
const tile = (page: Page, name: string) => page.getByRole('region', { name: 'Services at a glance' }).getByRole('button', { name: new RegExp(`^${name} `) });
const SLOW = { timeout: 30_000 };

// Step 0: the four pages the test data did not answer now render working.
for (const [id, ready] of [
  ['best-practices', 'Grid Masters with no HA'],
  ['value', 'DNS lookups blocked'],
  ['lists', 'Site lists'],
  ['demo', 'Demo server'],
] as const) {
  test(`the test data answers every request "${id}" makes on load`, async ({ page }) => {
    const fx = await installBaselineWorld(page);
    await page.goto(`/#${id}`);
    await expect(page.getByRole('main').getByText(ready).first()).toBeVisible(SLOW);
    await page.waitForLoadState('networkidle');
    expect(fx.unmatched()).toEqual([]);
    await expect(page.getByRole('main').getByText(/unavailable|did not respond|could not load|failed to fetch/i)).toHaveCount(0);
  });
}

test('A3: the inventory banner says Bloxsmith retries, and offers Try again', async ({ page }) => {
  await installBaselineWorld(page);
  let dead = true;
  await page.route('**/api/data*', (r) => (dead ? down(r) : r.fallback()));
  await page.goto('/#overview');
  const banner = page.locator('.br-down');
  await expect(banner).toContainText('Bloxsmith tries again every 30 seconds', SLOW);
  dead = false;
  await banner.getByRole('button', { name: 'Try again' }).click(SLOW);
  await expect(banner).toHaveCount(0, SLOW);
});

test('A4: a subnet incident offers View subnets, and the tile counts say what they count', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  const item = page.locator('[data-problem="capacity/subnet"]');
  await expect(item.getByRole('link')).toHaveText('View subnets', SLOW);
  await expect(item.getByRole('link')).toHaveAttribute('href', '#network?minUtil=70&links=1');
  await expect(tile(page, 'IPAM')).toContainText('90% full or more');
  await expect(tile(page, 'IPAM')).not.toContainText('≥');
});

test('A6: a service with no fill draws no empty striped bar', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  const detail = page.getByRole('region', { name: 'DNS detail' });
  await expect(detail).toBeVisible(SLOW);
  await expect(detail.locator('.ov-ticks-none')).toHaveCount(0);
});

test('A14: with the feeds down, New issues says Not checked', async ({ page }) => {
  await installBaselineWorld(page);
  for (const p of ['**/api/data*', '**/api/incidents*', '**/api/hub/health*', '**/api/hub/security*', '**/api/lists/proposals*']) await page.route(p, down);
  await page.goto('/#overview');
  await expect(fact(page, 'New issues')).toContainText('Not checked', SLOW);
  await expect(fact(page, 'New issues')).not.toContainText('No dated issues');
});

test('A13: Hide is a button, the words are whole, and the squares say they are days', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  const hide = page.getByRole('button', { name: 'Hide' });
  await expect(hide).toHaveCSS('text-decoration-line', 'none', SLOW);
  await expect(page.locator('[data-board-row="DNS"]')).toContainText('No open issues');
  await expect(page.locator('[data-board]')).not.toContainText('None open');
  await expect(fact(page, 'Changes')).toContainText(/Changes, last \d+ hours?/);
  const head = page.locator('[data-board]').getByRole('columnheader', { name: 'Last 10 days' });
  expect((await head.boundingBox())!.width).toBeGreaterThan(40);
});

test('A11: a dead inventory feed gives Open issues one message with Try again, and no dash counts', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/data*', down);
  await page.route('**/api/hub/security*', down);
  await page.goto('/#daily');
  const panel = page.locator('[data-panel-id="daily-open-issues"]');
  await expect(panel.locator('[data-feed-unavailable]')).toBeVisible(SLOW);
  await expect(panel.getByRole('button', { name: 'Try again' })).toBeVisible(SLOW);
  await expect(panel.locator('[data-daily-tile]')).toHaveCount(0);
  await expect(page.getByText('— events')).toHaveCount(0);
  await expect(page.getByText(/— listed/)).toHaveCount(0);
});

test('A11: one dead slice keeps its own word on its tile', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/data*', (r) => json(r, {
    _meta: { subnets: 'ok', hosts: 'ok', zones: 'error' },
    _totals: { subnets: 1, hosts: 1 },
    subnets: [{ id: 's1', addr: '10.1.0.0', cidr: 24, util: 10, total: 254 }],
    hosts: [{ name: 'host-a', status: 'online' }],
    zones: [],
  }));
  await page.goto('/#daily');
  await expect(page.locator('[data-daily-tile="zones"]')).toContainText('unavailable', SLOW);
  await expect(page.locator('[data-daily-tile="hosts"]')).not.toContainText('unavailable');
});

// A5, after review: the panel lists no events, only totals. So the count by
// the title is the server's `counted` (the events those totals cover) or
// nothing, and there is no "Showing the newest" line about rows not shown.
test('A5: Security today counts only what its totals cover, and names no rows it does not list', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#daily');
  const panel = page.locator('[data-panel-id="daily-security-today"]');
  await expect(panel.getByText('Critical')).toBeVisible(SLOW);
  // The test data is an old payload with no `counted`: no count at all.
  await expect(panel).not.toContainText('events');
  await expect(panel.locator('[data-legend-note]')).toHaveCount(0);
  await expect(panel).not.toContainText('Showing the newest');
});

test('A5: with the server\'s counted, the title is that count', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/hub/security*', (r) => json(r, { availability: 'ok', blocked: 6, logged: 4, counted: 10, returned: 2, truncated: false, counts: { critical: 1, high: 2, medium: 3, low: 4 }, events: [] }));
  await page.goto('/#daily');
  const panel = page.locator('[data-panel-id="daily-security-today"]');
  await expect(panel).toContainText('10 events', SLOW);
  await expect(panel).not.toContainText('Showing the newest');
});

test('A8: Daily uses the shared Updated pill', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/data*', down);
  await page.goto('/#daily');
  const pill = page.locator('.ov-look .ov-pill[data-updated]');
  await expect(pill).toContainText('Information is unavailable', SLOW);
  await expect(page.getByText('Refresh failed')).toHaveCount(0);
});

test('A9: a failed Value read is said once per panel, and Print report has nothing to print', async ({ page }) => {
  await installBaselineWorld(page);
  for (const p of ['**/api/csp/value-security', '**/api/csp/value-platform', '**/api/csp/value-daily', '**/api/desk/runs']) await page.route(p, down);
  await page.goto('/#value');
  const grid = page.locator('[data-card-grid]');
  await expect(grid.locator('[data-stat="queries"]')).toContainText('Not checked', SLOW);
  await expect(grid.getByText(/Could not load (security results|platform performance)\./)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Print report' })).toBeDisabled();
});

// Review of A9: the one failure sentence carries the same Try again as an
// unavailable panel, and a failed daily read is said once, not twice.
test('A9: each Value failure sentence has Try again, and it reads again', async ({ page }) => {
  await installBaselineWorld(page);
  let dead = true;
  for (const p of ['**/api/csp/value-security', '**/api/csp/value-platform', '**/api/csp/value-daily']) await page.route(p, (r) => (dead ? down(r) : r.fallback()));
  await page.goto('/#value');
  const grid = page.locator('[data-card-grid]');
  await expect(grid.getByText(/Could not load (security results|platform performance)\./)).toHaveCount(2, SLOW);
  await expect(grid.getByText('Daily figures could not be read')).toHaveCount(0);
  const retry = page.locator('[data-panel-id="value-security"]').getByRole('button', { name: 'Try again' });
  await expect(page.locator('[data-panel-id="value-platform"]').getByRole('button', { name: 'Try again' })).toBeVisible();
  dead = false;
  await retry.click();
  await expect(page.locator('[data-panel-id="value-security"]').getByText(/Could not load security results\./)).toHaveCount(0, SLOW);
  await expect(grid.locator('[data-stat="blocked"]')).not.toContainText('Not checked');
});

// Review of A9: the server answers 200 with an error status inside when
// Infoblox fails (go/internal/dashboard/value_security.go). Every figure then
// reads Not checked, so there is still nothing to print.
test('A9: Print report is greyed when every figure failed inside a 200 reply', async ({ page }) => {
  await installBaselineWorld(page);
  const failed = (keys: string[]) => ({ status: 'error', metrics: Object.fromEntries(keys.map((k) => [k, { status: 'error', value: null }])) });
  await page.route('**/api/csp/value-security', (r) => json(r, failed(['blocked', 'zero_day', 'sus_to_mal'])));
  await page.route('**/api/csp/value-platform', (r) => json(r, failed(['queries', 'cache_hit', 'uptime', 'dhcp_assigned', 'roaming'])));
  await page.route('**/api/csp/value-daily', (r) => json(r, { status: 'error' }));
  await page.route('**/api/desk/runs', down);
  await page.goto('/#value');
  await expect(page.locator('[data-card-grid] [data-stat="queries"]')).toContainText('Not checked', SLOW);
  await expect(page.getByRole('button', { name: 'Print report' })).toBeDisabled();
});

test('A10: Best practices says it only reads in its intro, with no do-nothing chip', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#best-practices');
  await expect(page.getByRole('main')).toContainText('This page only reads; it changes nothing', SLOW);
  await expect(page.getByText('Read only', { exact: true })).toHaveCount(0);
});

test('step 12: Passed shows no tick until the checks have answered', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/best-practices', down);
  await page.goto('/#best-practices');
  const passed = page.locator('[data-tile="passed"]');
  await expect(passed).toContainText('Not checked', SLOW);
  await expect(passed.locator('.bp-ring')).not.toHaveClass(/\bok\b/);
  await expect(passed.locator('.bp-ring')).not.toHaveText('✓');
});

test('A15: Daily and Overview titles are in sentence case, in plain words', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#daily');
  for (const t of ['Open issues', 'Security today', 'Top capacity risks', 'Hosts needing attention', 'DNS zone issues']) {
    await expect(page.getByRole('heading', { name: t, exact: true })).toBeVisible(SLOW);
  }
  await expect(page.locator('[data-panel-id="daily-top-capacity-risks"]').getByRole('columnheader', { name: 'Used %' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open hosts' })).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText('low ttl');
  await page.goto('/#overview');
  for (const t of ['License inventory', 'DNS query rate — 24 hours']) {
    await expect(page.getByRole('heading', { name: t, exact: true })).toBeVisible(SLOW);
  }
});
