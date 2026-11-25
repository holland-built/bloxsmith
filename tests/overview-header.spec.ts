import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The top of Overview as the owner picked it on 2026-11-25
// (mockups/overview-header.html, picks 3 2 2): one slim header row, no big
// "Start with" button, the verdict as the heading of the attention list, the
// old DNS rate in brackets, and Changes counted over the whole 24 hours.

const fact = (page: Page, label: string) => page.locator('.br-fact', { hasText: label });

for (const [width, height] of [[1440, 900], [390, 844]]) {
  test(`the header is one slim row and the list carries the verdict at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await installBaselineWorld(page);
    await page.goto('/#overview');
    const heading = page.locator('#br-look');
    await expect(heading).toContainText('items across', { timeout: 20_000 });

    // One row: the page name, the date and Updated share one line of text.
    const rail = page.locator('.br-rail');
    const h1 = await rail.getByRole('heading', { level: 1, name: 'Overview' }).boundingBox();
    const date = await rail.locator('.br-date').boundingBox();
    const upd = await rail.locator('.br-updated').boundingBox();
    const railBox = await rail.boundingBox();
    if (width > 600) {
      for (const b of [date!, upd!]) expect(Math.abs(b.y + b.height / 2 - (h1!.y + h1!.height / 2))).toBeLessThanOrEqual(8);
      expect(railBox!.height).toBeLessThanOrEqual(40);
    } else {
      // A phone may wrap Updated under the name, in the same order.
      expect(date!.x).toBeGreaterThan(h1!.x);
      expect(upd!.y).toBeGreaterThanOrEqual(h1!.y);
      expect(railBox!.height).toBeLessThanOrEqual(64);
    }

    await expect(page.getByRole('link', { name: /^Start with/ })).toHaveCount(0);
    await expect(page.getByText(/^Start with/)).toHaveCount(0);
    await expect(heading).toContainText('Needs action');
    await expect(heading.locator('[data-verdict]')).toHaveText('Needs action');
    await expect(page.getByRole('region', { name: /^Needs action \d+ items? across \d+ of \d+ services$/ })).toBeVisible();

    await expect(fact(page, 'DNS traffic')).toContainText('(was ');
    const changes = fact(page, 'Changes');
    await expect(changes.locator('.br-label')).toHaveText('Changes');
    await expect(changes).not.toContainText('minutes only');
    await expect(changes).toContainText('3,412 in the last 24 hours, 41 of them by users');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
