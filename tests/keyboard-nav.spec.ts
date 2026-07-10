import { test, expect } from '@playwright/test';

// Keyboard power-nav on #network. The subnets DataTable is powered (tableId,
// selectable, filterable, renderPeek). Its wrapper is div[tabindex="0"] and the
// only one holding clickable rows (leases tables aren't onRowClick). A single
// global keydown listener (PowerProvider) drives j/k/Enter/Arrow/Escape.
// Uses REAL KeyboardEvents via page.keyboard.press after focusing the wrapper.

// The subnet table ships problemsOnly (util>70) ON by default, so every mocked
// row must be >70 to survive the filter (utils kept in descending order so the
// util-desc default sort still yields Alpha, Beta, Gamma at indexes 0,1,2).
const DATA = {
  subnets: [
    { id: 's-a', name: 'Alpha Net', addr: '10.10.10.0', cidr: 24, util: 90, site: 'HQ' },
    { id: 's-b', name: 'Beta Net',  addr: '10.20.20.0', cidr: 24, util: 80, site: 'DR' },
    { id: 's-c', name: 'Gamma Net', addr: '10.30.30.0', cidr: 24, util: 72, site: 'BR' },
  ],
  leases: [], zones: [], hosts: [], auditLogs: [],
};

const WRAP = 'div[tabindex="0"]:has(tr.clickable)';

async function mock(page) {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
}

test('j/k move a row cursor and the peek follows the cursor', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');

  const wrap = page.locator(WRAP);
  await expect(wrap.locator('tr.clickable').first()).toBeVisible();
  await wrap.focus();

  // Two j presses -> cursor on sorted index 1 (util desc: Alpha, Beta, Gamma).
  await page.keyboard.press('j');
  await page.keyboard.press('j');

  const cursor = page.locator('tr.cursor');
  await expect(cursor).toHaveCount(1);
  await expect(cursor).toHaveAttribute('aria-selected', 'true');
  await expect(wrap).toHaveAttribute('aria-activedescendant', /subnets-r-1$/);
  await expect(cursor).toContainText('10.20.20.0'); // Beta

  // Enter opens the peek for the cursor row (renderPeek, not the drill nav).
  await page.keyboard.press('Enter');
  const peek = page.locator('.peek');
  await expect(peek).toBeVisible();
  await expect(peek).toContainText('10.20.20.0');

  // ArrowDown while the peek is open advances the cursor AND the peek content.
  await page.keyboard.press('ArrowDown');
  await expect(peek).toContainText('10.30.30.0'); // Gamma
  await expect(page).not.toHaveURL(/subnet=/);    // peek, not a drill navigation

  // Escape closes the peek (unmounted -> gone from the DOM).
  await page.keyboard.press('Escape');
  await expect(page.locator('.peek')).toHaveCount(0);
});

test('typing in the filter input does not move the row cursor', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');

  // Subnets is the only filterable table on #network, so .dt-filter is unique.
  await expect(page.locator(WRAP).locator('tr.clickable').first()).toBeVisible();
  const filter = page.locator('.dt-filter');
  await expect(filter).toBeVisible();
  await filter.focus();

  // 'j' is a cursor key globally, but must be swallowed as text inside an input.
  await page.keyboard.press('j');
  await expect(filter).toHaveValue('j');
  await expect(page.locator('tr.cursor')).toHaveCount(0);
});
