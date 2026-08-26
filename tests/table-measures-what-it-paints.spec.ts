import fs from 'node:fs';
import path from 'node:path';
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
//
// THE TWO TESTS ADDED AT THE BOTTOM WERE PUT THROUGH THE SAME PROOF, because a
// guard nobody has watched fail is a guess. Each defect was injected into
// DataTable.jsx on its own, the suite run, and the tree restored:
//
//   pill px-2.5 -> px-3      the padding test fails, naming the pill. BOTH
//                            tests above PASS — that is the silent agreement
//                            this change exists to end, reproduced.
//   th/td px-2.5 -> px-3     the padding test fails, naming th and td.
//   sort gap-1 -> gap-3      the affordance test fails: 20.83px painted
//                            against the 14px reserved. The healthy figure is
//                            12.83px (4px gap + an 8.83px glyph), so the
//                            allowance clears what it pays for by 1.17px.
//   CELL_PAD 20 -> 22        the padding test fails, reporting "paints 10px +
//                            10px, the measurer adds 22". This is what proves
//                            the constants are READ rather than coincidentally
//                            equal to the literals they replaced.
//   BADGE_PAD renamed        the file refuses to load: "expected exactly one
//                            top-level const BADGE_PAD ... found 0". A rename
//                            cannot leave a stale number behind.
//   MEASURE_BUFFER 3 -> 8    the slack test fails, naming both numbers. The
//                            other four tests PASS, and that is worth reading
//                            twice: the pill bound lands exactly on its own
//                            boundary here (every column gains 5px, the
//                            tolerance grants 5), so it does not catch this and
//                            was never going to. The buffer needed an assertion
//                            of its own, and this is how that was found out.
//
// One case is NOT reachable and is recorded so nobody goes looking: a second
// top-level `const BADGE_PAD` never reaches the spec, because a duplicate const
// fails the Vite build first. The "found 0" branch is the one that earns its
// place; "found 2" is there for a declaration this parser cannot see coming.

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

const TABS = ['overview', 'daily', 'network', 'dns', 'security', 'infra', 'incidents', 'audit'];

// DataTable's own constants, READ OUT OF THE COMPONENT rather than copied.
//
// They used to be four literals here, under a comment saying they were named
// rather than imported "because the point is to check the component against the
// DOM, not against itself". The comment described an intention the code did not
// carry out: nothing below checked a constant against the DOM at all, so the
// four literals only ever restated the component's assumptions back to it.
// That is the exact failure this file's own header accuses table-sizing.spec.ts
// of. Changing the pill from px-2.5 to px-3 moved the paint, left both the
// component and its guard on 20, and they agreed silently.
//
// Two changes fix it, and both are needed. This block makes the component the
// single source, so a constant that moves moves here too. The new test at the
// bottom of the file makes the PAINTED DOM the judge of whether that number is
// right, which is the half that a copy could never do.
//
// Imported would be better than parsed, and is not available: DataTable.jsx is
// a React component module, so importing it into a Playwright spec pulls React
// and the whole component tree into a Node process that has no DOM. Reading the
// source text is already this repo's idiom for the same reason
// (ui/src/lib/typeScale.test.js, arrangeNames.test.js).
const COMPONENT_REL = 'ui/src/components/DataTable.jsx';

// This file's own location first, because it is the only fact that does not
// move: the spec lives in <root>/tests/, so the component is one level up.
// Walking from process.cwd() is the fallback, and it is a fallback rather than
// the method because cwd is a property of how the runner was launched, not of
// where the checkout is.
function componentPath(): string {
  const beside = path.resolve(__dirname, '..', COMPONENT_REL);
  if (fs.existsSync(beside)) return beside;
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const here = path.join(dir, COMPONENT_REL);
    if (fs.existsSync(here)) return here;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`could not locate ${COMPONENT_REL} beside ${__dirname} or above ${process.cwd()}`);
}

// Comments are stripped BEFORE the search rather than excluded by the pattern.
// `^const NAME = <number>` anchors to column zero, and a line inside a /* */
// block sits at column zero as readily as a real declaration does — so a stale
// value parked in a comment could satisfy the regex after the live constant had
// been renamed, which is exactly the stale read this whole change removes.
// Strings are left alone: a `const NAME = <number>` cannot occur inside one and
// still be at column zero without the quote character preceding it.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const DATA_TABLE_SRC = stripComments(fs.readFileSync(componentPath(), 'utf8'));

