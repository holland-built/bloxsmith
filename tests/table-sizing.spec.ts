import { test, expect } from './fixtures';

// Locks in the panel-sizing model: DataTable.jsx's measured column widths plus
// ui.jsx's content-driven grid span. Three invariants, checked for every <table>
// on every tab, at four viewport widths:
//
//  1. No table overflows its scroll wrapper (overflow-x-hidden means overflow
//     is invisibly clipped data, not just an ugly scrollbar).
//  2. A cell may only be visually clipped if its column opted into a ceiling
//     via an explicit inline max-width on the <th> (the maxCh mechanism).
//     A clipped cell in a column with NO max-width is the original bug:
//     truncated text while other columns waste space.
//  3. A panel is no wider than its own content needs. This one used to be
//     computed and only console.logged. It is now asserted — see below.
//
// WHY THIS RUNS AT FOUR WIDTHS. Before the content-driven span landed, `span={4}`
// meant 4-of-4 tracks below the xl breakpoint and 4-of-6 above it, so the Audit
// Log panel got NARROWER (976px -> 817px) when the window was widened from 1024
// to 1280, and started clipping. A single-width run cannot see that.

const TABS = ['overview', 'daily', 'network', 'dns', 'security', 'infra', 'incidents', 'audit'];

// The four widths the sizing model was measured against. 1024 is the md
// breakpoint (4 tracks), the rest are xl (6 tracks) with very different track
// widths, which is the unit invariant 3's budget is denominated in.
const WIDTHS = [1024, 1280, 1600, 1920];

// Every tab in TABS renders at least one <DataTable> (verified against
// ui/src/tabs/*.jsx). If a tab is ever found to legitimately have no tables
// under any conditions, name it here with a comment explaining why — do not
// let the whole suite pass on emptiness by default.
//
// NOT covered, stated rather than silently skipped: provision, selfservice,
// editor and drift render no <table> at all (zero DataTable references, zero
// raw tables), and ai has one that exists only after a user query. There is
// nothing on those tabs for these invariants to be true or false about.
const TABS_WITH_NO_TABLES = new Set<string>();

// Tolerance on invariant 3, and the honest reason there is one.
//
// This spec and DataTable.jsx compute "how much width does this content need"
// with two independent estimators. They are deliberately reconciled below (the
// per-column sort/badge/buffer allowances), and after that the tightest panel
// across a 94-panel sweep sat 12px inside its budget. The two will never agree
// exactly: this spec infers per-column padding from CSS classes while DataTable
// reads it from its own constants, and both round sub-pixel text metrics.
//
// 20px is CELL_PAD — one cell's horizontal padding, DataTable's own smallest
// unit of column width. Below that granularity a disagreement is measurement
// noise; above it, it is a layout change. It is not a cushion sized to make the
// check pass: a real regression here is hundreds of pixels. Confirmed by running
// this assertion against the pre-fix code, where Daily's "DNS Zone Issues"
// exceeded its budget by ~1,128px at 1920.
const ESTIMATOR_TOLERANCE = 20;

type Violation = {
  kind: 'overflow' | 'unbounded-clip' | 'panel-too-wide' | 'grid-not-found';
  panel: string;
  detail: string;
};

type TableReport = {
  panel: string;
  violations: Violation[];
  wastedWidth: number;
  budget: number;
};

