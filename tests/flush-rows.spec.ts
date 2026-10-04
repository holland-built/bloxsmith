import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';
import { openPanelMenu } from './layout-helpers';

// Every /api/ response is faked from tests/page-fixtures.ts.
//
// EVERY ROW OF PANELS ENDS AT THE GRID'S RIGHT EDGE.
//
// Until 2026-10-04 a panel holding a table took the fewest tracks that covered
// its content and never one more, so a table that needed four of six tracks
// left two empty beside it. Measured on the live estate at 1580px wide: 20 rows
// ended short across Overview, Security, Infra, Incidents, Network and DNS. The
// owner was shown three live variants and chose flush rows, tables included.
//
// The rule for who is handed a row's spare tracks is a pure function with its
// own unit tests (fillRows, ui/src/lib/layout.test.js). This file is the other
// half: that the browser's grid ends up where that function says, on the real
// pages, at every breakpoint. tests/table-sizing.spec.ts leans on it — its
// width budget trusts each panel's `data-grown`, and what makes that number
// trustworthy is asserted here.
//
// Nothing in the baseline world is operator-sized (no saved views), so no row
// has a reason to end short. A panel the operator sized is never grown; that
// case is the resize test in tests/layout-drag.spec.ts, where a panel dragged
// to four tracks must still be four after a reload.
test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

// Every tab that lays its panels out in a CardGrid and holds a table, plus
// Changes, whose lead panel is a list of its own.
const TABS = ['overview', 'daily', 'network', 'dns', 'security', 'infra', 'incidents', 'audit', 'assets', 'changes'];

// 390 is the two-track grid, 1024 the four-track one, the rest six tracks at
// three different track widths.
const WIDTHS = [390, 1024, 1280, 1600, 1920];

type Row = { panels: string[]; spans: number; shortBy: number };
type GridReport = { tracks: number; rows: Row[] };

// Runs in the page. Rows are read from where the browser PUT the panels (their
// top edge), never recomputed from spans, so this cannot agree with the layout
// code by sharing its arithmetic.
function readRows(): GridReport[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-card-grid]')).map((grid) => {
    const gr = grid.getBoundingClientRect();
    const tracks = parseInt(getComputedStyle(grid).getPropertyValue('--grid-tracks'), 10);
    const byTop = new Map<number, HTMLElement[]>();
    for (const el of Array.from(grid.children) as HTMLElement[]) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const top = Math.round(r.top);
      byTop.set(top, [...(byTop.get(top) ?? []), el]);
    }
    const rows = Array.from(byTop.values()).map((els) => ({
      panels: els.map(
        (el) => el.getAttribute('data-panel-id') || el.querySelector('[data-panel-id]')?.getAttribute('data-panel-id') || '(unnamed)',
      ),
      spans: els.reduce((n, el) => n + (parseInt(/span (\d+)/.exec(getComputedStyle(el).gridColumnEnd)?.[1] ?? '1', 10) || 1), 0),
      shortBy: Math.round(gr.right - Math.max(...els.map((el) => el.getBoundingClientRect().right))),
    }));
    return { tracks, rows };
  });
}

for (const tab of TABS) {
  test(`#${tab}: every row of panels ends flush with the grid`, async ({ page }) => {
    test.setTimeout(150_000);
    const short: string[] = [];
    let measured = 0;

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/#${tab}`);
      await expect(page.locator('h1').first()).toBeVisible();
      await expect(page.locator('[data-card-grid] [data-panel-id]').first()).toBeVisible({ timeout: 20_000 });
      // Tables measure themselves once their rows arrive, and the grid applies
      // spans on the frame after that. Same settle as table-sizing.spec.ts.
      // Changes draws its list as a grid of divs (role="table"), so there is
      // no <table> to wait for there and the wait would only run out its clock.
      if (tab !== 'changes') {
        await page
          .waitForFunction(() => Array.from(document.querySelectorAll('table')).some((t) => t.querySelectorAll('tbody tr').length > 0), {
            timeout: 15_000,
          })
          .catch(() => {});
      }
      await page.waitForTimeout(500);

      for (const grid of await page.evaluate(readRows)) {
        for (const row of grid.rows) {
          measured++;
          // Two ways to say the same thing, and both are checked: the pixels
          // (the last panel's right edge is the grid's) and the tracks (the
          // row's spans add up to the grid's track count, never more, which is
          // what an implicit column would look like).
          if (row.shortBy > 1 || row.spans !== grid.tracks) {
            short.push(
              `at ${width}px: row [${row.panels.join(', ')}] ends ${row.shortBy}px short, ` +
                `spans add up to ${row.spans} of ${grid.tracks} tracks`,
            );
          }
        }
      }
    }

    // A tab whose grid never rendered would pass on emptiness.
    expect(measured, `#${tab}: no rows of panels were measured at any width`).toBeGreaterThan(0);
    expect(short, short.join('\n') || undefined).toEqual([]);
  });
}

