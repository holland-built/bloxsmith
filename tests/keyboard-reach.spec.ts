import { test, expect } from './fixtures';
import { dataPayload, installBaselineWorld } from './page-fixtures';
import type { Locator } from '@playwright/test';

// Every /api/ response is faked from tests/page-fixtures.ts.
//
// WHAT THIS FILE STOPS COMING BACK.
//
// The filter controls on eleven tabs were written by copying one class string,
// and that string carried `outline-none` with nothing put back. Measured before
// the fix: `grep -rn outline-none ui/src --include=*.jsx` returned 28 lines, 25
// with no focus replacement on the same line, 17 of them form controls. Tabbing
// to the Assets search box, either Audit date filter or either Network select
// changed nothing visible anywhere on the page. Two more controls — the Overview
// subnet heatmap squares and the Infra status-filter chip — were `onClick` on a
// non-interactive element with no role, no tabIndex and no key handler, so their
// drill-downs existed for a mouse and for nothing else. And the Incidents action
// drawer asked for `bg-panel`, which index.css never declared, so it painted no
// background at all over its own scrim.
//
// The checks below are RUNTIME and not a grep, deliberately. `outline-none` with
// a ring put back is fine, `outline-none` on a container focused programmatically
// is fine, and a grep cannot tell those from the defect. What a person actually
// experiences is whether the pixels change when focus lands, so that is what is
// measured.
//
// EVERY CHECK HERE WAS RUN AGAINST THE DEFECT IT NAMES. A gate that passes both
// ways is not a gate, and three of the first drafts in this file did exactly
// that — each is described at the check it belongs to.
test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

// A focus indicator has to be PAINTED, and it has to be NEW.
//
// The first draft compared the raw computed style before and after focus, and it
// passed against the very defect it was written to catch. Measured on #assets
// with the pre-fix class string: outline-width went 3px -> 1px and outline-color
// rgb(221,221,221) -> rgb(153,200,255) on focus, while outline-style stayed
// `none` throughout. Chrome keeps computing the width and colour of an outline
// it will never draw, so a probe reading them sees a difference on an element
// that visibly does nothing.
//
// So an outline counts only with both a style and a non-zero width, and the
// result must differ from rest — a decoration that was already there when
// unfocused tells a keyboard user nothing about where they are.
function paintedFocus(el: Element) {
  const s = getComputedStyle(el);
  const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0
    ? `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`
    : 'none';
  return { shadow: s.boxShadow, outline, border: s.borderColor };
}

// Takes the LOCATOR, not an index into a second query. The first draft counted
// `input:visible, select:visible` and then indexed
// `document.querySelectorAll('input, select')`, so any hidden control shifted
// every position and the probe silently measured the wrong elements.
async function focusReport(target: Locator) {
  return target.evaluate((el: HTMLElement, src: string) => {
    const painted = new Function(`return (${src})`)() as (e: Element) => Record<string, string>;
    el.blur();
    const resting = painted(el);
    // A scripted .focus() on a text field or a select satisfies Chrome's
    // focus-visible heuristic; the heatmap and chip checks below use real keys.
    el.focus();
    const focused = painted(el);
    const active = document.activeElement === el;
    el.blur();
    return {
      tag: el.tagName.toLowerCase(),
      cls: el.className,
      resting: JSON.stringify(resting),
      focused: JSON.stringify(focused),
      active,
      paints:
        (focused.shadow !== 'none' && focused.shadow !== resting.shadow) ||
        (focused.outline !== 'none' && focused.outline !== resting.outline) ||
        focused.border !== resting.border,
    };
  }, paintedFocus.toString());
}

async function expectPaintsOnFocus(target: Locator, where: string) {
  const r = await focusReport(target);
  expect(r.active, `${where}: ${r.tag} never became document.activeElement`).toBe(true);
  expect(
    r.paints,
    `${where}: ${r.tag} paints nothing new on focus — resting ${r.resting}, focused ${r.focused} (${r.cls})`,
  ).toBe(true);
}