// Runs inside the page. Measures every <table> reachable at call time and
// returns structured findings — never throws, never asserts (that happens
// in the test body so failures name tab + panel + numbers).
function measureTables(tolerance: number): TableReport[] {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  function measureText(text: string, font: string): number {
    ctx.font = font;
    return ctx.measureText(text || '').width;
  }

  function cardFor(table: Element): HTMLElement | null {
    let el: Element | null = table;
    while (el) {
      if (el.className && typeof el.className === 'string' && el.className.includes('bg-card')) return el as HTMLElement;
      el = el.parentElement;
    }
    return null;
  }

  const tables = Array.from(document.querySelectorAll('table'));
  const reports: TableReport[] = [];

  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    if (rows.length === 0) continue; // no data loaded yet — skip, don't fail

    const wrapper = table.parentElement;
    if (!wrapper) continue;

    const card = cardFor(table);
    const h2 = card?.querySelector('h2') as HTMLElement | null;
    const panel = h2?.textContent?.trim() || '(untitled panel)';
    const violations: Violation[] = [];

    // Invariant 1: wrapper never x-scrolls.
    const overflowPx = wrapper.scrollWidth - wrapper.clientWidth;
    if (overflowPx > 1) {
      violations.push({
        kind: 'overflow',
        panel,
        detail: `wrapper.scrollWidth=${wrapper.scrollWidth}px > clientWidth=${wrapper.clientWidth}px (overflow ${overflowPx}px)`,
      });
    }

    // --- the terms invariant 3's budget is built from -------------------------

    // (a) What the panel's HEADER demands, measured the same way ui.jsx's Card
    //     does: the title on one line plus the controls in `right`. A panel
    //     whose header is wider than its table is legitimately wider than its
    //     table — Overview's "Top Subnets by Utilization" carries a filter box,
    //     a site select and an Export button, and those set its width.
    let headFloor = 0;
    if (h2) {
      const headRow = h2.parentElement as HTMLElement;
      const gapH = parseFloat(getComputedStyle(headRow).columnGap) || 0;
      headFloor = Math.ceil(measureText(h2.textContent || '', getComputedStyle(h2).font));
      const kids = Array.from(headRow.children) as HTMLElement[];
      const rightEl = kids[kids.length - 1];
      if (rightEl && rightEl !== h2 && !rightEl.classList.contains('flex-1')) {
        headFloor += gapH + rightEl.scrollWidth;
      }
    }

    // (b) One grid track plus one gap: the span is the FEWEST whole tracks that
    //     cover the panel's need, so it can overshoot by strictly less than one
    //     track. Read from the live grid, never hardcoded — the track width is
    //     completely different at 1024 (4 tracks) and 1920 (6 tracks).
    let trackPlusGap = 0;
    if (card) {
      let item: HTMLElement | null = card;
      while (item && !item.parentElement?.hasAttribute('data-card-grid')) item = item.parentElement;
      const gridEl = item?.parentElement as HTMLElement | null;
      if (gridEl) {
        const ggs = getComputedStyle(gridEl);
        const tracks = ggs.gridTemplateColumns.split(' ').filter(Boolean);
        trackPlusGap = Math.ceil(parseFloat(tracks[0]) + (parseFloat(ggs.columnGap) || 0));
      }
    }
    // A missing grid makes the budget below STRICTER, so it can never turn a
    // real violation into a pass — but it would report a made-up 0px track and
    // blame the span logic for a measurement that never happened. Say which it
    // was instead. (Observed for real: running this spec against the pre-fix
    // ui.jsx, which has no data-card-grid marker, printed "one track+gap 0px".)
    if (trackPlusGap === 0) {
      violations.push({
        kind: 'grid-not-found',
        panel,
        detail:
          'could not find the enclosing [data-card-grid] to read a track width from, so the width budget below is ' +
          'missing its one-track term and any panel-too-wide result for this panel is unproven',
      });
    }

    // Per-column analysis (invariant 2 + the width accounting).
    const headCells = Array.from(table.querySelectorAll('thead th'));
    let wastedWidth = 0;
    let shortfall = 0;
    let needTotal = 0;

    headCells.forEach((th, colIndex) => {
      const label = (th.textContent || '').trim();
      const hasMaxWidth = !!(th as HTMLElement).style.maxWidth;
      const allotted = (th as HTMLElement).getBoundingClientRect().width;

      let neededWidth = measureText(label, getComputedStyle(th).font);

      // The cell font is a property of the column, not the row — read it once.
      // Reading it per cell forces a style recalc per cell and made this sweep
      // roughly 50x slower for the same answer.
      const probe = rows[0]?.children[colIndex] as HTMLElement | undefined;
      const probeInner = (probe?.firstElementChild as HTMLElement) || probe;
      const cellFont = probeInner ? getComputedStyle(probeInner).font : '';

      let anyClipped = false;
      let maxCellClipDetail = '';

      for (const tr of rows) {
        const td = tr.children[colIndex] as HTMLElement | undefined;
        if (!td) continue;
        const inner = (td.firstElementChild as HTMLElement) || td;
        const clientW = inner.clientWidth;
        const scrollW = inner.scrollWidth;
        if (scrollW > clientW + 1) {
          anyClipped = true;
          if (!hasMaxWidth) {
            maxCellClipDetail = `cell text="${(inner.textContent || '').trim().slice(0, 40)}" scrollWidth=${scrollW}px > clientWidth=${clientW}px`;
          }
        }
        const w = measureText((inner.textContent || '').trim(), cellFont);
        if (w > neededWidth) neededWidth = w;
      }

      // Reconcile with DataTable.jsx's own constants so "needed" here is the
      // same quantity it sizes the panel from, not a near-miss:
      //   CELL_PAD 20            px-2.5 on both sides of every th/td
      //   MEASURE_BUFFER 3       its sub-pixel rounding allowance
      //   SORT_AFFORDANCE_PAD 14 the ▲/▼ room on a sortable header (a <button>)
      //   BADGE_PAD 20           a status pill's own px-2.5
      neededWidth += 20 + 3;
      if (th.querySelector('button')) neededWidth += 14;
      if (rows.some((tr) => (tr.children[colIndex]?.firstElementChild as HTMLElement)?.className?.includes?.('rounded-full'))) {
        neededWidth += 20;
      }

      if (anyClipped && !hasMaxWidth) {
        violations.push({
          kind: 'unbounded-clip',
          panel,
          detail: `column "${label}" clipped with no explicit max-width opt-in (th has no inline max-width) — ${maxCellClipDetail}`,
        });
      }

      needTotal += neededWidth;
      wastedWidth += Math.max(0, allotted - neededWidth);
      shortfall += Math.max(0, neededWidth - allotted);
    });

    // Invariant 3. wastedWidth sums only the POSITIVE slack per column, so a
    // table with one squeezed column and one roomy one reports more slack than
    // the panel actually has spare — `shortfall` is that squeeze, added back so
    // both sides of the comparison are the same quantity.
    const budget = Math.max(0, headFloor - needTotal) + trackPlusGap + shortfall + tolerance;
    if (wastedWidth > budget) {
      violations.push({
        kind: 'panel-too-wide',
        panel,
        detail:
          `panel holds ${Math.round(wastedWidth)}px more width than its content needs, budget ${Math.round(budget)}px ` +
          `(header floor ${Math.round(headFloor)}px, content needs ${Math.round(needTotal)}px, ` +
          `one track+gap ${trackPlusGap}px, squeezed columns ${Math.round(shortfall)}px, tolerance ${tolerance}px). ` +
          `The panel's grid span is not following its content — see the CONTENT-DRIVEN PANEL WIDTH block in ui/src/components/ui.jsx`,
      });
    }

    reports.push({ panel, violations, wastedWidth: Math.round(wastedWidth), budget: Math.round(budget) });
  }

  return reports;
}

