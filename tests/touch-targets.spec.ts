import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Audit item 5: 44x44 hit areas, and ONLY on a touch pointer.
//
// The wide version of this — a 44px floor for everyone — was rejected during
// the #188 review, because an 11px-dense desktop operator console would have to
// be redesigned around it. Behind `pointer: coarse` it costs a mouse user
// nothing, because the query never matches for them.
//
// THE WHOLE SUITE RUNS WITH A FINE POINTER, which is why this file sets
// hasTouch and the others do not. Nothing else here can see this rule at all:
// it cannot regress them, and they cannot validate it. That cuts both ways and
// is the reason this spec exists rather than an assertion bolted onto an
// existing one.
//
// Two things are asserted together, because either alone is misleading:
//   1. Every interactive control outside a table and outside an SVG is at least
//      44x44. Measured before the rule existed: 310 were not, the smallest 13px.
//   2. No tab overflows horizontally at any width. Growing 310 controls is only
//      safe if it does not push the layout sideways, and the sizing model exists
//      precisely to keep scrollWidth == clientWidth.
//
// WHAT IS DELIBERATELY EXEMPT, so a future reader does not "fix" it:
//   - Anything inside <table>. DataTable measures column widths with a canvas
//     against hard-coded padding constants and Card publishes its width from
//     getComputedStyle; growing a sort button would desync the measurer from
//     the thing it measures. Codex raised this as finding 6 on the plan.
//   - Anything inside <svg>. A pointer rule has no business resizing chart
//     geometry.

test.use({ hasTouch: true });
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

const TABS = ['overview', 'network', 'infra', 'security', 'audit', 'assets', 'provision', 'selfservice'];

// The four widths the sizing model is measured against elsewhere
// (tests/table-sizing.spec.ts uses the same set), plus a phone. 1024 is the md
// breakpoint and 1280 the xl one, so both sides of each control-cluster
// breakpoint are covered — a 44px floor is likeliest to push something sideways
// exactly where the layout changes shape.
const WIDTHS = [1280, 1024, 768, 390];

const MIN = 44;
// getBoundingClientRect returns fractional px and a transform or a border can
// land a control a hair under. One pixel of slack, not enough to hide a control
// that was never grown at all.
const SLACK = 1;

const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"]';

test('every control off the tables is a 44px touch target, and nothing overflows', async ({ page }) => {
  const small: string[] = [];
  const overflow: string[] = [];
  let measured = 0;

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const tab of TABS) {
      await page.goto(`/#${tab}`);
      await expect(page.locator('h1').first()).toBeVisible();
      await page.waitForTimeout(900);

      const r = await page.evaluate(
        ({ sel, MIN, SLACK }) => {
          const coarse = window.matchMedia('(pointer: coarse)').matches;
          const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
          const subject = els.filter((el) => {
            if (el.closest('table') || el.closest('svg')) return false;
            const b = el.getBoundingClientRect();
            return b.width > 0 && b.height > 0; // skip hidden controls
          });
          const under = subject
            .map((el) => {
              const b = el.getBoundingClientRect();
              return { el, b };
            })
            .filter(({ b }) => b.height < MIN - SLACK || b.width < MIN - SLACK)
            .slice(0, 8)
            .map(({ el, b }) => {
              const cls = (el.getAttribute('class') || '').split(/\s+/).slice(0, 2).join(' ');
              return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} ${Math.round(b.width)}x${Math.round(b.height)}`;
            });
          const de = document.documentElement;
          return {
            coarse,
            n: subject.length,
            under,
            scrollW: de.scrollWidth,
            clientW: de.clientWidth,
          };
        },
        { sel: INTERACTIVE, MIN, SLACK },
      );

      // If the pointer is not coarse the rule cannot apply and every assertion
      // below would pass or fail for the wrong reason.
      expect(r.coarse, 'the browser did not report a coarse pointer; hasTouch is not in effect').toBe(true);
      measured += r.n;

      for (const u of r.under) small.push(`${width}px ${tab}: ${u}`);
      if (r.scrollW > r.clientW + 1) {
        overflow.push(`${width}px ${tab}: scrollWidth ${r.scrollW} > clientWidth ${r.clientW}`);
      }
    }
  }

  // Cannot pass by emptiness: if the selector stopped matching, this trips.
  expect(measured, 'no interactive controls were found to measure at all').toBeGreaterThan(200);

  expect(
    small,
    `Controls below ${MIN}x${MIN} on a coarse pointer:\n  ${small.join('\n  ')}`,
  ).toEqual([]);
  expect(
    overflow,
    `Growing the touch targets pushed a tab into horizontal overflow:\n  ${overflow.join('\n  ')}`,
  ).toEqual([]);
});
