import { test, expect } from './fixtures';
import {
  activeHandlePanel, cardBox, clampY, domOrder, dragOntoRightHalfOf, expectEverySpanWellFormed,
  expectPersistedBlobIsValid, geometry, gotoTab, grabRightEdge, inlineSpans, liveText,
  savedBlob as savedBlobFor, strayDragStyles, tableOverflow, tabToHandle,
} from './layout-helpers';

// P9 (item 8) — drag-to-rearrange with column snapping, and edge-drag resize.
//
// The arithmetic behind both gestures lives in ui/src/lib/layout.js and is
// covered by `node --test` (spanFromWidth, insertionIndex, moveItem,
// shiftItem, stepSpan). This file proves only the things a browser can prove:
// that the pointer and the keyboard reach that arithmetic, that what they
// decide is written through the ONE validated save path, and that neither
// gesture re-enters the fit system's measure -> render loops.
//
// Every expected span, position and order below is a hand-written literal read
// off the tab's own JSX. None is recomputed with the app's own logic.
//
// The gestures themselves live in ./layout-helpers.ts, shared with
// tests/hidden-tiles.spec.ts so that both specs drive the SAME drag.

// ---------------------------------------------------------------------------
// RUN THIS FILE WITH --workers=1 ALONGSIDE tests/layout-persist.spec.ts.
//
// Measured, not guessed: with the Playwright default of 2 workers, spec FILES
// are spread across workers even though both files are `mode: 'serial'`
// internally. This file and layout-persist.spec.ts both own the one
// server-side view `__layout_overview`, and layout-persist additionally
// SIGTERMs the Go binary as part of P8. Run in parallel they corrupt each
// other: on the first full-suite run, P9b read back `host-status: 4`, which is
// layout-persist's SAVE_BODY, not anything a drag wrote, and P8 read an order
// this file had just saved.
//
// Since 2026-08-08 every one of the 15 tabs carries a layoutKey, so the shared
// resource is no longer one view but a namespace: this file now also owns
// `__layout_network`, `__layout_dns` and `__layout_security` (the per-tab
// block at the bottom), and tests/hidden-tiles.spec.ts owns `__layout_daily`.
// Two specs writing one `__layout_<key>` is the hazard; each spec therefore
// names the keys it writes at the top and deletes them again when it is done.
//
// Neither file is wrong on its own; they are simply exclusive owners of shared
// resources. playwright.config.ts pins `workers: 1` for this reason.
// ---------------------------------------------------------------------------

const VIEW = '__layout_overview';

// The declared JSX order in Overview.jsx's <CardGrid layoutKey="overview">.
const DECLARED_ORDER = [
  'dns-hero',
  'kpi-stack',
  'top-consumers',
  'subnet-heatmap',
  'host-status',
  'subnet-table',
  'license-inventory',
];

type Page = import('@playwright/test').Page;

// Overview's own front door. The height default is 1080 rather than
// layout-helpers' 2400 because most of the tests below only touch the top two
// rows; the three that need every panel on screen at once pass 2400 by hand.
const gotoOverview = (page: Page, width = 1920, height = 1080) =>
  gotoTab(page, 'overview', DECLARED_ORDER.length, width, height);

const savedBlob = (request: import('@playwright/test').APIRequestContext) => savedBlobFor(request, VIEW);

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  await request.delete(`/api/views/${VIEW}`);
});

// ---------------------------------------------------------------------------
// Step 1 — edge-drag resize.
// ---------------------------------------------------------------------------

