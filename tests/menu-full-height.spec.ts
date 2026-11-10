import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The page menu down the left side (JobRail in ui/src/components/JobNav.jsx)
// is a column: its card background and right-hand border line belong to the
// whole height of the page, not just the first screenful. It used to be one
// viewport tall, so on a long page (Security, DNS, Network) the page
// background showed below it once the page was scrolled or captured whole.
//
// Measured, not eyeballed: the column's box must reach the bottom of the
// document, and the pixel at the bottom-left of a scrolled-to-the-end page
// must belong to the menu column, in both themes.

const SHOTS = process.env.MENU_SHOTS; // optional: directory for full-page screenshots

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: the left menu column runs the full height of a long page`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installBaselineWorld(page);
    await page.addInitScript(`localStorage.setItem('theme', ${JSON.stringify(theme)})`);
    await page.goto('/#security');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('heading', { level: 1, name: /^Security/ })).toBeVisible();
    const rail = page.locator('nav[data-job-rail]');
    await expect(rail).toBeVisible();
    // Let the page finish growing before measuring how tall it is.
    await page.waitForLoadState('networkidle');

    const docH = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(docH, 'Security must be longer than one screen for this test to mean anything').toBeGreaterThan(900 * 1.5);

    if (SHOTS) await page.screenshot({ path: `${SHOTS}-${theme}.png`, fullPage: true });

    // Find what paints the menu column: the first element with an opaque
    // background under a point beside the menu links. Found by what is painted,
    // not by class name, so the test holds whichever element carries it.
    const painter = () =>
      page.evaluate(() => {
        const nav = document.querySelector('nav[data-job-rail]') as HTMLElement;
        const nr = nav.getBoundingClientRect();
        const x = nr.left + 20;
        const y = nr.top + 40;
        const el = document
          .elementsFromPoint(x, y)
          .find((e) => getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)') as HTMLElement;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const card = getComputedStyle(document.querySelector('header') as HTMLElement).backgroundColor;
        return {
          top: r.top + window.scrollY,
          bottom: r.bottom + window.scrollY,
          width: r.width,
          bg: cs.backgroundColor,
          card,
          borderRight: parseFloat(cs.borderRightWidth),
          navTop: nr.top,
        };
      });

    const before = await painter();
    expect(before.bg, 'the menu column is painted in the card colour').toBe(before.card);
    expect(before.borderRight, 'the menu column keeps its right-hand border line').toBeGreaterThanOrEqual(1);
    expect(before.width, 'the menu keeps its width').toBe(208);
    // The bug: this box was one screen tall, so it stopped ~950px down a 2100px page.
    expect(before.bottom, `menu column stops at ${before.bottom}px on a ${docH}px page`).toBeGreaterThanOrEqual(docH - 1);

    // Still sticky: at the end of the page the menu links are on screen, at the top.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const after = await painter();
    expect(after.navTop).toBeGreaterThanOrEqual(0);
    expect(after.navTop).toBeLessThan(120);
    await expect(rail.getByRole('link', { name: 'Overview' })).toBeInViewport();
  });
}
