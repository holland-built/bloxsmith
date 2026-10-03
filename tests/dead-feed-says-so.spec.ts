import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// A dead feed must never read as "you have none". ui.jsx's FeedUnavailable is
// how the app says a feed is down: a named, red, announced block with a way to
// try again. Seven places were still saying it as a quiet grey line in the
// empty-state style ("no data", "failed to load actions", "search failed",
// "feed unavailable" in lower case), which is the look of a panel with nothing
// in it. Each of these tests fails on the commit before 2026-10-03's fix.

const dead = (route: Route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"upstream down"}' });

// The block FeedUnavailable draws, by the attribute it carries for exactly
// this purpose (see tests/contrast.spec.ts).
const unavailable = (page: Page, panelId: string) => page.locator(`[data-panel-id="${panelId}"] [data-feed-unavailable]`);

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

test('DNS: a dead query-volume feed says so, and does not say "no data"', async ({ page }) => {
  await page.route('**/api/dns-analytics*', dead);
  await page.goto('/#dns');
  const block = unavailable(page, 'dns-query-volume-7d');
  await expect(block).toBeVisible({ timeout: 20_000 });
  await expect(block).toContainText('DNS query volume feed unavailable');
  await expect(page.locator('[data-panel-id="dns-query-volume-7d"]').getByText('no data', { exact: true })).toHaveCount(0);
});

test('Incidents: a dead incidents feed says so in the triage panel', async ({ page }) => {
  await page.route('**/api/incidents*', dead);
  await page.goto('/#incidents');
  const block = unavailable(page, 'incidents-triage');
  await expect(block).toBeVisible({ timeout: 20_000 });
  await expect(block).toContainText('Incidents feed unavailable');
  await expect(page.getByText('failed to load incidents')).toHaveCount(0);
});

test('Incidents: a dead actions feed says so in both panels that read it', async ({ page }) => {
  await page.route('**/api/actions*', dead);
  await page.goto('/#incidents');
  for (const id of ['incidents-soc-queue', 'incidents-action-volume']) {
    const block = unavailable(page, id);
    await expect(block, `${id} did not draw the feed-unavailable block`).toBeVisible({ timeout: 20_000 });
    await expect(block).toContainText('IQ Actions feed unavailable');
  }
  await expect(page.getByText('failed to load actions')).toHaveCount(0);
});

test('Audit: a portal search that fails outright says the feed is unavailable', async ({ page }) => {
  await page.route('**/api/csp-audit*', dead);
  await page.goto('/#audit');
  const block = unavailable(page, 'audit-csp-portal');
  await expect(block).toBeVisible({ timeout: 20_000 });
  await expect(block).toContainText('CSP audit feed unavailable');
  await expect(page.getByText('search failed', { exact: true })).toHaveCount(0);
});

test('Infra: a dead host-health feed draws the block, not a grey line', async ({ page }) => {
  await page.route('**/api/csp/host-health*', dead);
  await page.goto('/#infra');
  const block = unavailable(page, 'infra-host-health');
  await expect(block).toBeVisible({ timeout: 20_000 });
  await expect(block).toContainText('Feed unavailable');
});

test('Audit: Try again re-runs the portal search, which is not one of the page-wide feeds', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/csp-audit*', (route) => {
    calls += 1;
    // The first search fails; the retry reaches the baseline world's answer.
    return calls === 1 ? dead(route) : route.fallback();
  });
  await page.goto('/#audit');
  const block = unavailable(page, 'audit-csp-portal');
  await expect(block).toBeVisible({ timeout: 20_000 });
  await block.getByRole('button', { name: 'Try again' }).click();
  await expect(block).toHaveCount(0);
  await expect(page.locator('[data-panel-id="audit-csp-portal"] tbody tr').first()).toBeVisible();
  expect(calls).toBe(2);
});
