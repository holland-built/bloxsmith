import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The connection sits at the left of the phone header in the side rail frame.
// Its tenant list used to hang from the chip's right edge with a 190px minimum,
// so at 320px the list's left edge left the screen and cut the tenant names.

const LONG = 'Northwind Regional Healthcare Production Tenant Eastern Division';
const TENANTS = [
  { id: 'baseline-tenant', label: 'Baseline Tenant' },
  { id: 'long-tenant', label: LONG },
  { id: 'unbroken-tenant', label: 'northwind-regional-healthcare-production-tenant-eastern' },
];

for (const [width, height] of [[320, 640], [390, 844]] as const) {
  test(`at ${width}px the whole tenant list stays on screen with long names`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await installBaselineWorld(page);
    await page.route('**/api/vault/status*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ exists: true, ready: true, unlocked: true, vaultMode: false, active: 'baseline-tenant', tenants: TENANTS }),
      }),
    );
    await page.goto('/#overview');

    const chip = page.locator('header button[aria-haspopup="listbox"]');
    await chip.click();
    const list = page.getByRole('listbox', { name: 'Switch tenant' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('option')).toHaveCount(TENANTS.length);

    const box = (await list.boundingBox())!;
    expect(box.x, 'the list starts off the left of the screen').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'the list ends off the right of the screen').toBeLessThanOrEqual(width);

    for (const t of TENANTS) {
      const name = list.getByRole('option', { name: t.label }).locator('span').last();
      await expect(name).toHaveText(t.label);
      const fit = await name.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { cut: el.scrollWidth > el.clientWidth + 1, left: r.left, right: r.right };
      });
      expect(fit.cut, `"${t.label}" is cut off`).toBe(false);
      expect(fit.left).toBeGreaterThanOrEqual(0);
      expect(fit.right).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);

    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(chip).toBeFocused();
  });
}