test('P9b: dragging a card right edge steps its span by whole integers only', async ({ page, request }) => {
  test.setTimeout(120_000);
  await gotoOverview(page);

  const { track, gap, trackCount } = await geometry(page);
  expect(trackCount).toBe(6); // xl:grid-cols-6 at 1920

  // host-status is the clean subject: it declares span 2, does not measure
  // itself, and therefore carries no inline span at all before this gesture
  // (asserted in tests/layout-persist.spec.ts).
  const before = await inlineSpans(page);
  expect(before['host-status']).toBe('');

  await expect(page.locator('[data-panel-id="host-status"] [data-layout-resize]')).toHaveCount(1);

  // Aim at the exact right edge a 4-track item would have. The geometry is the
  // pointer's target; the expected answer is the literal 4.
  const g1 = await grabRightEdge(page, 'host-status');
  await page.mouse.move(g1.box.left + 4 * track + 3 * gap, g1.y, { steps: 12 });
  // While the pointer is down the indicator exists and the REAL card has not
  // moved: live preview is a line, not a reflow.
  await expect(page.locator('[data-layout-resize-indicator]')).toHaveCount(1);
  expect((await cardBox(page, 'host-status')).width).toBeCloseTo(g1.box.width, 0);
  // P9's "at all times" clause, checked while the pointer is still down.
  expectEverySpanWellFormed(await inlineSpans(page));
  expect(await strayDragStyles(page)).toEqual([]);
  await page.mouse.up();
  await page.waitForTimeout(600);

  expect((await inlineSpans(page))['host-status']).toBe('span 4 / span 4');
  await expect(page.locator('[data-layout-resize-indicator]')).toHaveCount(0);

  // Whole integers only: 30px past the span-3 edge is nowhere near the span-4
  // boundary, so it must land on exactly 3 and never on 3-point-anything.
  const g2 = await grabRightEdge(page, 'host-status');
  await page.mouse.move(g2.box.left + 3 * track + 2 * gap + 30, g2.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  expect((await inlineSpans(page))['host-status']).toBe('span 3 / span 3');

  // ...and down to the floor.
  const g3 = await grabRightEdge(page, 'host-status');
  await page.mouse.move(g3.box.left + track, g3.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  expect((await inlineSpans(page))['host-status']).toBe('span 1 / span 1');

  expectEverySpanWellFormed(await inlineSpans(page));

  const blob = await savedBlob(request);
  expect(blob.layout.spans['host-status']).toBe(1);
  expectPersistedBlobIsValid(blob);
});

test('P9: a resized span survives a reload, and no table overflows afterwards', async ({ page, request }) => {
  test.setTimeout(120_000);
  await gotoOverview(page);
  const { track, gap } = await geometry(page);

  const g = await grabRightEdge(page, 'host-status');
  await page.mouse.move(g.box.left + 5 * track + 4 * gap, g.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);

  expect(await tableOverflow(page)).toEqual([]);
  expect(await strayDragStyles(page)).toEqual([]);

  const blob = await savedBlob(request);
  expect(blob.layout.spans['host-status']).toBe(5);
  expectPersistedBlobIsValid(blob);

  // Reload: read back from the server, not from anything the page still held.
  await gotoOverview(page);
  expect((await inlineSpans(page))['host-status']).toBe('span 5 / span 5');
  expect(await domOrder(page)).toEqual(DECLARED_ORDER); // resize moves nothing
  expect(await tableOverflow(page)).toEqual([]);
});

// ---------------------------------------------------------------------------
// Step 2 — drag to rearrange.
// ---------------------------------------------------------------------------

// The drag gesture itself is dragOntoRightHalfOf() in ./layout-helpers.ts.

test('P9a: dragging card A past card B persists the new order and it survives a reload', async ({ page, request }) => {
  test.setTimeout(120_000);
  await gotoOverview(page, 1920, 2400);
  expect(await domOrder(page)).toEqual(DECLARED_ORDER);

  // dns-hero is first; drop it on the right half of the card in slot 1.
  await dragOntoRightHalfOf(page, 'dns-hero', 1);

  const AFTER_DRAG = [
    'kpi-stack',
    'dns-hero',
    'top-consumers',
    'subnet-heatmap',
    'host-status',
    'subnet-table',
    'license-inventory',
  ];
  expect(await domOrder(page)).toEqual(AFTER_DRAG);

  const blob = await savedBlob(request);
  expect(blob.order).toEqual(AFTER_DRAG);
  expectPersistedBlobIsValid(blob);

  // P9's fifth clause, and the two structural checks.
  expect(await strayDragStyles(page)).toEqual([]);
  expectEverySpanWellFormed(await inlineSpans(page));
  expect(await tableOverflow(page)).toEqual([]);

  // The reload reads the order back from the server.
  await gotoOverview(page, 1920, 2400);
  expect(await domOrder(page)).toEqual(AFTER_DRAG);
  expect(await tableOverflow(page)).toEqual([]);
});

test('two drags in a row keep DOM order and visual order in step', async ({ page }) => {
  test.setTimeout(120_000);
  await gotoOverview(page, 1920, 2400);

  await dragOntoRightHalfOf(page, 'license-inventory', 0);
  expect(await domOrder(page)).toEqual([
    'dns-hero',
    'license-inventory',
    'kpi-stack',
    'top-consumers',
    'subnet-heatmap',
    'host-status',
    'subnet-table',
  ]);

  // Dropped on the RIGHT half of the card in slot 1, so it lands in slot 2 —
  // after that card, not before it. (This literal was written wrong first
  // time round and the run caught it, which is the point of writing it by
  // hand instead of asking moveItem what it thinks.)
  await dragOntoRightHalfOf(page, 'subnet-table', 1);
  expect(await domOrder(page)).toEqual([
    'dns-hero',
    'license-inventory',
    'subnet-table',
    'kpi-stack',
    'top-consumers',
    'subnet-heatmap',
    'host-status',
  ]);

  // Visual order is read off the rendered boxes (top, then left) and must be
  // the same list. This is the assertion a CSS-`order` implementation fails.
  const visual = await page.$$eval('[data-panel-id]', (els) =>
    els
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.getAttribute('data-panel-id'), top: Math.round(r.top), left: Math.round(r.left) };
      })
      .sort((a, b) => a.top - b.top || a.left - b.left)
      .map((x) => x.id),
  );
  expect(visual).toEqual(await domOrder(page));
  expect(await strayDragStyles(page)).toEqual([]);
  expectEverySpanWellFormed(await inlineSpans(page));
});

