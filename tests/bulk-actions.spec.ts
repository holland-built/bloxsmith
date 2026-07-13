import { test, expect } from '@playwright/test';
import fs from 'fs';

// Feature 8 — READ-ONLY bulk actions on a selection. EXTENDS the existing bulk
// selection + ActionBar (bulk-select.spec.ts) with three new read-only verbs:
//   • Export subset    — selected rows -> CSV via downloadCSV
//   • Copy as          — CSV / JSON / BQL / Markdown of the whole selection
//   • Pivot to filter  — the selection's shared field values -> FilterCtx filters
// No mutations. Selection count is live-announced (aria-live). Uses the #network
// subnets DataTable (selectable + fx/FilterCtx + csvName="subnets").

test.use({ baseURL: process.env.NOC_BASE || 'http://localhost:8091' });

const WRAP = 'div[tabindex="0"]:has(tr.clickable)';

// Alpha + Beta share site=HQ (differ in name/addr/util); Gamma is DR. All util>70
// so they survive the table's problemsOnly default; none at 100 (no collapse).
const DATA = {
  subnets: [
    { id: 's-a', name: 'Alpha Net', addr: '10.10.10.0', cidr: 24, util: 90, site: 'HQ' },
    { id: 's-b', name: 'Beta Net',  addr: '10.20.20.0', cidr: 24, util: 80, site: 'HQ' },
    { id: 's-c', name: 'Gamma Net', addr: '10.30.30.0', cidr: 24, util: 72, site: 'DR' },
  ],
  leases: [], zones: [], hosts: [], auditLogs: [],
};

async function mock(page: any) {
  await page.route('**/api/data', (route: any) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
}

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

async function selectTwo(page: any) {
  const rows = page.locator(`${WRAP} tbody tr`);
  await expect(rows.first()).toBeVisible();
  await rows.nth(0).locator('input[aria-label="Select row"]').check();
  await rows.nth(1).locator('input[aria-label="Select row"]').check();
  await expect(page.locator('.action-bar')).toContainText('2 selected');
}

test('selection action-bar exposes Export subset / Copy as / Pivot to filter', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  await selectTwo(page);

  const bar = page.locator('.action-bar');
  await expect(bar.getByRole('button', { name: 'Export subset' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Copy as' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Pivot to filter' })).toBeVisible();
});

test('selection count is announced via aria-live', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  await selectTwo(page);

  const count = page.locator('.action-bar .ab-count');
  await expect(count).toHaveAttribute('aria-live', 'polite');
  await expect(count).toContainText('2 selected');
});

test('Export subset downloads a CSV of exactly the selected rows', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  await selectTwo(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.action-bar').getByRole('button', { name: 'Export subset' }).click(),
  ]);
  const path = await download.path();
  const text = fs.readFileSync(path!, 'utf8');
  const lines = text.trim().split('\n');
  // header + the two selected rows (Alpha, Beta) — Gamma excluded.
  expect(lines.length).toBe(3);
  expect(text).toContain('Alpha Net');
  expect(text).toContain('Beta Net');
  expect(text).not.toContain('Gamma Net');
});

test('Copy as offers CSV/JSON/BQL/Markdown and JSON yields the selected rows', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  await selectTwo(page);

  await page.locator('.action-bar').getByRole('button', { name: 'Copy as' }).click();
  const menu = page.getByRole('menu', { name: 'Copy as' });
  await expect(menu.getByRole('menuitem')).toHaveText(['CSV', 'JSON', 'BQL filter', 'Markdown']);

  await menu.getByRole('menuitem', { name: 'JSON' }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const parsed = JSON.parse(clip);
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed.length).toBe(2);
  const names = parsed.map((r: any) => r.name).sort();
  expect(names).toEqual(['Alpha Net', 'Beta Net']);

  const live = page.locator('.toasts[aria-live="polite"]');
  await expect(live).toContainText('Copied 2 rows as JSON');
});

test('Pivot to filter turns the selection shared value (site=HQ) into a filter', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  await selectTwo(page); // Alpha + Beta, both site=HQ

  await page.locator('.action-bar').getByRole('button', { name: 'Pivot to filter' }).click();

  const bar = page.locator('.filter-bar');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('HQ');
  await expect(page).toHaveURL(/f=site/);
});
