import { test, expect } from '@playwright/test';
import { installBaselineWorld } from './page-fixtures';

// Fix 2 (2026-11-24), "one problem, one severity, on every page". Each test
// here failed on the code before it.

test.beforeEach(async ({ page }) => { await installBaselineWorld(page); });

test('zones with issues get the same word and colour on Daily and DNS', async ({ page }) => {
  await page.goto('/#daily');
  const daily = page.locator('[data-daily-tile="zones"] .dy-verdict');
  await expect(daily).toHaveText('Review');
  await expect(daily).toHaveClass(/\bwarn\b/);
  await page.goto('/#dns');
  const dns = page.locator('[data-tile="zones"] .ov-verdict');
  await expect(dns).toHaveText('Review');
  await expect(dns).toHaveClass(/\bwarn\b/);
});

test('a subnet 90% full or more is red on Daily, as on Network', async ({ page }) => {
  await page.goto('/#daily');
  const daily = page.locator('[data-daily-tile="subnets"] .dy-verdict');
  await expect(daily).toHaveText('Needs action');
  await expect(daily).toHaveClass(/\bcrit\b/);
  await page.goto('/#network');
  await expect(page.locator('.kpi-tile[data-tone="crit"]')).toHaveCount(1);
});

test('Changes says the red word for its red tiles', async ({ page }) => {
  await page.goto('/#changes');
  const v = page.locator('[data-changes-cell="deletions"] .ov-verdict');
  await expect(v).toHaveText('Needs action');
  await expect(v).toHaveClass(/\bcrit\b/);
});

test('a host whose status is ok is online: not on Daily\'s list, not Other on Infra', async ({ page }) => {
  await page.goto('/#daily');
  const card = page.locator('[data-panel-id="daily-hosts-attention"]');
  await expect(card).toContainText('baseline-host-c');
  await expect(card).not.toContainText('baseline-host-a');
  await expect(card).toContainText('2 listed');
  await page.goto('/#infra?status=not-online');
  await expect(page.getByText('baseline-host-c').first()).toBeVisible();
  await expect(page.getByText('baseline-host-a')).toHaveCount(0);
});

test('the category chips match the rows Triage lists', async ({ page }) => {
  await page.goto('/#incidents');
  const chips = page.locator('[data-panel-id="incidents-categories"] .inc-chip');
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toContainText('1');
  await expect(chips.nth(0)).toContainText('1 critical');
  await expect(chips.nth(1)).toContainText('1 medium');
});

test('Threat Events by hour says its bars come from fewer rows than its legend counts', async ({ page }) => {
  await page.goto('/#security');
  const card = page.locator('[data-panel-id="security-threat-events"]');
  await expect(card).toContainText('Showing the newest 2 of 10 events.');
  // Daily lists no events, only totals, so it has no rows to say this about
  // (review of screen audit A5, 2026-11-25).
  await page.goto('/#daily');
  await expect(page.locator('[data-panel-id="daily-security-today"]').getByText('Critical')).toBeVisible();
  await expect(page.locator('[data-panel-id="daily-security-today"] [data-legend-note]')).toHaveCount(0);
});

test('a subnet is labelled with the count Infoblox reports, which Used plus Free add up to', async ({ page }) => {
  await page.goto('/#network');
  // The fixture reports 254 for this /24; a live tenant reports 256. Either way
  // the label is the server's count, never one worked out from the prefix.
  await expect(page.getByText('10.30.0.0/24 (254 addresses)')).toBeVisible();
  await expect(page.getByText('(256 addresses)')).toHaveCount(0);
});