// ---------------------------------------------------------------------------
// Step 3 — the keyboard does everything the pointer does.
//
// Not a single page.mouse call below this line. Focus is reached by pressing
// Tab, which also proves the handle is in the tab order at all rather than
// merely focusable by script.
// ---------------------------------------------------------------------------

// activeHandlePanel, liveText and tabToHandle are in ./layout-helpers.ts.

test('P9c: a keyboard-only run moves a card two positions, changes its span, and both persist', async ({ page, request }) => {
  test.setTimeout(180_000);
  await gotoOverview(page);
  expect(await domOrder(page)).toEqual(DECLARED_ORDER);

  // Reached by Tab alone.
  const presses = await tabToHandle(page, 'dns-hero');
  expect(presses).toBeGreaterThan(0);

  // The accessible name is computed by the browser, so this catches the
  // "Move [object Object]" that a template-literal label produces for a panel
  // whose title is an element rather than a string.
  await expect(
    page.getByRole('button', { name: 'Move DNS Query Rate — 24h', exact: true }),
  ).toHaveCount(1);

  // Enter opens move mode on the focused handle.
  await page.keyboard.press('Enter');
  expect(await activeHandlePanel(page)).toBe('dns-hero');
  await expect(page.locator('[data-panel-id="dns-hero"] [data-layout-handle]')).toHaveAttribute('aria-pressed', 'true');
  expect(await liveText(page)).toContain('Position 1 of 7');

  // Two positions right. dns-hero starts at index 0, so it lands third.
  await page.keyboard.press('ArrowRight');
  expect(await liveText(page)).toBe('Moved to position 2 of 7');
  await page.keyboard.press('ArrowRight');
  expect(await liveText(page)).toBe('Moved to position 3 of 7');

  const AFTER_MOVE = [
    'kpi-stack',
    'top-consumers',
    'dns-hero',
    'subnet-heatmap',
    'host-status',
    'subnet-table',
    'license-inventory',
  ];
  expect(await domOrder(page)).toEqual(AFTER_MOVE);
  // Focus survived two re-sorts of the real DOM children.
  expect(await activeHandlePanel(page)).toBe('dns-hero');

  // dns-hero declares span={4} (Overview.jsx), so two Arrow Ups take it to 6.
  await page.keyboard.press('ArrowUp');
  expect(await liveText(page)).toBe('Width 5 of 6 columns');
  await page.keyboard.press('ArrowUp');
  expect(await liveText(page)).toBe('Width 6 of 6 columns');
  expect((await inlineSpans(page))['dns-hero']).toBe('span 6 / span 6');
  expect(await activeHandlePanel(page)).toBe('dns-hero');

  // Nothing has been written yet — Enter is what saves.
  expect((await request.get(`/api/views/${VIEW}`)).status()).toBe(404);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  expect(await liveText(page)).toContain('Layout saved');
  await expect(page.locator('[data-panel-id="dns-hero"] [data-layout-handle]')).toHaveAttribute('aria-pressed', 'false');

  const blob = await savedBlob(request);
  expect(blob.order).toEqual(AFTER_MOVE);
  expect(blob.layout.spans['dns-hero']).toBe(6);
  expectPersistedBlobIsValid(blob);

  // Both halves come back from the server.
  await gotoOverview(page);
  expect(await domOrder(page)).toEqual(AFTER_MOVE);
  expect((await inlineSpans(page))['dns-hero']).toBe('span 6 / span 6');
  expectEverySpanWellFormed(await inlineSpans(page));
  expect(await strayDragStyles(page)).toEqual([]);
  expect(await tableOverflow(page)).toEqual([]);
});

