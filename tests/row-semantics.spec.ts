import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';
import type { Locator, Page } from '@playwright/test';

// Every /api/ response is faked from tests/page-fixtures.ts.
//
// A table row that opens something used to BE the button:
//
//   <tr role="button" aria-label="View details for 10.20.0.0" tabindex="0">
//
// A button's children are presentational to assistive technology, and a <tr>
// with another role is no longer a row. So a screen reader announced the label
// and nothing else: on Daily's "Top Capacity Risks" the site, the utilisation
// and the free count of every subnet could not be reached, and the table had no
// rows to move through. Five tables did this, on Status, Daily and Assets.
//
// The row is a row again. What opens it is a real <button> in its first cell,
// drawn over that cell and see-through, so nothing on screen moved: the ring
// still goes round the whole row, and a mouse still opens it from any cell.
test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

const panel = (page: Page, id: string) => page.locator(`[data-panel-id="${id}"]`);

// Tab from `from` until focus sits on a row's own button. Real keys, because
// the ring is drawn on :focus-visible and that is what a keyboard user gets.
async function tabToRowButton(page: Page, from: Locator) {
  await from.focus();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    const onRow = await page.evaluate(() => document.activeElement?.hasAttribute('data-row-open') ?? false);
    if (onRow) return;
  }
  throw new Error('six Tab presses from the panel header never reached a row');
}

test('a row that opens something is a table row whose cells can be read', async ({ page }) => {
  await page.goto('/#daily');
  const table = panel(page, 'daily-hosts-attention').getByRole('table');
  const row = table.getByRole('row').filter({ hasText: 'baseline-host-b' });
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await expect(row.getByRole('cell')).toHaveCount(2);
  await expect(row.getByRole('cell').nth(1)).toHaveText('degraded');
  // What opens it is a real button, inside the row's first cell, named for the row.
  await expect(
    row.getByRole('cell').first().getByRole('button', { name: 'View details for baseline-host-b' }),
  ).toHaveCount(1);
});

test('no table row is itself a button, on any page that has rows to open', async ({ page }) => {
  for (const [tab, id] of [
    ['overview', 'subnet-table'],
    ['daily', 'daily-top-capacity-risks'],
    ['daily', 'daily-hosts-attention'],
    ['daily', 'daily-dns-zone-issues'],
    ['assets', 'assets-list'],
  ]) {
    await page.goto(`/#${tab}`);
    const body = panel(page, id).locator('tbody');
    await expect(body.locator('[data-row-open]').first(), `${tab}/${id}: no row has a button to open it`).toBeAttached({ timeout: 20_000 });
    // Row by row, not a total: two buttons in one row and none in the next
    // would add up to the right number.
    const found = await body.evaluate((el) => {
      const rows = Array.from(el.querySelectorAll('tr'));
      return {
        rows: rows.length,
        withRole: el.querySelectorAll('tr[role], tr[aria-label], tr[tabindex]').length,
        wrong: rows.filter(
          (tr) =>
            tr.querySelectorAll('[data-row-open]').length !== 1 ||
            !tr.querySelector(':scope > td:first-child > button[data-row-open]'),
        ).length,
      };
    });
    expect(found.rows, `${tab}/${id}: no rows were rendered`).toBeGreaterThan(0);
    expect(found.withRole, `${tab}/${id}: a <tr> carries a role, a label or a tab stop`).toBe(0);
    expect(found.wrong, `${tab}/${id}: rows without exactly one button, in the first cell`).toBe(0);
  }
});

test('Tab reaches a row, the whole row shows it, and Enter opens it', async ({ page }) => {
  await page.goto('/#daily');
  const p = panel(page, 'daily-hosts-attention');
  await expect(p.locator('[data-row-open]').first()).toBeAttached({ timeout: 20_000 });
  await tabToRowButton(page, p.getByRole('button', { name: 'Options: Hosts Needing Attention' }));

  const seen = await page.evaluate(() => {
    const row = document.activeElement!.closest('tr')!;
    const other = Array.from(row.parentElement!.children).find((r) => r !== row)!;
    return {
      label: document.activeElement!.getAttribute('aria-label'),
      ring: getComputedStyle(row).boxShadow,
      rest: getComputedStyle(other).boxShadow,
    };
  });
  expect(seen.label).toBe('View details for baseline-host-a');
  expect(seen.ring, 'the focused row paints no ring').not.toBe('none');
  expect(seen.rest, 'a row that is not focused paints a ring').toBe('none');

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#infra\?status=not-online/);
});

test('Space opens a row too', async ({ page }) => {
  await page.goto('/#daily');
  const p = panel(page, 'daily-top-capacity-risks');
  await expect(p.locator('[data-row-open]').first()).toBeAttached({ timeout: 20_000 });
  await tabToRowButton(page, p.getByRole('button', { name: 'Options: Top Capacity Risks' }));
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/#network\?subnet=/);
});

test('a mouse still opens a row from its first cell, and that cell stays the thing under the pointer', async ({ page }) => {
  await page.goto('/#assets');
  const first = panel(page, 'assets-list').locator('tbody tr').first().locator('td').first();
  await expect(first).toBeVisible({ timeout: 20_000 });

  // The button lies over this cell. If it took the pointer, the cell's own
  // tooltip would stop appearing and its text could not be selected.
  const under = await first.evaluate((td) => {
    const b = td.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return { inCell: !!hit && td.contains(hit), isButton: !!hit?.closest('[data-row-open]') };
  });
  expect(under.inCell, 'the point at the middle of the first cell is not in that cell').toBe(true);
  expect(under.isButton, "the row's button takes the pointer").toBe(false);

  await first.click();
  await expect(panel(page, 'assets-detail')).toBeVisible();
});
