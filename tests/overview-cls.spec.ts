import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { installBaselineWorld, dataPayload } from './page-fixtures';

// THE OVERVIEW TAB MUST NOT RESIZE WHEN /api/data LANDS.
//
// WHAT WENT WRONG. Desktop Lighthouse scored this page CLS 0.199 against a 0.1
// threshold, and one layout-shift entry at t=437ms carried 0.1943 of the 0.1948
// total. Measured on the live tenant at 1440x900 on 2026-08-27, three separate
// rows grew the moment the payload arrived:
//
//   dns-hero + kpi-stack        361px -> 415px   (+54)
//   the three-across chart row  198px -> 278px   (+80)
//   subnet-table                500px -> 560px   (+60)
//
// The +54 is the one that did the damage: it moved every row beneath it, and
// Lighthouse then attributed the whole score to subnet-table — the biggest thing
// being PUSHED. Reading that as an accusation is what sent PR #202 to fix the
// wrong panel. entry.sources[] names the pusher; the headline node does not.
//
// TWO CAUSES, NOT ONE.
//
//   1. kpi-stack reserved a 30px spacer for its sparkline and nothing at all for
//      the caption underneath it, so each of three cells grew 18px.
//   2. The three chart panels each rendered <Empty/> (`min-h-[100px]`) while the
//      request was in flight, because an in-flight fetch and an empty estate are
//      indistinguishable from `subnets.length` alone. They settle at 180px.
//
// Neither was a lazily-imported chart chunk, which is what the shape of the code
// suggests: TopUtilization's Suspense fallback already reserved the right 180px,
// and HostStatus's fallback already filled its 130px donut box. The panels never
// got as far as their Suspense boundaries.
//
// WHY THIS FILE MEASURES BODIES AND NOT CARDS. The first draft compared each
// CARD's height while loading against its height once settled. That passes
// against half-fixed code: these three panels share one CardGrid row, a grid row
// stretches every member to the row's height, and the row's height is the max of
// the three. Reserving in top-consumers ALONE would hold all three cards at
// 278px in both states and this file would have gone green with two broken
// loading branches still in it. So each panel's own reservation is compared
// against its own settled content instead, which is a claim about that panel and
// nothing else.
//
// AND THERE ARE NO PIXEL COUNTS BELOW. Not 278, not 98px of chrome, not even the
// 130 that DONUT_H holds: a literal here would be a third copy of a number that
// already exists twice, and it would keep agreeing with itself after the two
// real copies had drifted apart. What is asserted is that the reservation and
// the thing it reserves for are the SAME height, whatever that height is — which
// is also the only form of the claim that survives the owner re-spanning these
// panels through the saved layout.
//
// AND THIS IS NOT THE PROOF. A component-level spec is a regression guard. The
// evidence that the PAGE metric moved is a whole-page Lighthouse desktop run,
// recorded in plans/gui-screens-audit.md. #202 was reported as fixing this CLS
// on the strength of a one-panel geometry spec, and the whole-page number
// afterwards was 0.199, completely unchanged.

// Each panel's reservation, and the thing it settles into. Both are read as
// heights and compared to each other; neither number is written down here.
//
// The loading selector is the Skeleton's own `animate-pulse` div, scoped to the
// panel. The settled selector is whatever actually draws: recharts' wrapper, the
// heatmap's inline svg, the donut's fixed box.
const PANELS = [
  { id: 'top-consumers', settled: '.recharts-wrapper' },
  { id: 'subnet-heatmap', settled: 'svg' },
  { id: 'host-status', settled: '.w-\\[130px\\]' },
];

// Raw, unrounded. Rounding both sides before a 1px comparison admits nearly 2px
// of real movement, and the whole point of the tolerance is that it is small.
const boxH = async (page: Page, sel: string): Promise<number> => {
  const box = await page.locator(sel).first().boundingBox();
  if (!box) throw new Error(`nothing matched ${sel}`);
  return box.height;
};