test('Escape restores both the pre-move order and the pre-move span, and saves nothing', async ({ page, request }) => {
  test.setTimeout(180_000);
  await gotoOverview(page);

  await tabToHandle(page, 'dns-hero');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown'); // span 4 -> 3
  expect(await liveText(page)).toBe('Width 3 of 6 columns');
  expect((await inlineSpans(page))['dns-hero']).toBe('span 3 / span 3');
  expect(await domOrder(page)).not.toEqual(DECLARED_ORDER);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  expect(await liveText(page)).toContain('back where it started');
  expect(await domOrder(page)).toEqual(DECLARED_ORDER);
  // The span override is gone too, so the declared SPAN_CLASS is back in charge.
  expect((await inlineSpans(page))['dns-hero']).toBe('');
  expect(await activeHandlePanel(page)).toBe('dns-hero');

  // A cancelled move writes nothing at all.
  expect((await request.get(`/api/views/${VIEW}`)).status()).toBe(404);
  expect(await tableOverflow(page)).toEqual([]);
});

test('arrow keys do nothing until move mode is entered', async ({ page, request }) => {
  test.setTimeout(120_000);
  await gotoOverview(page);
  await tabToHandle(page, 'dns-hero');

  // Focused, but not in move mode: arrows must not move anything.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400);
  expect(await domOrder(page)).toEqual(DECLARED_ORDER);
  expect((await inlineSpans(page))['dns-hero']).toBe('');
  expect((await request.get(`/api/views/${VIEW}`)).status()).toBe(404);
});

// ---------------------------------------------------------------------------
// Step 4 — the three defects the 2026-08-07 correctness review found.
// ---------------------------------------------------------------------------

const focusedLabel = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? null);

// Observed live before the fix: focus was parked in "Filter subnets", the 30s
// poll re-rendered CardGrid, and the focus-restore effect — which had no
// condition on WHERE focus currently was — pulled it onto a Move handle. The
// operator is then typing into nothing, and their next arrow key silently
// reorders the dashboard.
//
// Two separate faults, both asserted here: move mode never ended when focus
// left the handle, and the restore effect stole focus it had not lost.
test('move mode ends when focus leaves the handle, and the data poll never takes focus back', async ({ page, request }) => {
  test.setTimeout(180_000);
  await gotoOverview(page);

  await tabToHandle(page, 'dns-hero');
  await page.keyboard.press('Enter');
  const handle = page.locator('[data-panel-id="dns-hero"] [data-layout-handle]');
  await expect(handle).toHaveAttribute('aria-pressed', 'true');

  // The operator gives up on the move and goes back to work.
  const filter = page.getByLabel('Filter subnets');
  await filter.click();
  await filter.fill('10.');
  await page.waitForTimeout(400);

  // A blur that is NOT the component's own re-render ends move mode.
  await expect(handle).toHaveAttribute('aria-pressed', 'false');
  expect(await activeHandlePanel(page)).toBeNull();
  expect(await focusedLabel(page)).toBe('Filter subnets');

  // Now the poll. Counting the requests so the wait is proven to have covered
  // a real re-render rather than merely a timeout.
  let polls = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/data')) polls++;
  });
  await page.waitForTimeout(35_000);
  expect(polls, 'the 30s poll never fired, so this proves nothing').toBeGreaterThan(0);

  expect(await focusedLabel(page)).toBe('Filter subnets');
  expect(await activeHandlePanel(page)).toBeNull();

  // The very next arrow key is a caret move inside the input, not a reorder.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400);
  expect(await domOrder(page)).toEqual(DECLARED_ORDER);
  expect((await request.get(`/api/views/${VIEW}`)).status()).toBe(404);
});

