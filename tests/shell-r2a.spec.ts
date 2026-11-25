import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { installBaselineWorld, openTask } from './page-fixtures';

// GUI audit round 2, shared frame parts: R2-A3 (Arrange panels looked like a
// caption), R2-E3 (a long page name squeezed the phone bar's icons), E9 (the
// header's "Some data didn't load" named nothing and showed on pages with no
// failed panel), and the A7/D8 note ("Changes allowed" in the warning colour).

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const inventory = (meta: Record<string, string>) => ({
  subnets: [], leases: [], hosts: [], zones: [], dnsViews: [], secPolicies: [], feeds: [], auditLogs: [],
  _totals: { degraded: true },
  _meta: { subnets: 'ok', leases: 'ok', dnsViews: 'ok', zones: 'ok', hosts: 'ok', secPolicies: 'ok', feeds: 'ok', auditLogs: 'ok', ...meta },
});

// A colour token as the browser resolves it, for comparing against.
const tokenColour = (page: Page, cls: string) => page.evaluate((c) => {
  const s = document.createElement('span');
  s.className = c;
  document.body.append(s);
  const v = getComputedStyle(s).color;
  s.remove();
  return v;
}, cls);

test('Arrange panels has a button\'s border and fill', async ({ page }) => {
  await installBaselineWorld(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#daily');
  const btn = page.locator('[data-layout-arrange]').first();
  await expect(btn).toBeVisible({ timeout: 20_000 });
  const s = await btn.evaluate((el) => ({ border: getComputedStyle(el).borderTopColor, bg: getComputedStyle(el).backgroundColor }));
  expect(s.border, 'no visible border').not.toBe('rgba(0, 0, 0, 0)');
  expect(s.bg, 'no fill').not.toBe('rgba(0, 0, 0, 0)');
});

test.describe('phone bar', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  for (const id of ['made', 'lists', 'demo']) {
    test(`on ${id}, a long page name leaves every other icon 44px wide`, async ({ page }) => {
      await installBaselineWorld(page);
      await page.goto(`/#${id}`);
      const items = page.locator('.frame-dock-item:not([aria-current="page"])');
      await expect(items.first()).toBeVisible({ timeout: 20_000 });
      const widths = await items.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
      expect(Math.min(...widths), `icon widths ${widths}`).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    });
  }
});

test('the header names what did not load', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/data*', (r) => json(r, inventory({ hosts: 'error' })));
  await page.goto('/#overview');
  const state = page.locator('header [data-state]');
  await expect(state).toHaveText("Hosts didn't load", { timeout: 20_000 });
});

test('the header does not warn on a page that shows none of what failed', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/data*', (r) => json(r, inventory({ hosts: 'error', subnets: 'error', leases: 'error' })));
  await page.goto('/#ai');
  await expect(page.locator('header .frame-conn')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await expect(page.locator('header [data-state]')).toHaveCount(0);
});

test('"Changes allowed" is not in the warning colour', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  const write = page.locator('header [data-write]');
  await expect(write).toHaveText('Changes allowed', { timeout: 20_000 });
  const colour = await write.evaluate((el) => getComputedStyle(el).color);
  expect(colour).not.toBe(await tokenColour(page, 'text-warn'));
});

// R2-E12. In light theme a box that cannot be used only had dimmer words, which
// is close to the body colour there, so it looked live. It now has its own fill.
test('in light theme a box that cannot be used has a different fill', async ({ page }) => {
  await installBaselineWorld(page);
  await page.addInitScript(() => localStorage.setItem('theme', 'light'));
  await page.goto('/#selfservice');
  const card = await openTask(page, 'address');
  // By state, not by name: another helper is renaming these boxes.
  const off = card.locator('select:disabled').first();
  const on = card.locator('select:enabled').first();
  await expect(off).toBeVisible();
  const bg = (l: typeof off) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg(off)).not.toBe(await bg(on));
});

// Codex review of r2a. With subnets loaded and hosts failed, the header turned
// green and named nothing, because any loaded list counted as "has data".
test('at 390 a partial failure still names what failed', async ({ page }) => {
  await installBaselineWorld(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/data*', (r) => json(r, {
    ...inventory({ hosts: 'error' }),
    subnets: [{ id: 'ipam/subnet/1', address: '10.0.0.0', cidr: 24, name: 'one', utilization: 10 }],
    _totals: { degraded: false },
  }));
  await page.goto('/#overview');
  await expect(page.locator('header [data-state]')).toHaveText("Hosts didn't load", { timeout: 20_000 });
});
