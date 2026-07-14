import { test, expect } from '@playwright/test';

// Copy-as: the per-row copy affordance — ONE kebab (⋮) in the trailing dt-acts
// gutter opening a labeled menu of CSV / JSON / BQL-filter / Markdown, announced
// via the toast/aria-live bus. Replaces the old ⧉/▾ pair, which painted over the
// last cell's value, duplicated JSON across both controls, and sat in a td with
// overflow:hidden that clipped the menu to a single visible item.
// See DTRow (dt-acts / KebabMenu / COPY_AS_FORMATS) and the rowAsCSV/rowAsBQL/
// rowAsMarkdown helpers near downloadCSV.

test.use({ baseURL: process.env.NOC_BASE || 'http://localhost:8091' });

const SECURITY = {
  counts: { critical: 1, high: 1, medium: 1 }, blocked: 0, logged: 0, total: 3,
  events: [
    { severity: 'critical', qname: 'crit.example', policy_action: 'block', feed_name: 'f1', device: 'd1', event_time: '2026-07-09T10:00:00Z' },
    { severity: 'high',     qname: 'high.example', policy_action: 'log',   feed_name: 'f2', device: 'd2', event_time: '2026-07-09T09:00:00Z' },
    { severity: 'medium',   qname: 'med.example',  policy_action: 'log',   feed_name: 'f3', device: 'd3', event_time: '2026-07-09T08:00:00Z' },
  ],
};

const ROW_ACTIONS = 'Row actions — crit.example';

async function mock(page: any) {
  await page.route('**/api/hub/security', (route: any) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SECURITY) })
  );
}

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

async function openMenu(page: any) {
  const rows = page.locator('table.dt tbody tr');
  await expect(rows.first()).toBeVisible();
  const row = rows.first(); // crit.example (severity sorts first)
  await row.hover();
  // Per-row a11y name — qualified by the primary column so 50 rows don't all
  // expose an identical "Row actions" button.
  const trigger = row.getByRole('button', { name: ROW_ACTIONS });
  await trigger.click();
  return trigger;
}

test('offers CSV, JSON, BQL filter, and Markdown formats', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');
  await openMenu(page);

  const menu = page.getByRole('menu', { name: ROW_ACTIONS });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Copy row as CSV', 'Copy row as JSON', 'Copy row as BQL filter', 'Copy row as Markdown',
  ]);
  // The old menu lived in an overflow:hidden cell and was clipped to the row band —
  // every item must be inside the viewport, not merely "visible" to Playwright.
  const box = await menu.boundingBox();
  const items = await menu.getByRole('menuitem').all();
  for (const it of items) {
    const b = await it.boundingBox();
    expect(b!.y + b!.height).toBeLessThanOrEqual(box!.y + box!.height + 1);
  }
});

test('copying JSON yields the row object and announces it', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');
  await openMenu(page);

  await page.getByRole('menuitem', { name: 'Copy row as JSON' }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const parsed = JSON.parse(clip);
  expect(parsed.qname).toBe('crit.example');
  expect(parsed.severity).toBe('critical');

  const live = page.locator('.toasts[aria-live="polite"]');
  await expect(live).toContainText('Copied as JSON');
});

test('copying CSV yields a quoted CSV row and announces it', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');
  await openMenu(page);

  await page.getByRole('menuitem', { name: 'Copy row as CSV' }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('"crit.example"');
  expect(clip).toContain('"critical"');
  expect(clip.split('\n').length).toBe(2); // header + one row

  const live = page.locator('.toasts[aria-live="polite"]');
  await expect(live).toContainText('Copied as CSV');
});

test('copying as BQL filter yields a field:value AND … query and announces it', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');
  await openMenu(page);

  await page.getByRole('menuitem', { name: 'Copy row as BQL filter' }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('qname:crit.example');
  expect(clip).toContain('severity:critical');
  expect(clip).toContain(' AND ');

  const live = page.locator('.toasts[aria-live="polite"]');
  await expect(live).toContainText('Copied as BQL filter');
});

test('copying as Markdown yields a pipe table row and announces it', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');
  await openMenu(page);

  await page.getByRole('menuitem', { name: 'Copy row as Markdown' }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip.startsWith('|')).toBe(true);
  expect(clip).toContain('crit.example');

  const live = page.locator('.toasts[aria-live="polite"]');
  await expect(live).toContainText('Copied as Markdown');
});

test('keyboard: arrow keys move focus within the menu, Escape closes and returns focus to the trigger', async ({ page }) => {
  await mock(page);
  await page.goto('/#security');
  const trigger = await openMenu(page);

  const firstItem = page.getByRole('menuitem', { name: 'Copy row as CSV' });
  await expect(firstItem).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Copy row as JSON' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: ROW_ACTIONS })).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