// The fit map used to be emptied by every layout change: `grid` is a memo
// whose deps include `layout`, so a drop/resize/arrow press ran the Card
// effect's cleanup (grid.remove) for every card, and nothing re-added them
// until the next data poll. In that window applyLayout had no measured span to
// clamp, so a card kept the `span 4 / span 4` written for six tracks while the
// window was narrowed to two — implicit columns, and the page overflowed
// sideways.
test('a drag then a narrow window leaves no card wider than the tracks that exist', async ({ page }) => {
  test.setTimeout(120_000);
  await gotoOverview(page, 1920, 2400);
  await dragOntoRightHalfOf(page, 'dns-hero', 1);

  // Narrowed straight away — deliberately inside the window before the 30s
  // poll re-renders the Cards and repairs the map by accident.
  await page.setViewportSize({ width: 390, height: 2400 });
  await page.waitForTimeout(1000);

  const doc = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(doc.scrollWidth, `page overflows horizontally: ${doc.scrollWidth} > ${doc.clientWidth}`)
    .toBeLessThanOrEqual(doc.clientWidth);

  // grid-cols-2 declares two tracks at 390px. getComputedStyle reports the
  // IMPLICIT ones too, so anything above 2 here is a card asking for columns
  // the grid never declared.
  const { trackCount } = await geometry(page);
  expect(trackCount, 'implicit columns were created').toBe(2);

  const spans = await inlineSpans(page);
  for (const [id, value] of Object.entries(spans)) {
    if (value === '') continue;
    const n = Number(/span (\d+)/.exec(value)![1]);
    expect(n, `${id} renders ${value} against 2 tracks`).toBeLessThanOrEqual(2);
  }

  // tableOverflow() is deliberately NOT asserted here. At 390px the License
  // Inventory table needs 360px inside a 304px wrapper and scrolls, drag or no
  // drag: measured identically on a clean 390 load and on a 1920 load narrowed
  // to 390 with no gesture at all. Asserting [] here would be asserting that a
  // phone-width table does not scroll, which is not what this test is about.
  const spanValues = Object.values(spans).filter(Boolean);
  expect(spanValues.length, 'no card carries a measured span, so this proves nothing').toBeGreaterThan(0);
});

// MAX_SPAN was announced where trackCount is what renders. Verified live at
// 390px (2 tracks) before the fix: ArrowUp said "Width 3 of 6 columns", then
// "Width 4 of 6 columns", while the card stayed exactly as wide both times.
// The stored span is still deliberately unclamped, so the announcement names
// it separately instead of pretending it took effect.
test('at a narrow breakpoint the announced width is what renders, not the stored maximum', async ({ page }) => {
  test.setTimeout(120_000);
  await gotoOverview(page, 390, 2400);
  const { trackCount } = await geometry(page);
  expect(trackCount).toBe(2);

  await tabToHandle(page, 'dns-hero');
  await page.keyboard.press('Enter');

  const before = (await cardBox(page, 'dns-hero')).width;
  await page.keyboard.press('ArrowUp');
  expect(await liveText(page)).toBe('Width 2 of 2 columns. Set to 3, which needs a wider window.');
  await page.keyboard.press('ArrowUp');
  expect(await liveText(page)).toBe('Width 2 of 2 columns. Set to 4, which needs a wider window.');

  // The card really did not move, which is the whole complaint.
  expect((await cardBox(page, 'dns-hero')).width).toBeCloseTo(before, 0);
});

// Item 4's landmine, made loud. Overview is compatible today — every direct
// child of its CardGrid carries a panelId — so the guard must be silent here,
// and must fire the moment the grid holds a panel its own children cannot
// name. The positive case is provoked by grafting an unnamed grid item into
// the DOM, because no tab in the repo is in that shape any more: the
// service-ownership wrapper was the loudest way to end up there and is now
// hiddenPanelGroup(), a plain function returning an ARRAY, so each Card is
// once again a direct grid child carrying its own panelId. (Network, DNS and
// Security are the three tabs that combine a layoutKey with those runs, and
// the per-tab block at the bottom of this file drives all three.) The guard
// still guards the ordinary mistake — a wrapper whose call site leaves the id
// on the <Card> inside — so it is exercised by construction rather than by
// finding a tab that is already broken.
test('a grid whose DOM holds a panel its children cannot name says so, loudly', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await gotoOverview(page);
  expect(errors, 'Overview is compatible and must stay silent').toEqual([]);

  // A grid item carrying a panel id that no React child declares — the exact
  // shape a HiddenPanels-wrapped Card presents to snapshot() and sortByOrder.
  await page.evaluate(() => {
    const grid = document.querySelector('[data-card-grid]') as HTMLElement;
    const el = document.createElement('div');
    el.setAttribute('data-panel-id', 'smuggled-panel');
    grid.appendChild(el);
  });
  // Force one re-render of the grid: the guard runs after a render, not on a
  // DOM mutation it has no way to observe. Entering and leaving move mode is
  // the cheapest CardGrid re-render there is, and it writes nothing.
  await tabToHandle(page, 'dns-hero');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  expect(errors.join('\n')).toContain('smuggled-panel');
  expect(errors.join('\n')).toContain('layoutKey="overview"');
});

