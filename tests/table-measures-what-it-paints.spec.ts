import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// DataTable computes explicit px column widths from canvas measureText and
// renders table-fixed. That is only correct while the thing it MEASURES and the
// thing it PAINTS are the same thing. Twice they were not, and both defects are
// invisible to tests/table-sizing.spec.ts because that spec re-derives widths
// with the same wrong assumptions the component held:
//
//   1. Headers carry `uppercase` and `tracking-wide`, and the
//      getComputedStyle().font SHORTHAND carries NEITHER text-transform NOR
//      letter-spacing. So "Status" was measured in mixed case with no tracking
//      while "STATUS" was painted — 10.4px short, which clipped it to "STAT…"
//      in Host Health and DFP Services.
//   2. A badge cell paints its text at text-note (11px) inside a text-copy
//      (14px) cell, and was measured at 14px. Sixteen pill cells across eight
//      tabs were over-measured by 1–26px each, which is dead space by
//      construction — the same defect the `render` column measurement was
//      introduced to fix, in the same file, on a different path.
//
// Both assertions below were run against the defect before the fix existed:
// the first failed on 2 of 95 headers, the second on the Jobs status column
// (112px against a 100px need) and six others.

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

const TABS = ['overview', 'daily', 'network', 'dns', 'security', 'infra', 'incidents', 'audit'];

// DataTable's own constants. Named here rather than imported because the point
// is to check the component against the DOM, not against itself.
const CELL_PAD = 20;
const BADGE_PAD = 20;
const MEASURE_BUFFER = 3;
const SORT_AFFORDANCE_PAD = 14;

// Slack allowed above a column's painted need. One MEASURE_BUFFER plus a pixel
// of sub-pixel rounding in each of two independent estimators.
const DEAD_SPACE_TOLERANCE = MEASURE_BUFFER + 2;

type Finding = { tab: string; panel: string; col: number; label: string; width: number; need: number };

test('every table header shows its own label without clipping', async ({ page }) => {
  const clipped: Finding[] = [];
  for (const tab of TABS) {
    await page.goto(`/#${tab}`);
    await page.waitForTimeout(1000);
    const res = await page.evaluate((tabName) => {
      const out: any[] = [];
      document.querySelectorAll('table').forEach((table, ti) => {
        const panel = table.closest('[data-panel-id]')?.getAttribute('data-panel-id') || `table-${ti}`;
        table.querySelectorAll('thead th').forEach((th, ci) => {
          const el = th as HTMLElement;
          // scrollWidth > clientWidth is the browser reporting that the
          // ellipsis is doing work: the painted glyphs do not fit the box.
          if (el.scrollWidth > el.clientWidth + 1) {
            out.push({
              tab: tabName, panel, col: ci,
              label: (th.textContent || '').trim(),
              width: el.clientWidth, need: el.scrollWidth,
            });
          }
        });
      });
      return out;
    }, tab);
    clipped.push(...res);
  }

  expect(
    clipped,
    `Headers clipped by their own column:\n${clipped
      .map((c) => `  ${c.tab}/${c.panel} col${c.col} "${c.label}" has ${c.width}px, needs ${c.need}px`)
      .join('\n')}`,
  ).toEqual([]);
});

