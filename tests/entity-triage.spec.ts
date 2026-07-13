import { test, expect } from '@playwright/test';

// P1 slice 6 — entity-triage cluster. FOUR connected features on ONE shared
// surface (the existing keyboard peek + PowerProvider vim-nav):
//   1. Peek drawer opens for the cursor entity (fields shown, table keeps position)
//   2. Cross-tab trace — peek buttons nav to another plane with a BQL predicate
//   3. Pin-to-scratchpad — `p` pins the cursor row into an LS-backed tray (survives reload)
//   4. Keyboard macros — o/t/p, listed in the "?" shortcut overlay
// Uses the #network subnets table (powered: tableId+renderPeek+selectable+filterable);
// problemsOnly (util>70) ships ON so every fixture row is >70.

test.use({ baseURL: process.env.NOC_BASE || 'http://localhost:8091' });

const WRAP = 'div[tabindex="0"]:has(tr.clickable)';

const DATA = {
  subnets: [
    { id: 's-a', name: 'Alpha Net', addr: '10.10.10.0', cidr: 24, util: 90, site: 'HQ' },
    { id: 's-b', name: 'Beta Net',  addr: '10.20.20.0', cidr: 24, util: 80, site: 'DR' },
  ],
  leases: [], zones: [], hosts: [],
  auditLogs: [
    { ts: '2026-07-13T10:00:00Z', actor: 'ops', event: 'subnet.update', target: '10.10.10.0' },
  ],
};

async function mock(page: any) {
  await page.route('**/api/data', (route: any) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
}

async function openPeek(page: any) {
  await page.goto('/#network');
  const wrap = page.locator(WRAP);
  await expect(wrap.locator('tr.clickable').first()).toBeVisible();
  await wrap.focus();
  await page.keyboard.press('Enter');        // open peek for cursor row (Alpha, index 0)
  const peek = page.locator('.peek');
  await expect(peek).toBeVisible();
  return peek;
}

test('clicking an entity opens the peek with its fields; the table keeps its rows', async ({ page }) => {
  await mock(page);
  const peek = await openPeek(page);
  await expect(peek).toContainText('10.10.10.0');          // the entity's key field
  // Table position preserved — the subnets table is still mounted with its rows,
  // and the cursor row still exists (the peek is a side drawer, not a nav away).
  await expect(page.locator(`${WRAP} tr.clickable`)).toHaveCount(2);
  await expect(page).not.toHaveURL(/subnet=/);
});

test('the peek has cross-tab trace buttons that nav with a BQL predicate', async ({ page }) => {
  await mock(page);
  const peek = await openPeek(page);
  await expect(peek.getByRole('button', { name: 'Show in Audit' })).toBeVisible();
  await peek.getByRole('button', { name: 'Show in Audit' }).click();
  // Navigated to the Audit plane with a BQL predicate (addr:<ip>) in the shared
  // cross-filter hash param.
  await expect(page).toHaveURL(/#audit/);
  await expect(page).toHaveURL(/f=addr[:%]/);
  await expect(page).toHaveURL(/10\.10\.10\.0/);
});

test('`p` pins the cursor entity to the scratchpad tray; it survives a reload (LS)', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  const wrap = page.locator(WRAP);
  await expect(wrap.locator('tr.clickable').first()).toBeVisible();
  await wrap.focus();
  await page.keyboard.press('p');                          // pin cursor row (Alpha)

  const badge = page.locator('.scratch-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('1');

  // Open the on-demand tray → it lists the pinned entity.
  await badge.click();
  const tray = page.getByRole('dialog', { name: 'Scratchpad' });
  await expect(tray).toBeVisible();
  await expect(tray).toContainText('10.10.10.0');

  // Persisted in LS → survives a full reload (badge still shows 1).
  await page.reload();
  await expect(page.locator(`${WRAP} tr.clickable`).first()).toBeVisible();
  await expect(page.locator('.scratch-badge')).toContainText('1');
});

test('the scratchpad tray exports the pinned entities', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mock(page);
  await page.goto('/#network');
  const wrap = page.locator(WRAP);
  await expect(wrap.locator('tr.clickable').first()).toBeVisible();
  await wrap.focus();
  await page.keyboard.press('p');

  await page.locator('.scratch-badge').click();
  const tray = page.getByRole('dialog', { name: 'Scratchpad' });
  await expect(tray).toBeVisible();

  await tray.getByRole('button', { name: /Copy JSON/ }).click();
  await expect(page.locator('.toast')).toContainText(/Copied|Exported/);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('10.10.10.0');
});

test('the "?" shortcut overlay lists the o / t / p macros', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  await expect(page.locator(`${WRAP} tr.clickable`).first()).toBeVisible();

  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Open the row detail');   // o
  await expect(dialog).toContainText('Trace');                 // t
  await expect(dialog).toContainText('Pin');                   // p
});
