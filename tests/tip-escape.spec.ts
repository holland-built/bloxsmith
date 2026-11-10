import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// A hover/focus tip must close on Escape even when it was reached with the
// keyboard. A key press turns on :focus-visible, which the CSS uses to show the
// tip, so Escape has to win over it (data-closed). Daily had this fixed first
// (v3.146.0); the six other pages carried their own copies of the old Tip.
// All seven now share ui/src/components/Tip.jsx; Daily keeps its own dy- classes.

const PAGES: [string, string][] = [
  ['overview', 'ov'], ['dns', 'ov'], ['best-practices', 'ov'], ['audit', 'ov'],
  ['changes', 'ov'], ['incidents', 'ov'], ['daily', 'dy'],
];

for (const [id, prefix] of PAGES) {
  const wrap = `.${prefix}-tipwrap`;
  test(`${id}: a tip reached with Tab closes on Escape`, async ({ page }) => {
    await installBaselineWorld(page);
    await page.goto(`/#${id}`);
    const wraps = page.locator(wrap);
    await expect(wraps.first()).toBeVisible();

    // Tab until a tip trigger has focus: real keyboard focus, so :focus-visible is on.
    let found = false;
    for (let i = 0; i < 150 && !found; i++) {
      await page.keyboard.press('Tab');
      found = await page.evaluate((cls) => !!document.activeElement?.classList.contains(cls), `${prefix}-tipwrap`);
    }
    expect(found, 'Tab reached a tip trigger').toBe(true);

    const tip = page.locator(`${wrap}:focus > [role="tooltip"]`);
    await expect(tip).toBeVisible();
    await page.keyboard.press('Shift');
    await expect(tip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tip).toBeHidden();
    // Focus stays where it was; only the tip goes.
    await expect(page.locator(`${wrap}:focus`)).toHaveCount(1);
  });
}