test.describe('table column sizing', () => {
  for (const tab of TABS) {
    test(`tab "#${tab}": tables fit their wrapper, clip only where opted in, and are no wider than their content`, async ({ page }) => {
      test.setTimeout(150_000);
      const allViolations: Violation[] = [];

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`/#${tab}`);
        await expect(page.locator('h1').first()).toBeVisible();

        // Data loads async and some panels take several seconds; poll until at
        // least one table has rows (or time out, in which case we simply have
        // nothing to measure on this tab — not a failure).
        await page
          .waitForFunction(() => Array.from(document.querySelectorAll('table')).some((t) => t.querySelectorAll('tbody tr').length > 0), {
            timeout: 15000,
          })
          .catch(() => {});

        // Let layout settle (fonts, async row updates, and the rAF the grid
        // schedules before it applies spans) after the poll succeeds.
        await page.waitForTimeout(500);

        const reports = await page.evaluate(measureTables, ESTIMATOR_TOLERANCE);

        // measureTables() only returns entries for tables that actually had
        // `tbody tr` rows at measurement time. If every panel on this tab
        // failed to load (dead feed, slow server, broken render), reports is
        // empty and the loop below iterates zero times — silently "passing"
        // without ever exercising the sizing invariants. Fail loudly instead.
        if (!TABS_WITH_NO_TABLES.has(tab)) {
          expect(
            reports.length,
            `#${tab} at ${width}px: expected at least one table with rows to be measured, found none — panels likely failed to load`,
          ).toBeGreaterThan(0);
        }

        for (const r of reports) {
          for (const v of r.violations) allViolations.push({ ...v, detail: `at ${width}px viewport: ${v.detail}` });
          // eslint-disable-next-line no-console
          console.log(`[table-sizing] ${width}px #${tab} :: "${r.panel}" spare width ${r.wastedWidth}px (budget ${r.budget}px)`);
        }
      }

      const message = allViolations
        .map((v) => `#${tab} :: panel "${v.panel}" :: [${v.kind}] ${v.detail}`)
        .join('\n');

      expect(allViolations, message || undefined).toEqual([]);
    });
  }
});