// Anchored to a TOP-LEVEL `const NAME = <number>` at the start of a line, and
// required to match exactly once. An unanchored search would happily read a
// second declaration added later or a same-named local inside a function, and
// go on reporting a stale number with no signal at all.
function constFromSource(name: string): number {
  const hits = [...DATA_TABLE_SRC.matchAll(new RegExp(`^const ${name} = (-?[0-9.]+)\\b`, 'gm'))];
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one top-level "const ${name} = <number>" in ${COMPONENT_REL}, found ${hits.length}`,
    );
  }
  return Number(hits[0][1]);
}

// Three of the four are read and USED, because each one is independently
// checked against something the browser painted further down.
const CELL_PAD = constFromSource('CELL_PAD');
const BADGE_PAD = constFromSource('BADGE_PAD');
const SORT_AFFORDANCE_PAD = constFromSource('SORT_AFFORDANCE_PAD');

// MEASURE_BUFFER IS READ ONLY TO BE JUDGED, and never used to compute an
// expectation. That distinction is the whole of it, and it was learned by
// getting it wrong first.
//
// The buffer is slack for measureText() sub-pixel rounding. It paints nothing,
// so unlike the other three there is no box to compare it to. The first version
// of this change read it from source and fed it into `need` below, exactly as
// the old copied literal had been. That looks harmless and is not: `need` is
// the number a column's width is compared AGAINST, so the buffer appeared on
// both sides of the comparison and cancelled itself. Raising it in the
// component widened every column and widened the expectation by the same
// amount, and the test went on passing.
//
// Measured, because the first attempt at this fix was reasoned about instead:
// MEASURE_BUFFER 3 -> 8 passes all four tests when the buffer is read into
// `need`, whether the dead-space tolerance is derived from it or pinned. The
// tolerance was never the mechanism. Feeding the component's own number into
// the expectation was.
//
// So the slack this suite is willing to grant is written here, by hand, and the
// component's constant is compared to it rather than substituted for it.
const ALLOWED_MEASURE_SLACK = 3;
const MEASURE_BUFFER_IN_COMPONENT = constFromSource('MEASURE_BUFFER');

// Slack allowed above a column's painted need: the sub-pixel allowance above
// plus a pixel of rounding in each of two independent estimators. Pinned for
// the same reason ALLOWED_MEASURE_SLACK is — a ceiling that rises with the
// thing it bounds is not a ceiling.
const DEAD_SPACE_TOLERANCE = ALLOWED_MEASURE_SLACK + 2;

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
      ({ tabName, CELL_PAD, BADGE_PAD, ALLOWED_MEASURE_SLACK, SORT_AFFORDANCE_PAD, DEAD_SPACE_TOLERANCE }) => {
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

            const need = Math.ceil(Math.max(headNeed, pillNeed) + CELL_PAD + ALLOWED_MEASURE_SLACK);
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
      { tabName: tab, CELL_PAD, BADGE_PAD, ALLOWED_MEASURE_SLACK, SORT_AFFORDANCE_PAD, DEAD_SPACE_TOLERANCE },
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

// ---------------------------------------------------------------------------
// THE CONSTANTS ABOVE, JUDGED BY THE PAINT.
//
// Reading them out of the component makes them one number instead of two. It
// does not make them the RIGHT number: component and spec would still agree
// while both were wrong about what the browser draws. These two tests are the
// half that closes that, and they are the only place in the suite where the
// canvas measurer's inputs are checked against a rendered box.
//
// CELL_PAD had a partial guard already — tests/density.spec.ts reads a td's
// computed paddingLeft/Right and asserts 10px/10px in both densities. That
// covers the td and not the th, and covers neither BADGE_PAD nor
// SORT_AFFORDANCE_PAD. Nothing is deleted there; this widens the same idea to
// every constant the measurer adds, and to both element kinds.
//
// MEASURE_BUFFER is not compared to a box, because it is not one — it is slack
// for measureText() sub-pixel rounding and corresponds to no padding and no
// glyph. It is not therefore unguarded. The first test below asserts it against
// ALLOWED_MEASURE_SLACK, the budget this suite grants by hand, and because that
// budget is written here rather than read from the component, raising the
// buffer moves one side of the comparison only.
// ---------------------------------------------------------------------------

test('the measurer takes no more sub-pixel slack than the suite grants it', () => {
  // A ceiling, not an equality: shrinking the buffer is an improvement and must
  // not fail the build. Growing it is a decision, and it should have to be made
  // here, visibly, rather than absorbed by a test that widened to fit.
  //
  // This is the only one of the four constants with no painted counterpart, so
  // it is also the only one whose guard is a stated budget rather than a
  // measurement. Saying so is the point of giving it its own test instead of
  // leaving it inside another one's arithmetic, which is where it hid before.
  expect(
    MEASURE_BUFFER_IN_COMPONENT,
    `DataTable's MEASURE_BUFFER is ${MEASURE_BUFFER_IN_COMPONENT}px; this suite budgets ${ALLOWED_MEASURE_SLACK}px of sub-pixel slack per column. Raising the buffer widens every column, so raise ALLOWED_MEASURE_SLACK here in the same change if that is intended`,
  ).toBeLessThanOrEqual(ALLOWED_MEASURE_SLACK);
});

