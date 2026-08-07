import { test, expect } from './fixtures';

// Predicate P5 for the density switch, plus the one regression that would
// matter most if this feature went wrong.
//
// Every number below is a hand-written literal read off the running app at
// 1920x1080 on #assets before this spec was written — it is never recomputed
// from the app's own CSS variables, because a test that asks the code what it
// does can only ever agree with it:
//
//   comfortable   card padding 18px   th/td padding-y 8px   row offsetHeight 38px
//   compact       card padding 12px   th/td padding-y 4px   row offsetHeight 30px
//
// THE HORIZONTAL RULE. Density moves vertical spacing and grid gaps and nothing
// else. DataTable computes its column widths with a canvas measurer that
// hard-codes the cells' horizontal padding (CELL_PAD = 20, DataTable.jsx), so a
// density that shifted px-2.5 would leave the measurer sizing a table that no
// longer exists and bring back the column overflow the fit system was built to
// make impossible. Two assertions guard it: the cells' computed horizontal
// padding is identical in both densities, and no table's scroll wrapper
// x-overflows in either.

const VIEWPORT = { width: 1920, height: 1080 };

type Probe = {
  density: string | null;
  rowH: number | null;
  cardPadTop: string | null;
  cardPadLeft: string | null;
  cellPadY: string | null;
  cellPadX: string | null;
  wrappers: { sw: number; cw: number }[];
};

// Runs in the page. Reads the first DataTable on the tab and the Card that
// encloses it, plus every table's scroll wrapper.
function probe(): Probe {
  const table = document.querySelector('table');
  const row = table?.querySelector('tbody tr') as HTMLElement | null;
  const td = row?.querySelector('td') as HTMLElement | null;

  let card: HTMLElement | null = (table as HTMLElement | null) ?? null;
  while (card && !(typeof card.className === 'string' && card.className.includes('bg-card'))) {
    card = card.parentElement;
  }

  const cardCS = card ? getComputedStyle(card) : null;
  const tdCS = td ? getComputedStyle(td) : null;

  return {
    density: document.documentElement.dataset.density ?? null,
    rowH: row ? row.offsetHeight : null,
    cardPadTop: cardCS ? cardCS.paddingTop : null,
    cardPadLeft: cardCS ? cardCS.paddingLeft : null,
    cellPadY: tdCS ? `${tdCS.paddingTop}/${tdCS.paddingBottom}` : null,
    cellPadX: tdCS ? `${tdCS.paddingLeft}/${tdCS.paddingRight}` : null,
    wrappers: Array.from(document.querySelectorAll('table')).map((t) => {
      const w = t.parentElement as HTMLElement;
      return { sw: w.scrollWidth, cw: w.clientWidth };
    }),
  };
}

async function gotoAssets(page: import('@playwright/test').Page) {
  await page.setViewportSize(VIEWPORT);
  await page.goto('/#assets');
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('table')).some((t) => t.querySelectorAll('tbody tr').length > 0),
    { timeout: 20_000 },
  );
  // The grid applies its spans on a rAF and DataTable re-measures on a
  // ResizeObserver — let both settle before reading a width.
  await page.waitForTimeout(800);
}

test('compact shrinks rows and card padding, and comfortable restores both exactly', async ({ page }) => {
  test.setTimeout(90_000);
  await gotoAssets(page);

  const before = await page.evaluate(probe);
  expect(before.density).toBe('comfortable');
  expect(before.rowH).toBe(38);
  expect(before.cardPadTop).toBe('18px');
  expect(before.cellPadY).toBe('8px/8px');

  await page.getByRole('button', { name: 'Compact density' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await page.waitForTimeout(500);

  const compact = await page.evaluate(probe);
  expect(compact.rowH).toBe(30);
  expect(compact.cardPadTop).toBe('12px');
  expect(compact.cellPadY).toBe('4px/4px');
  // The predicate's own two clauses, stated as the comparisons they are rather
  // than only as the literals above.
  expect(compact.rowH!).toBeLessThan(before.rowH!);
  expect(parseFloat(compact.cardPadTop!)).toBeLessThan(18);

  await page.getByRole('button', { name: 'Comfortable density' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');
  await page.waitForTimeout(500);

  const restored = await page.evaluate(probe);
  expect(restored.rowH).toBe(before.rowH);
  expect(restored.cardPadTop).toBe(before.cardPadTop);
  expect(restored.cellPadY).toBe(before.cellPadY);
});

test('the density choice survives a page reload', async ({ page }) => {
  test.setTimeout(90_000);
  await gotoAssets(page);

  await page.getByRole('button', { name: 'Compact density' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  expect(await page.evaluate(() => localStorage.getItem('density'))).toBe('compact');

  await page.reload();
  // Asserted before waiting for any data: the density is applied by the bundle,
  // not by a component that has to mount and fetch first.
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');

  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('table')).some((t) => t.querySelectorAll('tbody tr').length > 0),
    { timeout: 20_000 },
  );
  await page.waitForTimeout(800);
  const after = await page.evaluate(probe);
  expect(after.rowH).toBe(30);
  expect(after.cardPadTop).toBe('12px');
});

test('no table x-overflows in either density, and cell horizontal padding never moves', async ({ page }) => {
  test.setTimeout(90_000);
  await gotoAssets(page);

  const comfortable = await page.evaluate(probe);
  expect(comfortable.wrappers.length).toBeGreaterThan(0);
  for (const w of comfortable.wrappers) {
    expect(w.sw, `comfortable: wrapper scrollWidth ${w.sw} > clientWidth ${w.cw}`).toBeLessThanOrEqual(w.cw);
  }

  await page.getByRole('button', { name: 'Compact density' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  // The DataTable re-measures on its ResizeObserver after the card's padding
  // changes the wrapper's width; read after that has landed, not before.
  await page.waitForTimeout(1000);

  const compact = await page.evaluate(probe);
  expect(compact.wrappers.length).toBe(comfortable.wrappers.length);
  for (const w of compact.wrappers) {
    expect(w.sw, `compact: wrapper scrollWidth ${w.sw} > clientWidth ${w.cw}`).toBeLessThanOrEqual(w.cw);
  }

  // The direct guard on CELL_PAD: 10px each side in both densities.
  expect(comfortable.cellPadX).toBe('10px/10px');
  expect(compact.cellPadX).toBe('10px/10px');
});

test('below lg the switch folds into the "…" sheet, exactly like the theme switch', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto('/#overview');

  const inHeader = page.locator('header').getByRole('button', { name: 'Compact density' });
  await expect(inHeader).toBeHidden();

  await page.getByRole('button', { name: 'Settings' }).click();
  const inSheet = page.getByRole('button', { name: 'Compact density' });
  await expect(inSheet).toBeVisible();
  await inSheet.click();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
});