// Which panels share a row also changes with NO measurement: a tile taken off
// the page, a panel dragged elsewhere. Host Status holds no table, so nothing
// re-measures when it goes; the rows have to be refilled because the grid
// changed, not because a table reported in.
//
// This pins the behaviour. It does not single out the re-run in CardGrid's
// layout effect: with that effect removed this test still passed, because
// hiding a panel changes the grid's height and the grid's ResizeObserver
// re-runs the layout for that.
test('taking a panel off the page refills the rows it leaves behind', async ({ page, request }) => {
  const view = '/api/views/__layout_overview';
  await request.delete(view);
  try {
    await page.setViewportSize({ width: 1920, height: 2400 });
    await page.goto('/#overview');
    await expect(page.locator('[data-card-grid] [data-panel-id]')).toHaveCount(7, { timeout: 20_000 });
    await page.waitForTimeout(1200);
    const shortRows = async () =>
      (await page.evaluate(readRows)).flatMap((g) => g.rows.filter((r) => r.shortBy > 1 || r.spans !== g.tracks).map((r) => r.panels.join(', ')));
    expect(await shortRows(), 'the page should start with every row flush').toEqual([]);

    await openPanelMenu(page, 'host-status');
    await page.locator('[data-panel-id="host-status"] [data-layout-hide]').click();
    await expect(page.locator('[data-card-grid] [data-panel-id]')).toHaveCount(6);
    await page.waitForTimeout(600);
    expect(await shortRows()).toEqual([]);
  } finally {
    await request.delete(view);
  }
});

// The row of number tiles above the panels follows the same rule, by a
// different mechanism: a column count chosen from how many tiles there are
// (TILE_COLS, ui/src/components/kit.jsx). Assets has two tiles and two had no
// entry, so they sat in a four-column row at 1024 and a six-column row at 1920
// with the rest of the row empty. The other four pages are here so the rule is
// asserted for every tile row, not only the one that was broken.
for (const tab of ['overview', 'network', 'dns', 'infra', 'assets']) {
  test(`#${tab}: every row of number tiles is a full row`, async ({ page }) => {
    const short: string[] = [];
    for (const width of [390, 1024, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/#${tab}`);
      const strip = page.getByRole('list', { name: 'Headline numbers' });
      await expect(strip).toBeVisible({ timeout: 20_000 });
      const rows = await strip.evaluate((ul) => {
        const edge = ul.getBoundingClientRect().right;
        const byTop = new Map<number, number>();
        for (const li of Array.from(ul.children)) {
          const r = li.getBoundingClientRect();
          const top = Math.round(r.top);
          byTop.set(top, Math.max(byTop.get(top) ?? 0, r.right));
        }
        return Array.from(byTop.values()).map((right) => Math.round(edge - right));
      });
      expect(rows.length, `#${tab} at ${width}px: no tiles were measured`).toBeGreaterThan(0);
      rows.forEach((shortBy, i) => {
        if (shortBy > 1) short.push(`at ${width}px: tile row ${i + 1} ends ${shortBy}px short`);
      });
    }
    expect(short, short.join('\n') || undefined).toEqual([]);
  });
}