test('a pill column is no wider than the pill it paints', async ({ page }) => {
  const fat: Finding[] = [];
  // How many badge columns were actually examined. Without this the spec passes
  // on an empty inventory: rename data-col-kind, or let colKind() classify a
  // badge column as something else, and every assertion below becomes vacuous.
  // That is the same shape as the earlier test that passed against the defect
  // it was written for, so it is counted rather than assumed.
  let examined = 0;
  for (const tab of TABS) {
    await page.goto(`/#${tab}`);
    await page.waitForTimeout(1000);
    const res = await page.evaluate(
      ({ tabName, CELL_PAD, BADGE_PAD, MEASURE_BUFFER, SORT_AFFORDANCE_PAD, DEAD_SPACE_TOLERANCE }) => {
        const out: any[] = [];
        let seen = 0;
        const ctx = document.createElement('canvas').getContext('2d')!;
        const measure = (text: string, font: string, spacing: number) => {
          ctx.font = font;
          if ('letterSpacing' in ctx) {
            (ctx as any).letterSpacing = `${spacing || 0}px`;
            return ctx.measureText(text).width;
          }
          return ctx.measureText(text).width + (spacing || 0) * text.length;
        };

        document.querySelectorAll('table').forEach((table, ti) => {
          const panel = table.closest('[data-panel-id]')?.getAttribute('data-panel-id') || `table-${ti}`;
          const ths = Array.from(table.querySelectorAll('thead th'));
          const rows = Array.from(table.querySelectorAll('tbody tr'));
          if (rows.length === 0) return;

          ths.forEach((th, ci) => {
            // ONLY `badge: true` columns, read from data-col-kind. A `render`
            // column can emit the identical pill markup (Overview's subnet
            // table does) but is eligible for the grow set, so it may be wider
            // than its content on purpose and this bound does not apply to it.
            if (th.getAttribute('data-col-kind') !== 'badge') return;
            const cells = rows.map((tr) => tr.children[ci]).filter(Boolean) as HTMLElement[];
            if (cells.length === 0) return;
            const pills = cells
              .map((td) => {
                const span = td.querySelector(':scope > span');
                if (!span) return null;
                return { span, pcs: getComputedStyle(span) };
              })
              .filter(Boolean) as any[];
            if (pills.length !== cells.length) return;

            // What the header actually paints.
            const hcs = getComputedStyle(th);
            const raw = (th.textContent || '').trim();
            const painted = hcs.textTransform === 'uppercase' ? raw.toUpperCase() : raw;
            const sortable = !!th.querySelector('button') || (th.getAttribute('aria-sort') !== null);
            const headNeed =
              measure(painted, hcs.font, parseFloat(hcs.letterSpacing) || 0) +
              (sortable ? SORT_AFFORDANCE_PAD : 0);

            // What the widest pill actually paints.
            let pillNeed = 0;
            for (const p of pills) {
              const w = measure((p.span.textContent || '').trim(), p.pcs.font, parseFloat(p.pcs.letterSpacing) || 0);
              if (w > pillNeed) pillNeed = w;
            }
            pillNeed += BADGE_PAD;

            const need = Math.ceil(Math.max(headNeed, pillNeed) + CELL_PAD + MEASURE_BUFFER);
            const width = (th as HTMLElement).getBoundingClientRect().width;
            // Upper bound only. A column may legitimately be NARROWER than its
            // natural width (DataTable shrinks toward a floor when the card is
            // too small and marks the clip); it may never be wider, because a
            // badge column is never in the grow set.
            seen++;
            if (width > need + DEAD_SPACE_TOLERANCE) {
              out.push({ tab: tabName, panel, col: ci, label: raw, width: Math.round(width), need });
            }
          });
        });
        return { out, seen };
      },
      { tabName: tab, CELL_PAD, BADGE_PAD, MEASURE_BUFFER, SORT_AFFORDANCE_PAD, DEAD_SPACE_TOLERANCE },
    );
    fat.push(...res.out);
    examined += res.seen;
  }

  // COUNTED, not guessed: across the tabs above there are exactly three
  // `badge: true` columns, all on Infra — Host Health, DFP Services and Jobs.
  // Infra's host-inventory status column declares badge AND render and is
  // correctly reported as `render`, which is why it is not a fourth. Three is
  // the floor rather than a target, so removing one panel does not fail this,
  // but the classification silently breaking does.
  expect(
    examined,
    'no badge columns were found to measure — data-col-kind is missing, or colKind() no longer reports "badge"',
  ).toBeGreaterThanOrEqual(3);

  expect(
    fat,
    `Pill columns wider than the pill they paint (measured at the body font, not the pill's):\n${fat
      .map((f) => `  ${f.tab}/${f.panel} col${f.col} "${f.label}" is ${f.width}px, needs ${f.need}px`)
      .join('\n')}`,
  ).toEqual([]);
});