// ---------------------------------------------------------------------------
// Step 5 — every tab, and what replaced the unmanaged-tab test.
//
// WHAT THIS USED TO BE, AND WHY IT IS NOT THAT ANY MORE. Until 2026-08-08 this
// slot held `an unmanaged tab grows no handle, no hotspot and no live region`,
// which navigated to #network and asserted zero of each. Network is now wired
// with layoutKey="network", so it found four, and the TEST was the thing that
// was out of date — the code was right.
//
// The invariant it guarded is still real and still worth protecting: a
// CardGrid with no layoutKey must create no handle, no hotspot, no listener
// and no live region — not hidden, not disabled, not rendered. What changed is
// that NO SURFACE IN THE APP IS IN THAT STATE ANY MORE. Checked before this
// was rewritten: `grep -rn CardGrid ui/src` finds 19 render sites across the
// 15 tabs (Provision renders three, one per mode) and every one of them
// carries a layoutKey. There is nothing left for a browser to point at, so
// pointing at Network anyway — or at any other tab — would be a test that
// passes by accident and says something false in its name.
//
// The coverage was therefore split in two rather than deleted:
//
//   - the POSITIVE truth, below, in a real browser: each of the 15 tabs grows
//     exactly the chrome its own panel count entitles it to, and exactly one
//     live region. That is strictly more than the old test checked — it fails
//     on a tab that grows too LITTLE chrome as well as too much, which the old
//     zero-assertion could not do.
//   - the STRUCTURAL invariant, in ui/src/lib/layoutChrome.test.js, which
//     reads components/ui.jsx and asserts each affordance has exactly one
//     render site and that each of those sites is behind the `managed` /
//     `layoutKey` gate. It is a source-shape check and cannot prove a render;
//     it is here because `node --test` runs plain .js with no JSX transform,
//     so this repo cannot mount a React tree outside a browser, and the
//     browser has no unmanaged grid left to mount.
// ---------------------------------------------------------------------------

// tabId -> the number of panels that tab renders against the live dev feeds,
// counted in the browser on 2026-08-08 and written down by hand. `provision`
// is the subnet mode, which is the one it opens on.
const TAB_PANEL_COUNTS: Record<string, number> = {
  overview: 7,
  daily: 5,
  network: 4,
  dns: 8,
  security: 12,
  infra: 7,
  assets: 2,
  incidents: 5,
  audit: 3,
  changes: 2,
  provision: 2,
  selfservice: 4,
  editor: 1,
  drift: 1,
  ai: 2,
};

test('every tab grows exactly the layout chrome its panels entitle it to', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1920, height: 2400 });

  const seen: Record<string, unknown> = {};
  for (const [tabId, panels] of Object.entries(TAB_PANEL_COUNTS)) {
    await page.goto(`/#${tabId}`);
    await expect(page.locator('h1').first()).toBeVisible();
    await page.waitForFunction((n) => document.querySelectorAll('[data-panel-id]').length === n, panels, {
      timeout: 20_000,
    });
    await page.waitForTimeout(400);

    seen[tabId] = await page.evaluate(() => ({
      panels: document.querySelectorAll('[data-panel-id]').length,
      // One resize hotspot and one hide button PER PANEL, and one move handle
      // per panel ONLY on a tab that shows two or more of them — see the
      // expected object below. The affordances are per-Card and gated on
      // `managed`, so a count that disagrees is a Card that lost its gate or a
      // Card that never got one.
      handles: document.querySelectorAll('[data-layout-handle]').length,
      hotspots: document.querySelectorAll('[data-layout-resize]').length,
      hides: document.querySelectorAll('[data-layout-hide]').length,
      // Exactly ONE per managed grid, and never inside it — see the comment at
      // its render site. Two would mean two grids announcing over each other.
      live: document.querySelectorAll('[data-layout-live]').length,
      grids: document.querySelectorAll('[data-card-grid]').length,
      // The "Arrange panels" strip. Standing chrome now, not a thing that only
      // appears once a panel has already vanished — see the expected object
      // below for the one tab shape that still has none.
      strips: document.querySelectorAll('[data-testid="hidden-tiles"]').length,
      // And it holds exactly one button per strip, never one per panel.
      arrange: document.querySelectorAll('[data-layout-arrange]').length,
    }));

    // MOVING NEEDS SOMEWHERE TO MOVE TO, so the handle count is not simply the
    // panel count. #editor renders exactly one panel (editor-object-form) and
    // always will, and #drift renders one until a drift check runs — on a
    // one-panel grid the ⠿ handle had nothing to drag past, move mode's arrow
    // keys moved nothing, and the ⓘ help still said "You can move this panel".
    // The handle is now gated on `managed && reorderable`, so it is absent
    // there and present on every panel of every tab that shows two or more.
    //
    // Written as an expression rather than as two literals per tab on purpose:
    // it is one rule, and it fails in BOTH directions. A tab that shows two
    // panels and grows fewer handles than panels fails, and a one-panel tab
    // that grows any handle at all fails — which is exactly what #editor and
    // #drift did before this change. The hotspot and the hide count stay at
    // `panels` for every tab, because resizing and hiding do real work on a
    // one-panel grid and must keep doing it.
    const expectedHandles = panels >= 2 ? panels : 0;
    // THE STRIP RIDES THE SAME RULE AS THE HANDLE, and it is the same rule for
    // the same reason: `reorderable`. A tab showing one panel has nothing to
    // rearrange, and nothing is hidden anywhere in this run, so #editor and
    // #drift grow no strip at all — while every multi-panel tab grows exactly
    // one, whether or not anything has ever been hidden on it. Before
    // 2026-08-09 this was `strips: 0` everywhere, because the strip only
    // existed after a panel had already been taken off the page.
    const expectedStrips = panels >= 2 ? 1 : 0;

    expect(seen[tabId], `#${tabId}`).toEqual({
      panels,
      handles: expectedHandles,
      hotspots: panels,
      hides: panels,
      live: 1,
      grids: 1,
      strips: expectedStrips,
      arrange: expectedStrips,
    });
  }

  // The rule above is only worth having if the suite actually contains both
  // shapes. Asserted rather than assumed: if every tab in TAB_PANEL_COUNTS
  // grew past one panel, `panels >= 2 ? panels : 0` would be an untested branch
  // dressed up as a check.
  const counts = Object.values(TAB_PANEL_COUNTS);
  expect(counts.filter((n) => n === 1).length, 'no one-panel tab left, so the handle rule proves nothing')
    .toBeGreaterThan(0);
  expect(counts.filter((n) => n >= 2).length, 'no multi-panel tab left, so the handle rule proves nothing')
    .toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Step 6 — the three tabs the old blocker made impossible.
