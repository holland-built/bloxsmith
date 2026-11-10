import { test, expect } from './fixtures';
import { installFixtures, FIXED_NOW } from './page-fixtures';
import { openPanelMenu } from './layout-helpers';

// A headline tile jumps to the panel its number comes from. When that panel
// has been taken off the page there is nothing to jump to, so focus goes to
// "Arrange panels", where the panel can be put back. Overview and Network did
// this already; DNS and Security did nothing at all until their tiles shared
// the same jump (ui/src/lib/jumpToPanel.js).
//
// Hiding a panel saves the page's layout, so each test deletes that saved view
// before and after, as security-headline.spec.ts does.

const CASES = [
  { tab: 'dns', view: '__layout_dns', panel: 'dns-services', tile: '[data-tile="services"]' },
  { tab: 'security', view: '__layout_security', panel: 'security-lookalike-domains', tile: '[data-key="lookalikes"]' },
];

for (const c of CASES) {
  test.describe(c.tab, () => {
    test.beforeEach(async ({ page }) => {
      await page.clock.setFixedTime(FIXED_NOW);
      await installFixtures(page, c.tab);
      await page.request.delete(`/api/views/${c.view}`).catch(() => {});
    });
    test.afterEach(async ({ page }) => {
      await page.request.delete(`/api/views/${c.view}`).catch(() => {});
    });

    test(`a ${c.tab} tile whose panel is off the page moves focus to Arrange panels`, async ({ page }) => {
      await page.goto(`/#${c.tab}`);
      const panel = page.locator(`[data-panel-id="${c.panel}"]`);
      await expect(panel).toBeVisible();

      await openPanelMenu(page, c.panel);
      await panel.locator('[data-layout-hide]').click();
      await expect(panel).toHaveCount(0);

      await page.locator(c.tile).click();
      await expect(page.getByRole('button', { name: 'Arrange panels', exact: true })).toBeFocused();
    });
  });
}
