import { test, expect } from '@playwright/test';

// Group C, Feature #3 — Facet <-> BQL two-way sync + live counts. The faceted
// Filter popover (dt-facet-*) and the table's own BQL search box are ONE query
// state, not two: typing a `field:value`/`field=value` token marks the matching
// facet item active, and clicking a facet mirrors a token back into the search
// box (in addition to the pre-existing fx.toggle/FilterCtx chip — see
// filter-facets.spec.ts, which this must not regress). Facet clicks announce
// via the shared toast/aria-live bus.

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
const SUBNETS_PANEL = '.pcard:has(h3:has-text("Subnets"))';
const FACET_BTN = `${SUBNETS_PANEL} .dt-facet-slot > button`;
const FILTER_INPUT = `${SUBNETS_PANEL} .dt-filter`;

async function openNetwork(page: any) {
  await page.route('**/api/data', (route: any) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.goto('/#network');
  await expect(page.locator(WRAP).locator('tr.clickable').first()).toBeVisible();
}

test('each facet value shows a count computed from the table\'s rows', async ({ page }) => {
  await openNetwork(page);
  await page.locator(FACET_BTN).click();
  const menu = page.locator('.dt-facet-menu');
  await expect(menu).toBeVisible();

  const hq = menu.locator('.dt-facet-item', { hasText: 'HQ' });
  const dr = menu.locator('.dt-facet-item', { hasText: 'DR' });
  await expect(hq.locator('.dt-facet-count')).toHaveText('2');
  await expect(dr.locator('.dt-facet-count')).toHaveText('1');
});

test('typing BQL (field=value) marks the matching facet item active without touching FilterCtx', async ({ page }) => {
  await openNetwork(page);

  await page.locator(FILTER_INPUT).fill('site=HQ');
  await expect(page.locator('tr.clickable')).toHaveCount(2);

  // No FilterBar chip — this table's own search text drove the narrowing, not fx.toggle.
  await expect(page.locator('.filter-bar')).toHaveCount(0);

  await page.locator(FACET_BTN).click();
  const hq = page.locator('.dt-facet-item', { hasText: 'HQ' });
  await expect(hq).toHaveClass(/active/);
  await expect(hq).toHaveAttribute('aria-pressed', 'true');

  const dr = page.locator('.dt-facet-item', { hasText: 'DR' });
  await expect(dr).not.toHaveClass(/active/);
});

test('clicking a facet value updates the query text (and still writes the FilterCtx chip)', async ({ page }) => {
  await openNetwork(page);

  await page.locator(FACET_BTN).click();
  await page.locator('.dt-facet-item', { hasText: 'HQ' }).click();

  // Query text now reflects the facet pick.
  await expect(page.locator(FILTER_INPUT)).toHaveValue('site=HQ');

  // Backward-compat: the existing FilterBar chip mechanism (filter-facets.spec.ts) still fires.
  await expect(page.locator('.filter-bar .chip.active', { hasText: 'Site: HQ' })).toBeVisible();
  await expect(page.locator('tr.clickable')).toHaveCount(2);

  // Announced via the shared toast/aria-live bus.
  await expect(page.locator('.toasts[aria-live="polite"]')).toContainText('Filtered to Site: HQ');

  // Clicking again removes both the chip and the mirrored query text.
  await page.locator('.dt-facet-item', { hasText: 'HQ' }).click();
  await expect(page.locator(FILTER_INPUT)).toHaveValue('');
  await expect(page.locator('.filter-bar')).toHaveCount(0);
});