//
// Network, DNS and Security each carry at least one hiddenPanelGroup() run.
// While that wrapper was a component returning a fragment, a whole run of
// Cards sat behind ONE React child with no panelId, so those three tabs could
// not be given a layoutKey at all without the grid saving an order it could
// not restore. The wrapper is a function returning an array now, so this block
// proves the three gestures actually work THERE — on the tabs that were
// blocked — and not merely on Overview, which never had the problem.
//
// Each phase starts from a deleted view so its expected order is the DECLARED
// one, written out by hand from the tab's JSX rather than carried over from
// the phase before.
// ---------------------------------------------------------------------------

type TabCase = {
  id: string;
  declared: string[];
  // A panel that neither measures itself nor carries a saved span, so its
  // inline gridColumn is empty on a clean load — the clean subject for a
  // resize, exactly as host-status is on Overview.
  resizeSubject: string;
  // The declared span of declared[0], read off its SPAN_CLASS in the JSX. One
  // ArrowUp takes it to this + 1.
  firstDeclaredSpan: number;
};

const TAB_CASES: TabCase[] = [
  {
    id: 'network',
    declared: [
      'network-utilization-distribution',
      'network-ipam-spaces',
      'network-dhcp-leases', // inside hiddenPanelGroup({...SERVICE_GROUPS.dhcp})
      'network-exhaustion',
    ],
    resizeSubject: 'network-ipam-spaces',
    firstDeclaredSpan: 3,
  },
  {
    id: 'dns',
    declared: [
      'dns-query-rate', // hiddenPanelGroup run #1
      'dns-zone-kpis',
      'dns-services', // hiddenPanelGroup run #2
      'dns-query-volume-7d',
      'dns-zones',
      'dns-dnssec-health',
      'dns-rpz',
      'dns-dtc-lbdn',
    ],
    resizeSubject: 'dns-zone-kpis',
    firstDeclaredSpan: 4,
  },
  {
    id: 'security',
    declared: [
      // The first three are one hiddenPanelGroup run of three Cards — the
      // exact shape that used to collapse into a single unnamed grid child.
      'security-threat-events',
      'security-response-summary',
      'security-triage-inbox',
      'security-lookalike-domains',
      'security-ctem-exposure',
      'security-asset-insights',
      'security-exposures',
      'security-asset-risk',
      'security-exposed-surface',
      'security-ctem-assets',
      'security-threat-feed-activity',
      'security-soc-insights',
    ],
    resizeSubject: 'security-response-summary',
    firstDeclaredSpan: 4,
  },
];

