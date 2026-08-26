import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';
import { beginPanelDrag, gotoTab } from './layout-helpers';

// The drag ghost is built by writing a cssText string onto a div and appending
// it to document.body (ui.jsx's onHandleDown). Every scan in ui/src/lib/ reads
// class LITERALS out of .jsx source, so none of them can see inside that string
// — which is how three hand-written values sat there unremarked while the app
// moved its type, its radius and its spacing onto tokens around them.
// typeScale.test.js names the 13px as a site it cannot reach. The 12px padding
// and the 12px corner were not named anywhere at all, because nothing knew to
// look.
//
// This spec is the gate those files cannot be, and it is patterned on
// tests/chart-tokens.spec.ts for the same reason that one exists: it asserts the
// RESOLVED value in the browser rather than the source text. `padding:
// var(--sp-ghost-pad)` is only a fix if the browser actually resolves it there.
// A var() naming a token that does not exist is invalid at computed-value time,
// and what that produces depends on whether the property inherits: padding and
// border-radius do not, so they fall to the INITIAL value (0px); font-family
// does, so it falls to whatever body is using — which on this page is a stack
// beginning with the same system-ui and looks entirely plausible. Neither case
// throws. Comparing against the token read from :root is what catches them.
//
// WHY IT IS A BROWSER TEST AND NOT A STRING MATCH. Grepping ui.jsx for
// 'var(--sp-ghost-pad)' would pass against a typo'd token name, against a token
// that was never defined, and against a ghost that had stopped being created at
// all. None of those three is hypothetical: the first two are one keystroke
// apart from correct, and the third is what a refactor of onHandleDown would do.
//
// PROVEN AGAINST THE DEFECT, and the proof is the reason there are two tests
// rather than one. Three runs, each with the tree restored afterwards:
//
//   the whole old string        test 1 fails on the FONT STACK only. The
//   restored                    padding and corner assertions PASS, because
//                               the hand-written 12px is exactly what
//                               --sp-ghost-pad and --radius-surface resolve
//                               to. Test 2 fails, naming the corner.
//   padding:12px alone,         TEST 1 PASSES. Test 2 fails: "--sp-ghost-pad
//   the rest tokenised          was moved to 17px and the ghost still paints
//                               12px."
//   border-radius:12px alone    test 2 fails, naming the corner. Test 1 passes.
//   the font SHORTHAND split     test 1 fails on line-height: the ghost paints
//   into three longhands         19.5px, inherited from body, where the
//                                shorthand resets it to normal. This is why
//                                the line is not split even though longhands
//                                read more clearly — a shorthand resets every
//                                property it covers, and one of them is set
//                                nowhere else.
//
// The middle run is the one to read. A hand-written padding survives every
// equality assertion in this file, because equality cannot tell a token from a
// coincidence that happens to match it — and matching exactly is what made
// these extractions rather than look changes in the first place.
//
// What tells them apart is whether the ghost FOLLOWS when the token moves, so
// the second test moves both and measures again. Equality alone would have
// shipped a green suite over an unchanged hard-coded value. (Test 2 stops at
// its first failed expect, so the two runs above exercise the corner and the
// padding assertions separately; neither is taken on trust from the other.)

const TAB = 'overview';
// Overview's declared panel count, matching tests/layout-drag.spec.ts. gotoTab
// waits for exactly this many [data-panel-id] elements, so a wrong number here
// is a 20s timeout rather than a quiet half-loaded page.
const PANEL_COUNT = 7;

// Read from :root at the moment of the assertion rather than written down here.
// A literal would turn every token edit into a two-file change and would let
// this spec go on asserting a value the app had stopped using.
const tokens = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      ghostPad: cs.getPropertyValue('--sp-ghost-pad').trim(),
      surface: cs.getPropertyValue('--radius-surface').trim(),
      sans: cs.getPropertyValue('--font-sans').trim(),
    };
  });

