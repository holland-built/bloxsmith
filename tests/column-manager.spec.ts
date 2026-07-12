import { test, expect } from '@playwright/test';

// Feature 8 — Column manager. Extends the existing "Cols" show/hide popover
// (.dt-cols-menu, .dt-cols-item) on the #dns Zones table with keyboard reorder
// (per-row up/down buttons) and pin-first, persisted per tableId in LS
// (bx.cols.order.<id> / bx.cols.pin.<id>) alongside the existing
// bx.cols.<id> hidden-columns key.

// anomaly:true on every row so all three survive the table's default
// "Problems only" filter (zoneCols sets default:true) without an extra
// toggle-off step in every test — column-manager behavior is what's under test.
const DATA = {
  zones: [
    { fqdn: 'alpha.example.com', view: 'default', ttl: 3600, issues: [], anomaly: true },
    { fqdn: 'beta.example.com',  view: 'default', ttl: 3600, issues: [], anomaly: true },
    { fqdn: 'gamma.example.com', view: 'default', ttl: 3600, issues: [], anomaly: true },
  ],
  subnets: [], leases: [], hosts: [], auditLogs: [], events: [],
};

const COLS_BTN = '.dt-cols-slot > button';
const MENU = '.dt-cols-menu';

async function mock(page) {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.route('**/api/dns-analytics', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  );
  await page.route('**/api/whoami', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  );
}

async function openMenu(page) {
  await page.locator(COLS_BTN).click();
  await expect(page.locator(MENU)).toBeVisible();
}

// selectable adds a leading checkbox <th> with no text — drop blanks so index 0
// lines up with the first real (labelled) column. thead th is CSS
// text-transform:uppercase, so allInnerTexts() already returns the rendered
// uppercase form — normalize explicitly so this doesn't depend on that CSS rule.
async function headerTexts(page) {
  const raw = await page.locator('table.dt thead th').allInnerTexts();
  return raw.map(t => t.trim().toUpperCase()).filter(Boolean);
}

test('hiding a column removes its header and cells', async ({ page }) => {
  await mock(page);
  await page.goto('/#dns');
  await expect(page.locator('table.dt tbody td', { hasText: 'alpha.example.com' })).toBeVisible();

  await openMenu(page);
  const before = await headerTexts(page);
  expect(before.some(t => t.startsWith('VIEW'))).toBe(true);

  const viewItem = page.locator('.dt-cols-item', { hasText: 'View' });
  await viewItem.locator('input[type="checkbox"]').uncheck();

  const after = await headerTexts(page);
  expect(after.some(t => t.startsWith('VIEW'))).toBe(false);
  // cells for the hidden column are gone too — column count shrinks by exactly one.
  expect(after.length).toBe(before.length - 1);
});

test('reordering a column via the up button moves it and persists across reload', async ({ page }) => {
  await mock(page);
  await page.goto('/#dns');
  await expect(page.locator('table.dt tbody td', { hasText: 'alpha.example.com' })).toBeVisible();

  await openMenu(page);
  const strip = (t: string) => t.replace(/[↑↓]$/, '').trim();
  const startHeaders = (await headerTexts(page)).map(strip);
  expect(startHeaders[0]).toBe('ZONE');
  expect(startHeaders[1]).toBe('VIEW');

  // Move "View" (2nd column) up one slot -> becomes 1st.
  const viewItem = page.locator('.dt-cols-item', { hasText: 'View' });
  await viewItem.getByRole('button', { name: 'Move View up' }).click();

  const movedHeaders = (await headerTexts(page)).map(strip);
  expect(movedHeaders[0]).toBe('VIEW');
  expect(movedHeaders[1]).toBe('ZONE');

  // Persisted under the bx.cols.order.<tableId> LS key.
  const stored = await page.evaluate(() => localStorage.getItem('bx.cols.order.zones'));
  expect(stored).toBeTruthy();
  expect(JSON.parse(stored!)[0]).toBe('view');

  // Reload -> order restored from localStorage.
  await page.reload();
  await expect(page.locator('table.dt tbody td', { hasText: 'alpha.example.com' })).toBeVisible();
  const reloadedHeaders = (await headerTexts(page)).map(strip);
  expect(reloadedHeaders[0]).toBe('VIEW');
});

test('pinning a column moves it first', async ({ page }) => {
  await mock(page);
  await page.goto('/#dns');
  await expect(page.locator('table.dt tbody td', { hasText: 'alpha.example.com' })).toBeVisible();

  await openMenu(page);
  const strip = (t: string) => t.replace(/[↑↓]$/, '').trim();
  const startHeaders = (await headerTexts(page)).map(strip);
  expect(startHeaders[0]).toBe('ZONE');

  // TTL is neither first nor last; pin it and confirm it jumps to the front.
  const ttlItem = page.locator('.dt-cols-item', { hasText: 'TTL' });
  await ttlItem.getByRole('button', { name: 'Pin TTL column' }).click();

  const pinnedHeaders = (await headerTexts(page)).map(strip);
  expect(pinnedHeaders[0]).toBe('TTL');

  // No color-only state: the pin toggle reflects state via aria-pressed + label text.
  await expect(ttlItem.getByRole('button', { name: 'Unpin TTL column' })).toHaveAttribute('aria-pressed', 'true');
  await expect(ttlItem).toContainText('Pinned');
});

test('Esc closes the Cols popover and returns focus to the Cols button', async ({ page }) => {
  await mock(page);
  await page.goto('/#dns');
  await expect(page.locator('table.dt tbody td', { hasText: 'alpha.example.com' })).toBeVisible();

  const trigger = page.locator(COLS_BTN);
  await openMenu(page);

  // Opening the popover moves focus into it (first enabled control).
  await expect(page.locator(MENU).locator(':focus')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(page.locator(MENU)).toBeHidden();
  await expect(trigger).toBeFocused();
});
