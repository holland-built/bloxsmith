import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The box (bar charts) or line (area charts) recharts draws behind the hovered
// point. Its default is a fixed light grey, #ccc, which on the dark theme is a
// bright slab behind the bar the owner called weird (2026-11-17). Every chart
// now takes it from the theme's grid colour, the one Security's day bars
// already used, so the same hover looks the same on every tab and in both themes.
test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

const CHARTS = [
  { tab: 'network', panel: 'network-utilization-distribution', kind: 'bar' },
  { tab: 'dns', panel: 'dns-query-volume-7d', kind: 'area' },
  { tab: 'incidents', panel: 'incidents-action-volume', kind: 'bar' },
  { tab: 'security', panel: 'security-threat-feed-activity', kind: 'bar' },
  { tab: 'dns', panel: 'dns-query-rate', kind: 'area' },
] as const;

for (const c of CHARTS) {
  test(`${c.panel}: the hover ${c.kind === 'bar' ? 'box' : 'line'} uses the theme's grid colour, not recharts' grey`, async ({ page }) => {
    await page.goto(`/#${c.tab}`);
    const card = page.locator(`[data-panel-id="${c.panel}"]`);
    const surface = card.locator('.recharts-surface').first();
    await expect(surface).toBeVisible({ timeout: 15_000 });
    // Wait for the chart to have drawn its bars or line, then point at the
    // middle of the plot, which every one of these charts fills.
    await expect(card.locator(c.kind === 'bar' ? '.recharts-bar-rectangle' : '.recharts-area-curve').first()).toBeAttached({ timeout: 15_000 });
    // Lower panels start below the fold, where a mouse move lands on nothing.
    await surface.scrollIntoViewIfNeeded();
    const box = (await surface.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height * 0.6;
    await page.mouse.move(x, y);
    const cursor = card.locator('.recharts-tooltip-cursor').first();
    await expect(cursor).toBeAttached({ timeout: 2_000 });
    const attr = c.kind === 'bar' ? 'fill' : 'stroke';
    await expect(cursor).toHaveAttribute(attr, 'var(--color-grid)');
  });
}