// Every tab whose filter controls came from the shared class string. All eleven,
// not the seven the first draft covered: Drift, Editor, Provision and SelfService
// each define their own `inputCls` from the same source and were missed.
const FILTER_TABS = [
  'overview', 'network', 'infra', 'assets', 'audit', 'incidents', 'dns',
  'drift', 'editor', 'provision', 'selfservice',
];

for (const tab of FILTER_TABS) {
  test(`${tab}: every filter control paints a focus indicator`, async ({ page }) => {
    await page.goto(`/#${tab}`);
    // The same second-fetch wait drilldown.spec.ts documents at length: a tab's
    // panels are not in the DOM until its own /api/data resolves.
    const controls = page.locator('input:visible, select:visible');
    await expect(controls.first()).toBeVisible({ timeout: 20_000 });

    const count = await controls.count();
    expect(count, `${tab} should have at least one filter control`).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const control = controls.nth(i);
      if (await control.isDisabled()) continue;
      await expectPaintsOnFocus(control, `${tab} control #${i}`);
    }
  });
}

test('overview: the subnet heatmap is one tab stop, arrows move, Enter drills', async ({ page }) => {
  await page.goto('/#overview');
  const cells = page.locator('rect[role="button"]');
  await expect(cells.first()).toBeVisible({ timeout: 20_000 });

  const total = await cells.count();
  expect(total, 'the heatmap should render squares').toBeGreaterThan(1);

  // ROVING TABINDEX: exactly one square is in the tab order, however many there
  // are. 288 tab stops between this panel and the next would be its own defect,
  // which is why this asserts the count and not merely "reachable".
  const tabbable = await page.locator('rect[role="button"][tabindex="0"]').count();
  expect(tabbable, 'exactly one heatmap square should carry tabIndex 0').toBe(1);

  await cells.first().focus();
  await expect(cells.first()).toBeFocused();

  // The ring is a stroke, and it must be fully opaque whatever the square's own
  // utilisation is. The rect used `opacity`, which applies to the stroke too, so
  // the ring on a 10%-used subnet was painted at 15% — faintest on the calmest
  // square. `fillOpacity` leaves the ring alone.
  await expect(cells.first()).toHaveAttribute('stroke', /^(?!none$).+/);
  const ringAlpha = await cells.first().evaluate((el) => getComputedStyle(el).opacity);
  expect(Number(ringAlpha), 'the focused square must not dim its own ring').toBe(1);

  // ArrowRight moves focus to the next square and takes the ring with it.
  await page.keyboard.press('ArrowRight');
  await expect(cells.nth(1)).toBeFocused();
  await expect(cells.first()).toHaveAttribute('stroke', 'none');

  // The keyboard reads the same value the mouse reads on hover.
  await expect(page.locator('[data-heatmap-readout]')).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#network\?subnet=/);
});