const ghostStyle = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-layout-ghost]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      paddingTop: cs.paddingTop,
      paddingRight: cs.paddingRight,
      paddingBottom: cs.paddingBottom,
      paddingLeft: cs.paddingLeft,
      borderTopLeftRadius: cs.borderTopLeftRadius,
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      text: (el.textContent || '').trim(),
    };
  });

// getComputedStyle serialises a font stack with a space after each comma, and a
// custom property is returned with whatever spacing the author wrote. Comparing
// them raw reports a difference that does not exist.
const normaliseStack = (s: string) =>
  s
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, ''))
    .join(',');

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await gotoTab(page, TAB, PANEL_COUNT);
});

test('the drag ghost paints at the spacing, radius and font tokens', async ({ page }) => {
  const ids = await page.locator('[data-panel-id]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-panel-id')!),
  );
  expect(ids.length, 'no panels on the tab, so no handle to drag').toBeGreaterThan(0);

  const want = await tokens(page);
  // Each token must be a real value before it is used as an expectation. An
  // undefined custom property returns an EMPTY STRING, and every comparison
  // below would then be trivially satisfiable by any element that also computed
  // to nothing — the vacuous pass this whole suite is written against.
  expect(want.ghostPad, '--sp-ghost-pad is not defined on :root').toMatch(/^[\d.]+px$/);
  expect(want.surface, '--radius-surface is not defined on :root').toMatch(/^[\d.]+px$/);
  expect(want.sans, '--font-sans is not defined on :root').not.toBe('');

  // try/finally, because everything between the press and the release can
  // throw. A test that ends with the button still down leaves the gesture live
  // into teardown, where the next pointer event commits a reorder nobody asked
  // for — so the release belongs somewhere a failed assertion cannot skip.
  let got: Awaited<ReturnType<typeof ghostStyle>> = null;
  try {
    await beginPanelDrag(page, ids[0]!);
    await expect(page.locator('[data-layout-ghost]')).toHaveCount(1);
    got = await ghostStyle(page);
  } finally {
    await page.mouse.up();
  }

  expect(got, 'the drag began but no [data-layout-ghost] was in the DOM to measure').toBeTruthy();
  // All four sides. `padding: var(--sp-ghost-pad)` is a shorthand, so a
  // longhand that failed to take would show on one edge only.
  expect(got!.paddingTop, 'ghost padding-top is not --sp-ghost-pad').toBe(want.ghostPad);
  expect(got!.paddingRight, 'ghost padding-right is not --sp-ghost-pad').toBe(want.ghostPad);
  expect(got!.paddingBottom, 'ghost padding-bottom is not --sp-ghost-pad').toBe(want.ghostPad);
  expect(got!.paddingLeft, 'ghost padding-left is not --sp-ghost-pad').toBe(want.ghostPad);
  expect(got!.borderTopLeftRadius, 'ghost corner is not --radius-surface').toBe(want.surface);
  expect(normaliseStack(got!.fontFamily), 'ghost font stack is not --font-sans').toBe(
    normaliseStack(want.sans),
  );

  // The `font:` SHORTHAND is what carries the size and weight, and a shorthand
  // resets every longhand it covers — including line-height, which nothing here
  // sets by hand. Asserting the two properties that were meant to survive the
  // var() substitution is what proves the shorthand still parsed: a shorthand
  // the browser rejected drops the weight to 400 and the size to 16px in one go,
  // silently, and the ghost would still look roughly right at a glance.
  expect(got!.fontWeight, 'the font shorthand no longer applies its weight').toBe('600');
  expect(got!.fontSize, 'the font shorthand no longer applies its size').toBe('13px');
  // The shorthand's RESET, asserted because preserving it is the stated reason
  // this line was not split into longhands. `font:` sets line-height to normal
  // when none is given; three separate longhands would leave the ghost
  // inheriting body's line-height instead, and would pass every other
  // assertion in this test while doing it.
  expect(
    got!.lineHeight,
    'the ghost is not on the font shorthand\'s line-height reset — it was probably split into longhands',
  ).toBe('normal');

  // The ghost carries the panel's own words. Without this the assertions above
  // could all be satisfied by an empty box, which is not the thing under test.
  expect(got!.text, 'the ghost painted no label').not.toBe('');
});

