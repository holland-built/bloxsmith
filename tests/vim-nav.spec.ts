import { test, expect } from '@playwright/test';

// Feature 5 — vim row-nav. EXTENDS the existing PowerProvider global keydown
// listener + DataTable cursor (see keyboard-nav.spec.ts for the base j/k/Enter/
// peek coverage). This file covers the pieces that spec doesn't: g/G jump-to-
// top/bottom, x toggle-select (reusing bulk-select's ActionBar), the not-in-
// input guard extended to those keys, and the cursor row's non-color-only ring.
// Uses the #network subnets DataTable (selectable + clickable + filterable —
// same fixture shape as keyboard-nav.spec.ts).

test.use({ baseURL: process.env.NOC_BASE || 'http://localhost:8091' });

const DATA = {
  subnets: [
    { id: 's-a', name: 'Alpha Net', addr: '10.10.10.0', cidr: 24, util: 95, site: 'HQ' },
    { id: 's-b', name: 'Beta Net',  addr: '10.20.20.0', cidr: 24, util: 88, site: 'DR' },
    { id: 's-c', name: 'Gamma Net', addr: '10.30.30.0', cidr: 24, util: 80, site: 'BR' },
    { id: 's-d', name: 'Delta Net', addr: '10.40.40.0', cidr: 24, util: 75, site: 'LAB' },
  ],
  leases: [], zones: [], hosts: [], auditLogs: [],
};

const WRAP = 'div[tabindex="0"]:has(tr.clickable)';

async function mock(page) {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
}

test('G jumps to the last row, g g jumps back to the first', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  const wrap = page.locator(WRAP);
  await expect(wrap.locator('tr.clickable').first()).toBeVisible();
  await wrap.focus();

  await page.keyboard.press('G');
  const cursor = page.locator('tr.cursor');
  await expect(cursor).toContainText('10.40.40.0'); // Delta, last (util desc: A,B,C,D)

  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await expect(cursor).toContainText('10.10.10.0'); // back to Alpha, first
});

test('x toggles selection on the cursor row (reuses bulk-select ActionBar)', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  const wrap = page.locator(WRAP);
  await expect(wrap.locator('tr.clickable').first()).toBeVisible();
  await wrap.focus();

  await page.keyboard.press('j'); // cursor -> row 1 (Beta)
  await page.keyboard.press('x'); // select it

  await expect(page.locator('.action-bar')).toBeVisible();
  await expect(page.locator('.ab-count')).toContainText('1 selected');
  const cursorRow = page.locator('tr.cursor');
  await expect(cursorRow.locator('input[type="checkbox"]')).toBeChecked();

  await page.keyboard.press('x'); // toggle off
  await expect(page.locator('.action-bar')).toHaveCount(0);
});

test('cursor row carries a non-color-only ring (box-shadow) alongside aria state', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  const wrap = page.locator(WRAP);
  await expect(wrap.locator('tr.clickable').first()).toBeVisible();
  await wrap.focus();
  await page.keyboard.press('j');

  const cursor = page.locator('tr.cursor');
  await expect(cursor).toHaveAttribute('aria-selected', 'true');
  const shadow = await cursor.evaluate(el => getComputedStyle(el).boxShadow);
  expect(shadow).not.toBe('none');
  // Two distinct inset shadow layers (left accent bar + an all-around ring) —
  // a real ring shape, not just a background tint.
  expect((shadow.match(/inset/g) || []).length).toBeGreaterThan(1);
});

test('g/G/x are swallowed as plain text inside the filter input (guard extended)', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  await expect(page.locator(WRAP).locator('tr.clickable').first()).toBeVisible();
  const filter = page.locator('.dt-filter');
  await filter.focus();

  await page.keyboard.press('x');
  await page.keyboard.press('g');
  await page.keyboard.press('G');
  await expect(filter).toHaveValue('xgG');
  await expect(page.locator('tr.cursor')).toHaveCount(0);
  await expect(page.locator('.action-bar')).toHaveCount(0);
});
