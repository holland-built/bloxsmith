import { test, expect } from '@playwright/test';

// F5 — on-demand faceted Filter popover on the #network subnets table.
// Facet click funnels into the SAME cross-filter mechanism pivot-cell already
// uses (FilterCtx / useFilters), so the resulting chip is the existing FilterBar
// chip (monochrome, accent only when active, × removes + announces via toast).

const DATA = {
  subnets: [
    { id: 's-a', name: 'Alpha Net', addr: '10.10.10.0', cidr: 24, util: 92, site: 'HQ' },
    { id: 's-b', name: 'Beta Net',  addr: '10.20.20.0', cidr: 24, util: 88, site: 'HQ' },
    { id: 's-c', name: 'Gamma Net', addr: '10.30.30.0', cidr: 24, util: 80, site: 'DR' },
    { id: 's-d', name: 'Delta Net', addr: '10.40.40.0', cidr: 24, util: 75, site: 'BR' },
  ],
  leases: [], zones: [], hosts: [], auditLogs: [], events: [],
};

const WRAP = 'div[tabindex="0"]:has(tr.clickable)';
// Scoped to the Subnets panel specifically — the Leases table on the same
// #network tab also has a pivot column (state) and therefore its own
// independent Filter button.
const SUBNETS_PANEL = '.pcard:has(h3:has-text("Subnets"))';
const FACET_BTN = `${SUBNETS_PANEL} .dt-facet-slot > button`;

async function mock(page) {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
}

test('opening the Filter popover shows facet values with counts', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  await expect(page.locator(WRAP).locator('tr.clickable').first()).toBeVisible();
  await expect(page.locator('tr.clickable')).toHaveCount(4);

  await page.locator(FACET_BTN).click();
  const menu = page.locator('.dt-facet-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.dt-facet-label', { hasText: 'Site' })).toBeVisible();

  const hq = menu.locator('.dt-facet-item', { hasText: 'HQ' });
  await expect(hq).toBeVisible();
  await expect(hq.locator('.dt-facet-count')).toHaveText('2');
});

test('clicking a facet value adds a chip and narrows the table; removing it restores rows', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  await expect(page.locator(WRAP).locator('tr.clickable').first()).toBeVisible();

  await page.locator(FACET_BTN).click();
  await page.locator('.dt-facet-item', { hasText: 'HQ' }).click();

  // Chip appears in the existing FilterBar and the table narrows to HQ subnets.
  const chip = page.locator('.filter-bar .chip.active', { hasText: 'Site: HQ' });
  await expect(chip).toBeVisible();
  await expect(page.locator('tr.clickable')).toHaveCount(2);

  // The facet item itself reflects the active (accent) state.
  await expect(page.locator('.dt-facet-item.active', { hasText: 'HQ' })).toBeVisible();

  // Removing the chip restores all rows and announces via the toast bus.
  await chip.click();
  await expect(page.locator('tr.clickable')).toHaveCount(4);
  await expect(page.locator('.toast', { hasText: 'Filter removed' })).toBeVisible();
});

test('Filter popover closes on Escape and returns focus to the trigger', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  await expect(page.locator(WRAP).locator('tr.clickable').first()).toBeVisible();

  const trigger = page.locator(FACET_BTN);
  await trigger.click();
  await expect(page.locator('.dt-facet-menu')).toBeVisible();

  await page.locator('.dt-facet-item', { hasText: 'HQ' }).press('Escape');
  await expect(page.locator('.dt-facet-menu')).toBeHidden();
  await expect(trigger).toBeFocused();
});
