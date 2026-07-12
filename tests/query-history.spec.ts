import { test, expect } from '@playwright/test';

// Recent-queries dropdown ("absorbed" query history) on the #network subnets
// search box. Same DATA shape as keyboard-nav.spec.ts / nl-bql.spec.ts.

const DATA = {
  subnets: [
    { id: 's-a', name: 'Alpha Net', addr: '10.10.10.0', cidr: 24, util: 90, site: 'HQ' },
    { id: 's-b', name: 'Beta Net',  addr: '10.20.20.0', cidr: 24, util: 80, site: 'DR' },
    { id: 's-c', name: 'Gamma Net', addr: '10.30.30.0', cidr: 24, util: 72, site: 'BR' },
  ],
  leases: [], zones: [], hosts: [], auditLogs: [], events: [],
};

const WRAP = 'div[tabindex="0"]:has(tr.clickable)';

async function mock(page) {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
}

test('a submitted query appears in the recent dropdown and can be re-run', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  await expect(page.locator(WRAP).locator('tr.clickable').first()).toBeVisible();

  const filter = page.locator('.dt-filter');

  // Submit a query — Enter commits it to history.
  await filter.fill('site:HQ');
  await filter.press('Enter');
  await expect(page.locator('tr.clickable')).toHaveCount(1); // narrowed to Alpha (site HQ)

  // Clear + refocus the empty box — the recent dropdown lists what was submitted.
  await filter.fill('');
  await filter.focus();
  const item = page.locator('.dt-sug-recent', { hasText: 'site:HQ' });
  await expect(item).toBeVisible();

  // Re-run it via the dropdown.
  await item.locator('.dt-sug-recent-run').click();
  await expect(filter).toHaveValue('site:HQ');
  await expect(page.locator('tr.clickable')).toHaveCount(1);
});

test('pinning a recent query is monochrome and persists across reload', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  await expect(page.locator(WRAP).locator('tr.clickable').first()).toBeVisible();

  const filter = page.locator('.dt-filter');
  await filter.fill('util>85');
  await filter.press('Enter');
  await filter.fill('');
  await filter.focus();

  const item = page.locator('.dt-sug-recent', { hasText: 'util>85' });
  const pin = item.locator('.dt-sug-pin');
  await expect(pin).toBeVisible();
  await expect(pin).toHaveAttribute('aria-pressed', 'false');

  // Restraint-Auditor gate: the pin control must render monochrome, never gold.
  const color = await pin.evaluate(el => getComputedStyle(el).color);
  expect(color).not.toMatch(/255,\s*215|gold/i);

  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');

  // Persisted: survives a reload (localStorage-backed).
  await page.reload();
  await filter.focus();
  const pinnedAfterReload = page.locator('.dt-sug-recent', { hasText: 'util>85' }).locator('.dt-sug-pin');
  await expect(pinnedAfterReload).toHaveAttribute('aria-pressed', 'true');
});