type PadFinding = { tab: string; kind: string; panel: string; got: string; want: number };

test('the padding the measurer adds is the padding the table paints', async ({ page }) => {
  const wrong: PadFinding[] = [];
  // Per CATEGORY, not one total. A single counter lets a category vanish and
  // still pass, because another category supplies the count — the same vacuous
  // shape as an absence-only assertion. Each of these three must be non-zero on
  // its own, and the th/td pair must be non-zero on every tab.
  const seen = { th: 0, td: 0, pill: 0, badgeCell: 0 };
  const perTab: Record<string, { th: number; td: number }> = {};

  for (const tab of TABS) {
    await page.goto(`/#${tab}`);
    await page.waitForTimeout(1000);
    const res = await page.evaluate(
      ({ tabName, CELL_PAD, BADGE_PAD }) => {
        const out: any[] = [];
        const counts = { th: 0, td: 0, pill: 0, badgeCell: 0 };
        // Horizontal only. The vertical padding is py-[var(--sp-cell-y)] and IS
        // density-driven on purpose; the canvas measurer never adds it, so it
        // is none of this test's business.
        const hpad = (el: Element) => {
          const cs = getComputedStyle(el);
          return { l: parseFloat(cs.paddingLeft), r: parseFloat(cs.paddingRight) };
        };
        const check = (el: Element, kind: string, panel: string, want: number) => {
          const { l, r } = hpad(el);
          if (l + r !== want) out.push({ tab: tabName, kind, panel, got: `${l}px + ${r}px`, want });
        };

        document.querySelectorAll('table').forEach((table, ti) => {
          const panel = table.closest('[data-panel-id]')?.getAttribute('data-panel-id') || `table-${ti}`;
          // Column index -> what DataTable thinks the column is. The kind lives
          // on the th, so a body cell's kind is its th's.
          const kinds = Array.from(table.querySelectorAll('thead th')).map((th) =>
            th.getAttribute('data-col-kind'),
          );
          table.querySelectorAll('thead th').forEach((th) => {
            counts.th++;
            check(th, 'th', panel, CELL_PAD);
          });
          Array.from(table.querySelectorAll('tbody tr')).forEach((tr) => {
            Array.from(tr.children).forEach((td, ci) => {
              counts.td++;
              check(td, 'td', panel, CELL_PAD);
              // ONLY a `badge: true` column, and the restriction is load-bearing
              // rather than tidiness. BADGE_PAD is added on exactly one code
              // path — the one that measures a badge cell's text with a canvas
              // and has no box to read the pill's padding from. A `render`
              // column emits the identical pill markup (Daily's capacity-risks
              // and zone-issues tables both do, at px-2 rather than px-2.5) and
              // is measured a different way entirely: it clones the cell's
              // children into a zero-padding probe row and reads
              // getBoundingClientRect().width, so the pill's own padding is
              // already inside the number and BADGE_PAD is never added to it.
              // Checking those four spans against BADGE_PAD reports a defect
              // that does not exist — it did, on the first run of this test.
              if (kinds[ci] !== 'badge') return;
              // Counted as ELIGIBLE before the span is looked for, so a badge
              // cell that stops painting a pill is a discrepancy rather than a
              // silent skip. DataTable's badge branch always emits the span
              // (it falls back to an em dash for an empty value), so these two
              // counts are asserted EQUAL below, not merely non-zero.
              counts.badgeCell++;
              const span = td.querySelector(':scope > span');
              if (span) {
                counts.pill++;
                check(span, 'pill', panel, BADGE_PAD);
              }
            });
          });
        });
        return { out, counts };
      },
      { tabName: tab, CELL_PAD, BADGE_PAD },
    );
    wrong.push(...res.out);
    seen.th += res.counts.th;
    seen.td += res.counts.td;
    seen.pill += res.counts.pill;
    seen.badgeCell += res.counts.badgeCell;
    perTab[tab] = { th: res.counts.th, td: res.counts.td };
  }

  expect(seen.th, 'no table headers were found to measure').toBeGreaterThan(0);
  expect(seen.td, 'no table body cells were found to measure').toBeGreaterThan(0);
  expect(
    seen.badgeCell,
    'no badge-column body cells were found — data-col-kind is gone, or colKind() no longer reports "badge", so BADGE_PAD is unguarded',
  ).toBeGreaterThan(0);
  // EQUALITY, not "greater than zero". A single surviving pill anywhere would
  // satisfy a non-zero check while every other badge cell had quietly stopped
  // painting one, and each of those unpainted cells is a cell whose width the
  // measurer still reserves BADGE_PAD for.
  expect(
    seen.pill,
    `${seen.badgeCell} badge cells were found but only ${seen.pill} painted a pill span — the rest are measured with BADGE_PAD and paint nothing that carries it`,
  ).toBe(seen.badgeCell);
  const emptyTabs = TABS.filter((t) => perTab[t].th === 0 || perTab[t].td === 0);
  expect(emptyTabs, `tabs that rendered no populated table at all: ${emptyTabs.join(', ')}`).toEqual([]);

  expect(
    wrong,
    `Painted horizontal padding disagrees with the constant the measurer adds:\n${wrong
      .map((w) => `  ${w.tab}/${w.panel} ${w.kind} paints ${w.got}, the measurer adds ${w.want}`)
      .join('\n')}`,
  ).toEqual([]);
});

