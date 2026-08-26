import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The chart styling lives in JS style objects, not utility classes, so
// ui/src/lib/typeScale.test.js and radiusRoles.test.js are both blind to it —
// index.css named it as outstanding for exactly that reason. This spec is the
// gate those two cannot be.
//
// It checks the RESOLVED value in the browser rather than the source text,
// which is the whole point: `fontSize: 'var(--text-note)'` is only a fix if the
// browser actually resolves it there. Recharts spreads a `tick` object onto an
// SVG <text>, and var() in an SVG presentation attribute is not something to
// take on trust — asserting the computed px is what makes it a fact. Reading
// the tokens through getComputedStyle in JS was the alternative and it is worse:
// on a cold load that runs before the stylesheet applies and bakes in an empty
// string, which is Codex's finding 4 on this change.

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

const HOVER_SETTLE_MS = 70;
const CHART_READY_MS = 20_000;

// One chart per chart COMPONENT, which is what this spec is really about:
// GradientArea, CategoryBars (x and y axes) and StackedDayBars.
const AXIS_CHARTS = [
  { tab: 'overview', panel: 'dns-hero', component: 'GradientArea' },
  // showY, so this one covers the Y axis as well as the X.
  { tab: 'network', panel: 'network-utilization-distribution', component: 'CategoryBars' },
  { tab: 'security', panel: 'security-threat-feed-activity', component: 'StackedDayBars' },
];

async function chartBox(page: import('@playwright/test').Page, panel: string) {
  const wrapper = page.locator(`[data-panel-id="${panel}"] .recharts-surface`).first();
  await expect(wrapper).toBeVisible({ timeout: CHART_READY_MS });
  await wrapper.scrollIntoViewIfNeeded();
  const box = await wrapper.boundingBox();
  expect(box, `panel "${panel}" has a recharts surface with no box`).toBeTruthy();
  return box!;
}

test('every chart axis tick paints at the note token, not a hand-written size', async ({ page }) => {
  const wrong: string[] = [];
  for (const c of AXIS_CHARTS) {
    await page.goto(`/#${c.tab}`);
    await expect(page.locator('h1').first()).toBeVisible();
    await chartBox(page, c.panel);
    const sizes = await page.evaluate((panel) => {
      const root = document.querySelector(`[data-panel-id="${panel}"]`);
      if (!root) return null;
      const note = getComputedStyle(document.documentElement).getPropertyValue('--text-note').trim();
      const ticks = Array.from(root.querySelectorAll('text.recharts-cartesian-axis-tick-value'));
      return {
        note,
        seen: Array.from(new Set(ticks.map((t) => getComputedStyle(t).fontSize))),
        count: ticks.length,
      };
    }, c.panel);

    if (!sizes || sizes.count === 0) {
      wrong.push(`${c.panel} (${c.component}): no axis ticks found to measure`);
      continue;
    }
    // --text-note is 11px. Comparing against the token rather than the literal
    // means moving the token moves this assertion with it.
    if (sizes.seen.length !== 1 || sizes.seen[0] !== sizes.note) {
      wrong.push(
        `${c.panel} (${c.component}): ticks paint at ${sizes.seen.join(', ')}, --text-note is ${sizes.note}`,
      );
    }
  }
  expect(wrong, `Axis ticks off the type scale:\n  ${wrong.join('\n  ')}`).toEqual([]);
});

test('the chart tooltip paints at the note and control tokens', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();
  const box = await chartBox(page, 'dns-hero');

  // Sweep for a point that answers, the same reason tests/chart-tooltips.spec.ts
  // does: an area chart only responds near its own line.
  let found: any = null;
  for (const fy of [0.5, 0.28, 0.72]) {
    for (const fx of [0.2, 0.32, 0.44, 0.5, 0.56, 0.68, 0.8]) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await page.waitForTimeout(HOVER_SETTLE_MS);
      found = await page.evaluate(() => {
        const tip = document.querySelector('.recharts-tooltip-wrapper > div');
        if (!tip) return null;
        const cs = getComputedStyle(tip);
        const rootCs = getComputedStyle(document.documentElement);
        const swatch = tip.querySelector('i');
        return {
          fontSize: cs.fontSize,
          borderRadius: cs.borderTopLeftRadius,
          note: rootCs.getPropertyValue('--text-note').trim(),
          control: rootCs.getPropertyValue('--radius-control').trim(),
          mark: rootCs.getPropertyValue('--radius-mark').trim(),
          swatchRadius: swatch ? getComputedStyle(swatch).borderTopLeftRadius : null,
        };
      });
      if (found) break;
    }
    if (found) break;
  }

  expect(found, 'swept the DNS Query Rate chart and no tooltip ever appeared').toBeTruthy();
  // An unresolved var() computes to the initial value — 'normal'/'0px', never
  // the token — so these comparisons catch a var() that did not resolve as
  // surely as they catch a hand-written number.
  expect(found.fontSize, 'tooltip text is not --text-note').toBe(found.note);
  expect(found.borderRadius, 'tooltip corner is not --radius-control').toBe(found.control);
  if (found.swatchRadius !== null) {
    expect(found.swatchRadius, 'legend swatch corner is not --radius-mark').toBe(found.mark);
  }
});
