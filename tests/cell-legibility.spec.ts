import { test, expect } from '@playwright/test';

// SITE-WIDE cell-legibility system (P0 slice 2) on the shared DataTable:
//   1. an ID/entity column type — middle-truncated, monospace, hover-full, click-to-copy
//   2. table-fit default — table-layout:fixed + per-cell ellipsis + hide-empty-columns,
//      so NO table horizontally scrolls its container.
// Exercised on the Incidents "Triage" table (#incidents, /api/incidents), whose
// "Entity" column holds long UUID/path identifiers (ipam/subnet/<uuid>) — one per
// individual signal row.

const FULL_ID = 'ipam/subnet/004ad065-b3b3-4a2e-9c1f-88f2a1b9aea8b/address/10.42.128.64/host/really-long-hostname-segment-xyz';

// Triage now lists INDIVIDUAL signals (server.py inlines them into /api/incidents
// alongside the category rollup), so the long identifier lives in signals[].entity_id —
// it used to be incidents[].sample_entities. `incidents` is kept: the rollup still
// feeds the banner and per-category snooze. message:'' throughout is deliberate — it is
// what the "all-empty column is hidden" test asserts on.
const SIGNAL = (id: string, category: string, severity: string) => ({
  source: category, entity_type: 'subnet', entity_id: id, category, severity,
  message: '', detected_at: 1784000000,
});
const INCIDENTS = {
  incidents: [
    { key: 'k1', severity: 'critical', count: 12, message: '', category: 'ipam',
      sample_entities: [FULL_ID] },
    { key: 'k2', severity: 'high', count: 5, message: '', category: 'dns',
      sample_entities: ['ipam/subnet/91f2c0de-77aa-4b1c-8e3d-1a2b3c4d5e6f'] },
    { key: 'k3', severity: 'medium', count: 3, message: '', category: 'dhcp',
      sample_entities: ['ipam/subnet/deadbeef-0000-1111-2222-333344445555'] },
  ],
  signals: [
    SIGNAL(FULL_ID, 'ipam', 'critical'),
    SIGNAL('ipam/subnet/91f2c0de-77aa-4b1c-8e3d-1a2b3c4d5e6f', 'dns', 'high'),
    SIGNAL('ipam/subnet/deadbeef-0000-1111-2222-333344445555', 'dhcp', 'medium'),
  ],
  signals_total: 3,
  signals_truncated: false,
};

async function mock(page: any) {
  await page.route('**/api/incidents', (r: any) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(INCIDENTS) }));
  await page.route('**/api/actions', (r: any) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/mcp/events', (r: any) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
}

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

test('a long identifier cell renders middle-truncated (monospace id cell), not full width', async ({ page }) => {
  await mock(page);
  await page.goto('/#incidents');

  const idCell = page.locator('table.dt .dt-id').first();
  await expect(idCell).toBeVisible();

  // Middle-truncation keeps the TAIL of the identifier visible (the head is the
  // part that ellipsizes) — so the last chars are always legible.
  const tail = page.locator('table.dt .dt-id .dt-id-tail').first();
  await expect(tail).toHaveText(FULL_ID.slice(-6));

  // The id content is bounded to its cell — it does NOT overflow the td.
  const td = idCell.locator('xpath=ancestor::td[1]');
  const overflow = await td.evaluate((el: HTMLElement) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  // Monospace (tabular identifier), not the default proportional body font.
  const ff = await idCell.evaluate((el: HTMLElement) => getComputedStyle(el).fontFamily.toLowerCase());
  expect(ff).toMatch(/mono/);
});

test('hovering the id cell reveals the full identifier via the hovercard', async ({ page }) => {
  await mock(page);
  await page.goto('/#incidents');

  const idCell = page.locator('table.dt .dt-id').first();
  await expect(idCell).toBeVisible();
  await idCell.hover();

  const hc = page.locator('.hoverdetail.show');
  await expect(hc).toBeVisible();
  await expect(hc).toContainText(FULL_ID);
});

test('clicking the id cell copies the FULL identifier (not the truncated text)', async ({ page }) => {
  await mock(page);
  await page.goto('/#incidents');

  const idCell = page.locator('table.dt .dt-id').first();
  await expect(idCell).toBeVisible();
  await idCell.click();

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(FULL_ID);
});

test('the id cell is keyboard reachable and copies on Enter', async ({ page }) => {
  await mock(page);
  await page.goto('/#incidents');

  const idCell = page.locator('table.dt .dt-id').first();
  await expect(idCell).toBeVisible();
  await idCell.focus();
  await expect(idCell).toBeFocused();
  await page.keyboard.press('Enter');

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(FULL_ID);
});

test('a table with a long-identifier column does NOT horizontally overflow its container', async ({ page }) => {
  // Narrow-ish viewport: the long identifier alone is wider than the panel, so an
  // auto-layout table would force a horizontal scrollbar. table-layout:fixed +
  // per-cell ellipsis must keep the table inside .tbl-wrap.
  await page.setViewportSize({ width: 760, height: 900 });
  await mock(page);
  await page.goto('/#incidents');

  await expect(page.locator('table.dt tbody tr').first()).toBeVisible();

  const wrap = page.locator('.tbl-wrap').first();
  const gap = await wrap.evaluate((el: HTMLElement) => el.scrollWidth - el.clientWidth);
  expect(gap).toBeLessThanOrEqual(2);
});

test('an all-empty column is hidden by default', async ({ page }) => {
  await mock(page);
  await page.goto('/#incidents');

  await expect(page.locator('table.dt tbody tr').first()).toBeVisible();
  // Every row has message:'' → the plain (un-rendered) Message column is dropped.
  const headers = await page.locator('table.dt thead th').allInnerTexts();
  const norm = headers.map(h => h.replace(/[↑↓\s]/g, '').toLowerCase());
  expect(norm).not.toContain('message');
  // Sanity: the populated id column IS still shown. It is "Entity" (singular) now —
  // a row is ONE signal, so it holds one id. It read "Entities" while a row was a
  // category standing for a list of sample_entities.
  expect(norm.some(h => h.includes('entity'))).toBeTruthy();
});
