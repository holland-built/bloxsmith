import { test, expect } from '@playwright/test';

// Copy-link (F3): a "Copy link to this view" palette action copies the
// canonical URL of the CURRENT view — section + whatever deep-link params are
// already in location.hash (see parseHash/nav, index.html ~1734) — to the
// clipboard, and announces it via the same toast/aria-live bus F1 (copy-cell)
// and F2 (palette actions) already use. No new hash serialization here: the
// hash is already the source of truth and location.href already reflects it.

test.use({ baseURL: process.env.NOC_BASE || 'http://localhost:8091' });

const DATA = {
  subnets: [
    { id: 's-a', name: 'Alpha Net', addr: '10.10.10.0', cidr: 24, util: 90, site: 'HQ' },
  ],
  leases: [], zones: [], hosts: [], auditLogs: [],
};

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

test('palette "Copy link to this view" copies the current URL and announces it', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.goto('/#overview');
  await expect(page).toHaveURL(/#overview/);

  await page.keyboard.press('Meta+k');
  const input = page.locator('.palette-in');
  await expect(input).toBeVisible();
  await input.fill('copy link');

  const item = page.locator('.pal-row', { hasText: 'Copy link to this view' });
  await expect(item).toBeVisible();
  await item.click();

  const url = page.url();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(url);

  const live = page.locator('.toasts[aria-live="polite"]');
  await expect(live).toContainText('Link copied');

  // Palette closes after running the action, same as every other palette action.
  await expect(page.locator('.palette-in')).toHaveCount(0);
});

test('copies deep-link params encoded in the hash, not just the bare tab', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  // A pivot filter (?f=...) is already in the hash before the action runs.
  await page.goto('/#network?f=site%3AHQ');
  const rows = page.locator('table.dt tbody tr');
  await expect(rows.first()).toBeVisible();

  await page.keyboard.press('Meta+k');
  const input = page.locator('.palette-in');
  await input.fill('copy link');
  await page.locator('.pal-row', { hasText: 'Copy link to this view' }).click();

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('#network');
  expect(clip).toContain('f=site');
  expect(clip).toBe(page.url());
});