test('the sort affordance allowance covers the indicator a sorted header paints', async ({ page }) => {
  // SORT_AFFORDANCE_PAD is the one constant of the four that is NOT a box.
  // CELL_PAD and BADGE_PAD are padding and can be asserted equal to it. This is
  // a hand-chosen allowance, and the header it is added to is measured from the
  // label ALONE — DataTable measures `c.label`, never the th's textContent — so
  // the allowance is the only room the ▲/▼ ever gets.
  //
  // Hence a LOWER bound, and deliberately no upper one. Below the painted
  // affordance the glyph has nowhere to go and the header clips, which is a
  // defect. Above it the column carries dead space, which is already bounded by
  // DEAD_SPACE_TOLERANCE in the pill test above. Inventing a second, tighter
  // upper bound here would mean picking a number off one run on one machine and
  // calling it a contract; it would be font-dependent and would fail on CI's
  // fonts rather than on any defect.
  //
  // BOTH DIRECTIONS ARE EXERCISED, and the GLYPHS are collected rather than the
  // directions alone. ▲ and ▼ are different characters and need not be the same
  // width, so "aria-sort changed twice" is not evidence that both were seen —
  // an indicator rendering the same character in both states would satisfy a
  // direction counter while leaving one of the two widths unmeasured. The set
  // below is asserted to hold two distinct characters.
  //
  // The span paints only while its column is the active sort — an inactive
  // header shows an EMPTY span — so measuring the table as it loads would
  // measure the gap and nothing else.
  //
  // KNOWN HEADROOM, recorded rather than discovered later: the healthy
  // affordance measures 12.83px against the 14px reserved, which is 1.17px. The
  // glyph comes from the platform's own UI font, so a wider fallback on another
  // OS could cross that line. If it ever does, the report is TRUE — a header
  // whose indicator outgrows its allowance really does clip — and the answer is
  // to raise SORT_AFFORDANCE_PAD to the measured need, not to loosen this.
  const short: string[] = [];
  const measured = { asc: 0, desc: 0 };
  const glyphsSeen = new Set<string>();
  let widest = 0;
  // Every sortable header that was NOT clicked, proven to share the geometry of
  // the one that was. Only the first header per tab can be measured with its
  // glyph on screen without re-sorting every table on the page; this is what
  // stops that shortcut from being an assumption.
  const geometryOutliers: string[] = [];

  for (const tab of TABS) {
    await page.goto(`/#${tab}`);
    await page.waitForTimeout(1000);

    const sortables = page.locator('table thead th[aria-sort] button');
    const n = await sortables.count();
    if (n === 0) continue;

    // Two clicks on the SAME header: the first sorts it ascending, the second
    // reverses it. That is what puts each glyph on screen in turn.
    for (let click = 0; click < 2; click++) {
      await sortables.first().click();
      await page.waitForTimeout(200);

      const res = await page.evaluate(() => {
        // The header just clicked, reached the same way the locator reached it
        // — first in DOM order — rather than by asking for "whichever header is
        // sorted", which on a tab with several tables can answer with a
        // different one and quietly measure something nobody clicked.
        const btn = document.querySelector('table thead th[aria-sort] button');
        const th = btn?.closest('th');
        const span = btn?.querySelector('span[aria-hidden="true"]');
        if (!btn || !th || !span) return null;
        const glyph = (span.textContent || '').trim();
        if (!glyph) return null;
        // What the affordance actually costs: the flex gap between label and
        // indicator, plus the indicator's own painted width. Both are read from
        // the live box rather than from the class name, so changing gap-1 to
        // gap-2 moves this number.
        const gap = parseFloat(getComputedStyle(btn).columnGap) || 0;
        // Every OTHER sortable header on the page, described by the two things
        // that decide how wide its indicator paints: the gap it sits after and
        // the font it is drawn in. Identical descriptions mean the measured
        // header stands for all of them.
        const sig = (b: Element) => {
          const cs = getComputedStyle(b);
          const ics = getComputedStyle(b.querySelector('span[aria-hidden="true"]') || b);
          return `gap=${cs.columnGap} font=${ics.fontSize}/${ics.fontFamily}`;
        };
        const others = Array.from(document.querySelectorAll('table thead th[aria-sort] button'))
          .filter((b) => b !== btn)
          .map((b) => ({
            sig: sig(b),
            label: (b.closest('th')?.textContent || '').trim(),
          }));

        return {
          dir: th.getAttribute('aria-sort'),
          glyph,
          painted: gap + span.getBoundingClientRect().width,
          label: (th.textContent || '').trim(),
          sig: sig(btn),
          others,
        };
      });

      if (!res) continue;
      if (res.dir === 'ascending') measured.asc++;
      else if (res.dir === 'descending') measured.desc++;
      glyphsSeen.add(res.glyph);
      if (res.painted > widest) widest = res.painted;
      for (const o of res.others) {
        if (o.sig !== res.sig) {
          geometryOutliers.push(`${tab} "${o.label}" is ${o.sig}, the header measured is ${res.sig}`);
        }
      }
      if (res.painted > SORT_AFFORDANCE_PAD) {
        short.push(
          `${tab} "${res.label}" ${res.dir}: the ${res.glyph} needs ${res.painted.toFixed(2)}px, SORT_AFFORDANCE_PAD allows ${SORT_AFFORDANCE_PAD}px`,
        );
      }
    }
  }

  expect(
    measured.asc,
    'no header was ever observed in the ascending state — aria-sort is gone, or the indicator span no longer paints its glyph',
  ).toBeGreaterThan(0);
  expect(
    measured.desc,
    'no header was ever observed in the descending state — a second click no longer reverses the sort',
  ).toBeGreaterThan(0);
  expect(
    [...glyphsSeen].sort(),
    `both sort states were reached but only ${glyphsSeen.size} distinct indicator character was painted (${[...glyphsSeen].join(' ')}) — one of the two widths has not actually been measured`,
  ).toHaveLength(2);
  expect(
    geometryOutliers,
    `Sortable headers whose indicator geometry differs from the one measured, so the measurement does not speak for them:\n  ${geometryOutliers.join('\n  ')}`,
  ).toEqual([]);

  expect(
    short,
    `Sort indicators wider than the allowance the measurer reserves for them (widest seen ${widest.toFixed(2)}px):\n  ${short.join('\n  ')}`,
  ).toEqual([]);
});