test('each Overview panel reserves its own settled height while /api/data is in flight', async ({ page }) => {
  await installBaselineWorld(page);

  // Held rather than delayed-then-forwarded: what is under test is the page's
  // geometry DURING the wait, so the wait has to be decided here and not by
  // whatever the server feels like doing. Same reason assets-cold-load.spec.ts
  // answers its held request from the fixture instead of continuing it.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/data', async (route) => {
    await held;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(dataPayload()),
    });
  });

  await page.goto('/#overview');

  // Every reservation must be on screen before any of them is measured, and it
  // must be the SKELETON that is on screen — waiting for the panel alone would
  // let a panel that rendered <Empty/> satisfy the wait and then be measured as
  // though it had reserved something.
  const reserved: Record<string, number> = {};
  for (const p of PANELS) {
    const sel = `[data-panel-id="${p.id}"] .animate-pulse`;
    await expect(page.locator(sel).first(), `${p.id} rendered no reservation while /api/data was in flight`).toBeVisible();
    reserved[p.id] = await boxH(page, sel);
  }

  release();

  // Settled means the charts have DRAWN, not merely that the payload arrived —
  // the recharts chunk resolves after the JSON does, and a height read between
  // the two would pass against code that only reserves for the JSON.
  for (const p of PANELS) {
    const sel = `[data-panel-id="${p.id}"] ${p.settled}`;
    await expect(page.locator(sel).first()).toBeVisible({ timeout: 20_000 });
  }
  await page.waitForTimeout(300);

  for (const p of PANELS) {
    const settled = await boxH(page, `[data-panel-id="${p.id}"] ${p.settled}`);
    expect(
      Math.abs(settled - reserved[p.id]),
      `${p.id} reserved ${reserved[p.id]}px while loading but settled at ${settled}px, ` +
        `so it resizes its shared grid row when /api/data lands`,
    ).toBeLessThanOrEqual(1);
  }
});

// The host legend sits beside the donut and is free to wrap. While it is shorter
// than the donut, the donut's height IS the panel's height and DONUT_H is the
// right thing to reserve. If the legend ever grows taller, it — not the donut —
// becomes what the reservation has to match, and the test above would go on
// passing while the panel quietly resized the row again.
//
// Measured at 1920, 1440, 1280, 1024 and 900 on the live tenant on 2026-08-27:
// the row and the donut were both 130px at every width, so the legend never
// drove the height. This fails the day that stops being true.
test('the host-status legend never grows taller than the donut it sits beside', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');

  const donut = `[data-panel-id="host-status"] .w-\\[130px\\]`;
  await expect(page.locator(donut).first()).toBeVisible({ timeout: 20_000 });

  const row = await boxH(page, `[data-panel-id="host-status"] .flex.items-center.gap-4`);
  const box = await boxH(page, donut);
  expect(
    row - box,
    `the host-status legend is now taller than its ${box}px donut (row is ${row}px), ` +
      `so DONUT_H no longer describes what this panel settles at`,
  ).toBeLessThanOrEqual(1);
});

// The caption under each sparkline is reserved by rendering a hidden copy of
// itself, so that its height is the settled height BY CONSTRUCTION and cannot
// drift when the font, the line-height or the wording changes.
//
// Height equality alone would not prove that: a `h-[48px]` spacer, or the same
// caption at `opacity: 0`, would both satisfy it. So the mechanism is asserted
// too — the text is really there, it is really `visibility: hidden`, and it is
// really out of the accessibility tree. `opacity: 0` would leave it selectable
// and readable aloud; `display: none` would reserve nothing at all.
test('the kpi sparkline caption is reserved by a hidden copy of itself', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#overview');

  const cell = '[data-panel-id="kpi-stack"] [role="button"]';
  // The sparkline itself, not the panel: waiting for the panel would let the
  // placeholder state satisfy the wait, and then BOTH measurements below would
  // observe the placeholder and agree with each other against broken code.
  await expect(page.locator(`${cell} svg`).first()).toBeVisible({ timeout: 20_000 });
  const withSparkline = await boxH(page, cell);

  // The same cell with its sparkline suppressed. One measured subnet is not
  // enough to draw a line, which is the real condition the placeholder branch
  // covers — and it is also a real tenant: a brand-new estate with one subnet.
  const one = structuredClone(dataPayload()) as { subnets: unknown[] };
  one.subnets = [one.subnets[0]];
  await page.route('**/api/data', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(one) }),
  );
  await page.reload();
  // Wait for the sparkline to be GONE, so the second measurement is known to be
  // of the branch under test rather than of a page that had not updated yet.
  await expect(page.locator(`${cell} svg`).first()).toBeHidden({ timeout: 20_000 });
  const withoutSparkline = await boxH(page, cell);

  expect(
    Math.abs(withSparkline - withoutSparkline),
    `a kpi cell is ${withSparkline}px with a sparkline and ${withoutSparkline}px without one, ` +
      `so an estate that has one shifts against an estate that does not`,
  ).toBeLessThanOrEqual(1);

  const hidden = page.locator(`${cell} [aria-hidden="true"]`).first();
  await expect(hidden).toHaveText(/util of loaded rows/);
  await expect(hidden).toHaveCSS('visibility', 'hidden');
  // Hidden from assistive technology as well as from the eye: the caption
  // describes a sparkline that is not being drawn, so reading it aloud would be
  // a lie about what is on screen.
  await expect(page.locator(cell).first()).not.toHaveAccessibleName(/util of loaded rows/);
});
