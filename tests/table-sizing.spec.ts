import { test, expect } from './fixtures';

// Locks in the table column-sizing fix (see ui/src/components/DataTable.jsx).
// Two invariants, checked for every <table> on every tab:
//
//  1. No table overflows its scroll wrapper (overflow-x-hidden means overflow
//     is invisibly clipped data, not just an ugly scrollbar).
//  2. A cell may only be visually clipped if its column opted into a ceiling
//     via an explicit inline max-width on the <th> (the maxCh mechanism).
//     A clipped cell in a column with NO max-width is the original bug:
//     truncated text while other columns waste space.
//
// Wasted width per table is logged (not asserted — live data varies) so a
// regression toward "too much dead space" is visible in CI output without
// being a hard failure.

const TABS = ['overview', 'daily', 'network', 'dns', 'security', 'infra', 'incidents', 'audit'];

// Every tab currently renders at least one <DataTable> (verified against
// ui/src/tabs/*.jsx). If a tab is ever found to legitimately have no tables
// under any conditions, name it here with a comment explaining why — do not
// let the whole suite pass on emptiness by default.
const TABS_WITH_NO_TABLES = new Set<string>();

type Violation = {
  kind: 'overflow' | 'unbounded-clip';
  panel: string;
  detail: string;
};

type TableReport = {
  panel: string;
  violations: Violation[];
  wastedWidth: number;
};

// Runs inside the page. Measures every <table> reachable at call time and
// returns structured findings — never throws, never asserts (that happens
// in the test body so failures name tab + panel + numbers).
function measureTables(): TableReport[] {
  function panelTitleFor(table: Element): string {
    let el: Element | null = table;
    while (el) {
      if (el.className && typeof el.className === 'string' && el.className.includes('bg-card')) {
        const h2 = el.querySelector('h2');
        if (h2 && h2.textContent) return h2.textContent.trim();
        break;
      }
      el = el.parentElement;
    }
    return '(untitled panel)';
  }

  function measureText(ctx: CanvasRenderingContext2D, text: string, font: string): number {
    ctx.font = font;
    return ctx.measureText(text || '').width;
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  const tables = Array.from(document.querySelectorAll('table'));
  const reports: TableReport[] = [];

  for (const table of tables) {
    const rows = table.querySelectorAll('tbody tr');
    if (rows.length === 0) continue; // no data loaded yet — skip, don't fail

    const wrapper = table.parentElement;
    if (!wrapper) continue;

    const panel = panelTitleFor(table);
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

    // Per-column analysis (invariant 2 + wasted width).
    const headCells = Array.from(table.querySelectorAll('thead th'));
    let wastedWidth = 0;

    headCells.forEach((th, colIndex) => {
      const label = (th.textContent || '').trim();
      const hasMaxWidth = !!(th as HTMLElement).style.maxWidth;
      const thRect = (th as HTMLElement).getBoundingClientRect();
      const allotted = thRect.width;

      const headFont = window.getComputedStyle(th).font;
      let neededWidth = measureText(ctx, label, headFont);

      let anyClipped = false;
      let maxCellClipDetail = '';

      for (const tr of Array.from(rows)) {
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
        const cellFont = window.getComputedStyle(inner).font;
        const text = (inner.textContent || '').trim();
        const w = measureText(ctx, text, cellFont);
        if (w > neededWidth) neededWidth = w;
      }

      // padding: px-2.5 = 10px each side = 20px horizontal, applied to both th and td.
      neededWidth += 20;

      if (anyClipped && !hasMaxWidth) {
        violations.push({
          kind: 'unbounded-clip',
          panel,
          detail: `column "${label}" clipped with no explicit max-width opt-in (th has no inline max-width) — ${maxCellClipDetail}`,
        });
      }

      const waste = Math.max(0, allotted - neededWidth);
      wastedWidth += waste;
    });

    reports.push({ panel, violations, wastedWidth: Math.round(wastedWidth) });
  }

  return reports;
}

test.describe('table column sizing', () => {
  for (const tab of TABS) {
    test(`tab "#${tab}": tables neither overflow their wrapper nor clip unbounded columns`, async ({ page }) => {
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

      // Let layout settle (fonts, async row updates) after the poll succeeds.
      await page.waitForTimeout(300);

      const reports = await page.evaluate(measureTables);

      // measureTables() only returns entries for tables that actually had
      // `tbody tr` rows at measurement time. If every panel on this tab
      // failed to load (dead feed, slow server, broken render), reports is
      // empty and the loop below iterates zero times — silently "passing"
      // without ever exercising the sizing invariants. Fail loudly instead.
      if (!TABS_WITH_NO_TABLES.has(tab)) {
        expect(
          reports.length,
          `#${tab}: expected at least one table with rows to be measured, found none — panels likely failed to load`,
        ).toBeGreaterThan(0);
      }

      const allViolations: Violation[] = [];
      for (const r of reports) {
        allViolations.push(...r.violations);
        // eslint-disable-next-line no-console
        console.log(`[table-sizing] #${tab} :: "${r.panel}" wasted width ≈ ${r.wastedWidth}px`);
      }

      const message = allViolations
        .map((v) => `#${tab} :: panel "${v.panel}" :: [${v.kind}] ${v.detail}`)
        .join('\n');

      expect(allViolations, message || undefined).toEqual([]);
    });
  }
});
