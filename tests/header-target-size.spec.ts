import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// WCAG 2.5.8 Target Size (Minimum), AA: an interactive target is at least
// 24x24 CSS px. The three panel-header controls — drag ⠿, hide ✕, help ⓘ —
// were 21.5x17, 22.4x17 and 24.8x17, so all three failed on height and two on
// width as well.
//
// THIS IS THE FINE-POINTER CASE, deliberately. tests/touch-targets.spec.ts sets
// hasTouch and checks a 44px floor that only exists under
// `@media (pointer: coarse)`; it also sets MIN_W = 0, so it says nothing about
// width and nothing at all about a mouse. Without this file the fine-pointer
// geometry of these three controls is unasserted, which is Codex's finding 1 on
// this change.
//
// WHY THE SPACING EXCEPTION DOES NOT RESCUE THEM, since it is the obvious
// objection. 2.5.8 excuses an undersized target if a 24px-diameter circle
// centred on it intersects no other target. Measuring that as "are the centres
// more than 24px apart" says these buttons pass — and that test is wrong. The
// criterion is that the CIRCLE must not reach into another TARGET'S BOX, and a
// 12px radius centred on a 22px-wide button reaches 1px past its own edge and
// well into whatever sits beside it. Measured with the correct test before this
// change: the circle around each of the three overlapped a neighbour by 10.5px.
// The size fix removes the argument rather than relying on the exception.

// 30 page loads, each with a reload to apply the density. Well past the 30s
// default, and a timeout here reads as "the h1 never appeared" rather than as
// what it is.
test.setTimeout(240_000);

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

const TABS = ['overview', 'network', 'infra', 'security', 'audit'];
// Both sides of the fitted-grid breakpoints, since the header is measured into
// each panel's width floor and a narrow track is where a control gets squeezed.
const WIDTHS = [1920, 1280, 1024];
// Density changes --sp-cell-y and the card padding, so it can move a header box.
const DENSITIES = ['comfortable', 'compact'];

const MIN = 24;
// getBoundingClientRect returns fractional px; a border can land a box a hair
// under. Half a pixel of slack, far too little to hide a 17px control.
const SLACK = 0.5;

const SELECTORS = [
  { sel: '[data-layout-handle]', what: 'drag handle' },
  { sel: '[data-layout-hide]', what: 'hide button' },
];

test('the panel header controls are 24x24 on a mouse, in both densities', async ({ page }) => {
  const small: string[] = [];
  const escaped: string[] = [];
  let measured = 0;

  for (const density of DENSITIES) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const tab of TABS) {
        await page.goto(`/#${tab}`);
        await expect(page.locator('h1').first()).toBeVisible();
        await page.evaluate((d) => {
          try { localStorage.setItem('noc.density', d); } catch {}
        }, density);
        await page.reload();
        await expect(page.locator('h1').first()).toBeVisible();
        await page.waitForTimeout(800);

        const r = await page.evaluate(
          ({ selectors, MIN, SLACK }) => {
            const fine = window.matchMedia('(pointer: fine)').matches;
            const out: any[] = [];
            const over: any[] = [];
            let n = 0;
            for (const { sel, what } of selectors) {
              document.querySelectorAll(sel).forEach((el) => {
                const b = el.getBoundingClientRect();
                if (b.width === 0 && b.height === 0) return; // not rendered
                n++;
                const panel = el.closest('[data-panel-id]');
                const id = panel ? panel.getAttribute('data-panel-id') : '(no panel)';
                if (b.width < MIN - SLACK || b.height < MIN - SLACK) {
                  out.push(`${what} on ${id} is ${Math.round(b.width * 10) / 10}x${Math.round(b.height * 10) / 10}`);
                }
                // Growing a control must not push it out of its own card.
                if (panel) {
                  const pb = panel.getBoundingClientRect();
                  if (b.right > pb.right + 1 || b.top < pb.top - 1) {
                    over.push(`${what} on ${id} escapes its card (right ${Math.round(b.right)} vs ${Math.round(pb.right)})`);
                  }
                }
              });
            }
            return { fine, n, out, over };
          },
          { selectors: SELECTORS, MIN, SLACK },
        );

        // A coarse pointer would apply the 44px rule and make this pass for the
        // wrong reason.
        expect(r.fine, 'the browser did not report a fine pointer; this spec must run with a mouse').toBe(true);
        measured += r.n;
        for (const s of r.out) small.push(`${density} ${width}px ${tab}: ${s}`);
        for (const s of r.over) escaped.push(`${density} ${width}px ${tab}: ${s}`);
      }
    }
  }

  // Cannot pass by emptiness: 5 tabs x 3 widths x 2 densities, every panel
  // carrying a handle and a hide button. If the attributes are renamed this
  // trips instead of silently measuring nothing.
  expect(
    measured,
    'no panel-header controls were found — data-layout-handle/data-layout-hide may have been renamed',
  ).toBeGreaterThan(100);

  expect(small, `Panel header controls under ${MIN}x${MIN} with a mouse:\n  ${small.join('\n  ')}`).toEqual([]);
  expect(escaped, `A header control grew outside its own card:\n  ${escaped.join('\n  ')}`).toEqual([]);
});