for (const tab of TAB_CASES) {
  const view = `__layout_${tab.id}`;
  // Dropping declared[0] on the right half of the card in slot 1 puts it in
  // slot 1 and lifts declared[1] to the front — the same insertion arithmetic
  // P9a spells out for Overview, and the same result one ArrowRight gives.
  const swapped = [tab.declared[1], tab.declared[0], ...tab.declared.slice(2)];

  test.describe(`per-tab layout: #${tab.id}`, () => {
    test.beforeEach(async ({ request }) => {
      await request.delete(`/api/views/${view}`);
    });
    // This spec is this view's only writer; leave the tenant as it was found so
    // nothing else in the suite loads a layout it did not ask for. afterEach
    // rather than afterAll because `request` is a test-scoped fixture and
    // Playwright refuses it in a beforeAll/afterAll hook.
    test.afterEach(async ({ request }) => {
      await request.delete(`/api/views/${view}`);
    });

    test(`edge-drag resize writes a whole-integer span through the validated path`, async ({ page, request }) => {
      test.setTimeout(120_000);
      await gotoTab(page, tab.id, tab.declared.length);
      expect(await domOrder(page)).toEqual(tab.declared);

      const { track, gap, trackCount } = await geometry(page);
      expect(trackCount).toBe(6); // xl:grid-cols-6 at 1920
      expect((await inlineSpans(page))[tab.resizeSubject]).toBe('');

      const g = await grabRightEdge(page, tab.resizeSubject);
      await page.mouse.move(g.box.left + 4 * track + 3 * gap, g.y, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(600);

      expect((await inlineSpans(page))[tab.resizeSubject]).toBe('span 4 / span 4');
      expectEverySpanWellFormed(await inlineSpans(page));
      expect(await strayDragStyles(page)).toEqual([]);
      expect(await tableOverflow(page)).toEqual([]);

      const blob = await savedBlobFor(request, view);
      expect(blob.layout.spans[tab.resizeSubject]).toBe(4);
      expect(blob.layout.hidden).toEqual([]); // resizing hides nothing
      expectPersistedBlobIsValid(blob);

      // Read back from the server, not from anything the page still held.
      await gotoTab(page, tab.id, tab.declared.length);
      expect((await inlineSpans(page))[tab.resizeSubject]).toBe('span 4 / span 4');
      expect(await domOrder(page)).toEqual(tab.declared); // resize moves nothing
    });

    test(`a pointer drag rearranges it and the new order survives a reload`, async ({ page, request }) => {
      test.setTimeout(120_000);
      await gotoTab(page, tab.id, tab.declared.length);
      expect(await domOrder(page)).toEqual(tab.declared);

      await dragOntoRightHalfOf(page, tab.declared[0], 1);
      expect(await domOrder(page)).toEqual(swapped);

      const blob = await savedBlobFor(request, view);
      expect(blob.order).toEqual(swapped);
      expectPersistedBlobIsValid(blob);
      expect(await strayDragStyles(page)).toEqual([]);
      expect(await tableOverflow(page)).toEqual([]);

      await gotoTab(page, tab.id, tab.declared.length);
      expect(await domOrder(page)).toEqual(swapped);
    });

    test(`a keyboard-only move reaches the same saved layout`, async ({ page, request }) => {
      test.setTimeout(180_000);
      await gotoTab(page, tab.id, tab.declared.length);
      expect(await domOrder(page)).toEqual(tab.declared);

      // Reached by Tab alone — no page.mouse call in this test.
      await tabToHandle(page, tab.declared[0]);
      await page.keyboard.press('Enter');
      expect(await liveText(page)).toContain(`Position 1 of ${tab.declared.length}`);

      await page.keyboard.press('ArrowRight');
      expect(await liveText(page)).toBe(`Moved to position 2 of ${tab.declared.length}`);
      expect(await domOrder(page)).toEqual(swapped);
      // Focus survived a re-sort of the real DOM children.
      expect(await activeHandlePanel(page)).toBe(tab.declared[0]);

      await page.keyboard.press('ArrowUp');
      const widened = tab.firstDeclaredSpan + 1;
      expect(await liveText(page)).toBe(`Width ${widened} of 6 columns`);
      expect((await inlineSpans(page))[tab.declared[0]]).toBe(`span ${widened} / span ${widened}`);

      // Nothing has been written yet — Enter is what saves.
      expect((await request.get(`/api/views/${view}`)).status()).toBe(404);

      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);
      expect(await liveText(page)).toContain('Layout saved');

      const blob = await savedBlobFor(request, view);
      expect(blob.order).toEqual(swapped);
      expect(blob.layout.spans[tab.declared[0]]).toBe(widened);
      expectPersistedBlobIsValid(blob);

      await gotoTab(page, tab.id, tab.declared.length);
      expect(await domOrder(page)).toEqual(swapped);
      expect((await inlineSpans(page))[tab.declared[0]]).toBe(`span ${widened} / span ${widened}`);
      expect(await tableOverflow(page)).toEqual([]);
    });
  });
}
