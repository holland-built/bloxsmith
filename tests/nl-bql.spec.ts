import { test, expect } from '@playwright/test';

// NL→BQL translator on the #network subnets search box. The subnets DataTable
// (tableId="subnets") ships problemsOnly (util>70) ON by default, so every
// mocked row must be >70 to survive that filter (see keyboard-nav.spec.ts).

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

test('translating plain English fills the search input with editable BQL', async ({ page }) => {
  await mock(page);

  let lastBody: any = null;
  await page.route('**/api/query', route => {
    try { lastBody = JSON.parse(route.request().postData() || '{}'); } catch { lastBody = {}; }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ answer: 'util>85', suggestions: [] }),
    });
  });

  await page.goto('/#network');
  await expect(page.locator(WRAP).locator('tr.clickable').first()).toBeVisible();

  const filter = page.locator('[data-table-id="subnets"] .dt-filter');
  await expect(filter).toBeVisible();
  await filter.fill('subnets that are almost full');

  const translateBtn = page.getByRole('button', { name: 'Translate to search query' });
  await expect(translateBtn).toBeEnabled();
  await translateBtn.click();

  // Filled with the generated BQL — and it stays a normal, editable input (not a black box).
  await expect(filter).toHaveValue('util>85');
  await expect(filter).toBeEditable();
  await filter.press('End');
  await page.keyboard.type('5'); // still typable/editable after translation
  await expect(filter).toHaveValue('util>855');
  await filter.fill('util>85'); // restore for the assertions below

  // The AI endpoint received a translation-style prompt carrying the real schema field names.
  expect(lastBody).not.toBeNull();
  expect(String(lastBody.question)).toContain('util');
  expect(String(lastBody.question)).toContain('subnets that are almost full');

  // A toast discloses what was generated (never a hidden black box).
  await expect(page.locator('.toast', { hasText: 'util>85' })).toBeVisible();

  // The filter is live — table narrows to the one subnet matching util>85 (Alpha, 90).
  await expect(page.locator('tr.clickable')).toHaveCount(1);
  await expect(page.locator('tr.clickable')).toContainText('Alpha');
});

test('translate button is disabled when the search box is empty', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  await expect(page.locator(WRAP).locator('tr.clickable').first()).toBeVisible();

  const translateBtn = page.getByRole('button', { name: 'Translate to search query' });
  await expect(translateBtn).toBeVisible();
  await expect(translateBtn).toBeDisabled();
});