test('overview: the heatmap keeps focus on the SAME subnet across a re-sort', async ({ page }) => {
  // `cells` is re-sorted by utilisation on every poll. A positional focus index
  // silently moves the ring and the tab stop onto a different subnet while the
  // operator is reading it, and an index-bearing React key remounts the rect so
  // DOM focus is lost outright. Both are invisible in a single-frame test, which
  // is why this one drives the reorder itself rather than waiting for a poll.
  // A real 31s wait for the panel's own 30s poll. page.clock.install() is not
  // available here: installBaselineWorld already calls page.clock.setFixedTime,
  // and Playwright allows one clock setup per page. Driving the poll any other
  // way would be testing a timer rather than the reorder.
  test.setTimeout(90_000);
  await page.goto('/#overview');
  const cells = page.locator('rect[role="button"]');
  await expect(cells.first()).toBeVisible({ timeout: 20_000 });

  // The SUBNET, not the whole label: the utilisation in the label is the very
  // thing being changed to force the re-sort, so comparing full labels would
  // fail on a working fix.
  const subnetOf = (label: string | null) => label?.split('—')[0].trim() ?? '';
  // THE LAST SQUARE, AND THAT CHOICE IS THE TEST.
  //
  // The first draft focused cells.nth(1) and passed with positional focus fully
  // reintroduced. With three fixture subnets at 10/85/98 percent, inverting them
  // to 90/15/2 leaves the middle one middle: index 1 before and index 1 after.
  // A positional index and an identity are indistinguishable there, so the check
  // proved nothing.
  //
  // The least-used subnet is the one whose POSITION has to move — it sorts last
  // now and first once the utilisations invert. Index 2 and index 0 cannot both
  // be right, so only an identity-keyed focus survives this.
  const count = await cells.count();
  const first = subnetOf(await cells.first().getAttribute('aria-label'));
  await cells.nth(count - 1).focus();
  const held = subnetOf(await cells.nth(count - 1).getAttribute('aria-label'));
  expect(held).toBeTruthy();
  expect(held, 'the held square must not already be the first one').not.toBe(first);

  // Invert the utilisations so the descending sort reverses on the next poll.
  // Built from the fixture payload, NOT from route.fetch(): fetch() bypasses the
  // fixture layer entirely and hits the e2e server, which has no tenant and
  // answers with an empty estate — the heatmap then has no squares at all, which
  // reads as "the reorder never happened".
  //
  // structuredClone IS LOAD-BEARING. dataPayload() is a shallow copy: its
  // `subnets` is the module's own SUBNETS array, so mutating a row here rewrites
  // the fixture for every test that runs afterwards in this worker. Measured:
  // without the clone, tests/page-baseline.spec.ts's overview snapshot picked up
  // 90/15/2 percent instead of 10/85/98 and went flaky.
  const inverted = structuredClone(dataPayload());
  for (const s of inverted.subnets) s.util = 100 - Number(s.util ?? 0);
  await page.route('**/api/data', (route) => route.fulfill({ json: inverted }));

  await expect
    .poll(async () => subnetOf(await cells.first().getAttribute('aria-label')), { timeout: 45_000 })
    .not.toBe(first);

  // The tab stop is still on the subnet the operator was reading, wherever the
  // re-sort moved it to.
  const ringed = page.locator('rect[role="button"][tabindex="0"]');
  await expect(ringed).toHaveCount(1);
  expect(
    subnetOf(await ringed.getAttribute('aria-label')),
    'the re-sort moved the tab stop onto a different subnet',
  ).toBe(held);
});

test('infra: the status-filter chip is a keyboard button and clears on Enter', async ({ page }) => {
  await page.goto('/#infra?status=offline');

  const chip = page.getByRole('button', { name: /^status: offline$/ });
  await expect(chip).toBeVisible({ timeout: 20_000 });

  // The chip carries `outline-none` like every other control here, so without
  // FOCUS_RING it would be a perfectly reachable button that shows nothing when
  // you reach it. The first draft only checked reachability and passed either
  // way.
  await expectPaintsOnFocus(chip, 'infra status chip');

  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#infra(?!\?status)/);
});

test('incidents: the action drawer paints a real surface, not the scrim', async ({ page }) => {
  // `bg-panel` was never declared in index.css's @theme, so Tailwind emitted no
  // rule and the drawer's content sat straight on the bg-black/40 overlay.
  //
  // The first draft asserted that no `.bg-panel` rule exists in the stylesheet.
  // That is TRUE OF THE BUG — an undeclared token emits nothing — so the check
  // passed against the exact defect it was written for. The drawer has to be
  // opened and its rendered background read instead.
  await page.goto('/#incidents');
  await page.getByRole('button', { name: 'Baseline suspicious domain' }).click();
  await expect(page.getByRole('heading', { name: 'Action detail' })).toBeVisible();

  const panel = page.locator('div.overflow-y-auto').filter({
    has: page.getByRole('heading', { name: 'Action detail' }),
  });
  const bg = await panel.evaluate((el) => getComputedStyle(el).backgroundColor);

  // Transparent is the tell: an undeclared token leaves background-color at
  // rgba(0, 0, 0, 0).
  const alpha = bg.startsWith('rgba') ? Number(bg.split(',')[3]?.replace(')', '').trim()) : 1;
  expect(alpha, `the drawer painted no surface of its own (${bg})`).toBe(1);

  // And it must not be the scrim's own colour showing through.
  const scrim = await page.locator('div.fixed.inset-0').first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg, 'the drawer background is indistinguishable from the scrim').not.toBe(scrim);
});
