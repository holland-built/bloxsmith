import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// A hover/focus tip must close on Escape even when it was reached with the
// keyboard. A key press turns on :focus-visible, which the CSS uses to show the
// tip, so Escape has to win over it (data-closed). Daily had this fixed first
// (v3.146.0); the six pages below carried their own copies of the old Tip.

const PAGES = ['overview', 'dns', 'best-practices', 'audit', 'changes', 'incidents'];

for (const id of PAGES) {
  test(`${id}: a tip reached with Tab closes on Escape`, async ({ page }) => {
    await installBaselineWorld(page);
    await page.goto(`/#${id}`);
    const wraps = page.locator('.ov-tipwrap');
    await expect(wraps.first()).toBeVisible();

    // Tab until a tip trigger has focus: real keyboard focus, so :focus-visible is on.
    let found = false;
    for (let i = 0; i < 150 && !found; i++) {
      await page.keyboard.press('Tab');
      found = await page.evaluate(() => !!document.activeElement?.classList.contains('ov-tipwrap'));
    }
    expect(found, 'Tab reached a tip trigger').toBe(true);

    const tip = page.locator('.ov-tipwrap:focus > [role="tooltip"]');
    await expect(tip).toBeVisible();
    await page.keyboard.press('Shift');
    await expect(tip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tip).toBeHidden();
    // Focus stays where it was; only the tip goes.
    await expect(page.locator('.ov-tipwrap:focus')).toHaveCount(1);
  });
}
