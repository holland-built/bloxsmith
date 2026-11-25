import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Overview never says all is fine when it could not check, and its parts never
// disagree about the same thing (owner's fix 1, 2026-11-24).

const down = (route: Route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down"}' });
const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const row = (page: Page, name: string) => page.locator(`[data-board] [data-board-row="${name}"]`);
const tile = (page: Page, name: string) => page.getByRole('region', { name: 'Services at a glance' }).getByRole('button', { name: new RegExp(`^${name} `) });

test('with every feed down, the attention list says nothing could be checked', async ({ page }) => {
  await installBaselineWorld(page);
  for (const p of ['**/api/data*', '**/api/hub/**', '**/api/incidents*', '**/api/csp/**', '**/api/lists/**']) await page.route(p, down);
  await page.goto('/#overview');
  await expect(page.locator('[data-empty-list]')).toHaveText('No services could be checked, so issues may be missing from this list.', { timeout: 20_000 });
});

test('the DNS tile names the same comparison window as the chart and the briefing', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  await expect(tile(page, 'DNS')).toContainText('vs 2h ago', { timeout: 20_000 });
  await expect(tile(page, 'DNS')).not.toContainText('24h');
  await expect(page.locator('[data-panel-id="dns-hero"]')).toContainText('vs 2h ago');
});

test('an incident about subnets sits on the IPAM row, not Other', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  await expect(row(page, 'IPAM')).toContainText('subnets close to full', { timeout: 20_000 });
  await expect(row(page, 'IPAM')).not.toContainText('No open issues');
  await expect(row(page, 'Other')).toHaveCount(0);
});

test('subnets 90% full with no incident yet are on the list and the IPAM row, matching the tile', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/incidents*', (r) => json(r, { incidents: [], signals: [] }));
  await page.goto('/#overview');
  await expect(tile(page, 'IPAM').locator('.ov-verdict')).toHaveText('Review', { timeout: 20_000 });
  await expect(page.locator('[data-problem="subnet-full"]')).toContainText('1 subnet is 90% full or more');
  await expect(row(page, 'IPAM')).toContainText('1 subnet is 90% full or more');
  await expect(row(page, 'IPAM')).not.toContainText('No open issues');
});

test('the panel of recent changes is named for what it covers', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');
  await expect(page.getByRole('heading', { name: 'Recent changes', level: 2 })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Since yesterday' })).toHaveCount(0);
});

test('light theme: the DNS chart change is readable, 4.5:1 or better', async ({ page }) => {
  await page.addInitScript(`localStorage.setItem('theme', 'light')`);
  await installBaselineWorld(page);
  await page.goto('/#overview');
  const delta = page.locator('[data-panel-id="dns-hero"]').getByText(/vs \dh ago/);
  await expect(delta).toBeVisible({ timeout: 20_000 });
  const ratio = await delta.evaluate((el) => {
    const rgb = (s: string) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    let bgEl: Element | null = el;
    let bg = 'rgba(0, 0, 0, 0)';
    while (bgEl && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { bg = getComputedStyle(bgEl).backgroundColor; bgEl = bgEl.parentElement; }
    const a = lum(rgb(getComputedStyle(el).color));
    const b = lum(rgb(bg));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});