test('moving the tokens moves the ghost with them', async ({ page }) => {
  // The padding and the corner are the two values the first test cannot
  // actually judge. The ghost painted a hand-written 12px for each, and
  // --sp-ghost-pad and --radius-surface are both 12px, so the before and after
  // computed styles are identical and equality proves nothing about either.
  //
  // What distinguishes a token from a coincidence is whether the ghost follows
  // when the token moves. So both are moved, on :root where the app declares
  // them, to values nothing else in the file uses — and the ghost is measured
  // again. A hard-coded 12px stays at 12px and fails here, which is exactly
  // what it does when this test is run against the old string.
  //
  // Set as inline properties on documentElement through the CSSOM, NOT by
  // injecting a <style> element: go/csp.go sets style-src-elem 'self', so an
  // injected stylesheet never applies, getComputedStyle keeps returning the old
  // value, and the test reports "no effect" for a rule that never ran. An
  // inline property set this way is not subject to that.
  const ids = await page.locator('[data-panel-id]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-panel-id')!),
  );
  const before = await tokens(page);

  const MOVED_SANS = 'Georgia,serif';
  await page.evaluate((sans) => {
    document.documentElement.style.setProperty('--radius-surface', '21px');
    document.documentElement.style.setProperty('--sp-ghost-pad', '17px');
    document.documentElement.style.setProperty('--font-sans', sans);
  }, MOVED_SANS);
  const after = await tokens(page);
  // Both halves for each: the override took, AND it moved the value somewhere
  // new. An override that happened to equal the original would leave this test
  // passing against a ghost that had never read the token at all.
  expect(after.surface, 'the --radius-surface override did not take').toBe('21px');
  expect(after.ghostPad, 'the --sp-ghost-pad override did not take').toBe('17px');
  expect(after.sans, 'the --font-sans override did not take').toBe(MOVED_SANS);
  expect(after.surface, '--radius-surface was already 21px, so moving it proves nothing').not.toBe(
    before.surface,
  );
  expect(after.ghostPad, '--sp-ghost-pad was already 17px, so moving it proves nothing').not.toBe(
    before.ghostPad,
  );
  // A serif stack, deliberately: the real token is a sans stack led by
  // system-ui, so a ghost still holding the old hard-coded 'system-ui,sans-serif'
  // cannot accidentally match this the way a second sans stack might.
  expect(after.sans, '--font-sans was already the override, so moving it proves nothing').not.toBe(
    before.sans,
  );

  let got: Awaited<ReturnType<typeof ghostStyle>> = null;
  try {
    await beginPanelDrag(page, ids[0]!);
    await expect(page.locator('[data-layout-ghost]')).toHaveCount(1);
    got = await ghostStyle(page);
  } finally {
    await page.mouse.up();
  }

  expect(got, 'the drag began but no ghost was in the DOM to measure').toBeTruthy();
  expect(
    got!.borderTopLeftRadius,
    `--radius-surface was moved to 21px and the ghost still paints ${got!.borderTopLeftRadius} — the corner is a hard-coded value that merely equals the token`,
  ).toBe('21px');
  expect(
    got!.paddingLeft,
    `--sp-ghost-pad was moved to 17px and the ghost still paints ${got!.paddingLeft} — the padding is a hard-coded value that merely equals the token`,
  ).toBe('17px');
  expect(
    normaliseStack(got!.fontFamily),
    `--font-sans was moved to ${MOVED_SANS} and the ghost still paints ${got!.fontFamily} — the stack is hard-coded, or the font shorthand dropped the var()`,
  ).toBe(normaliseStack(MOVED_SANS));
});
