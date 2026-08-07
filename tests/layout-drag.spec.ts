import { test, expect } from './fixtures';
import { validateSave } from '../ui/src/lib/layout.js';

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
// off ui/src/tabs/Overview.jsx. None is recomputed with the app's own logic.

// ---------------------------------------------------------------------------
// RUN THIS FILE WITH --workers=1 ALONGSIDE tests/layout-persist.spec.ts.
//
// Measured, not guessed: playwright.config.ts sets no `workers`, so the
// default is 2 on this machine, and Playwright spreads SPEC FILES across
// workers even though both files are `mode: 'serial'` internally. This file
// and layout-persist.spec.ts both own the one server-side view
// `__layout_overview` — Overview is the only tab wired with a layoutKey — and
// layout-persist additionally SIGTERMs the Go binary as part of P8. Run in
// parallel they corrupt each other: on the first full-suite run, P9b read back
// `host-status: 4`, which is layout-persist's SAVE_BODY, not anything a drag
// wrote, and P8 read an order this file had just saved.
//
// Neither file is wrong on its own; they are simply two exclusive owners of
// one resource. The fix is one line in playwright.config.ts (`workers: 1`) or
// merging the two files, and both are decisions for whoever owns that config.
// Until then: `npx playwright test --workers=1`.
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

// The drag tests run in a viewport tall enough to hold all seven panels at
// once (height 2400, not 1080). That is a limitation of the FEATURE, stated
// plainly rather than worked around: a drag does not auto-scroll the page, so
// a card whose target slot is off-screen cannot be dropped there by pointer
// today. The keyboard route has no such limit — it moves by position, not by
// pixels — which is one more reason step 3 is not a courtesy.
async function gotoOverview(page: Page, width = 1920, height = 1080) {
  await page.setViewportSize({ width, height });
  await page.goto('/#overview');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-panel-id]').length === 7,
    { timeout: 20_000 },
  );
  // The layout GET resolves on mount and applyLayout re-runs on a rAF; the
  // DataTables measure themselves on top of that.
  await page.waitForTimeout(1200);
}

const domOrder = (page: Page) =>
  page.$$eval('[data-panel-id]', (els) => els.map((e) => e.getAttribute('data-panel-id')));

// The grid's own geometry, read the same way the browser reports it. Used to
// aim the pointer — never to compute an expected result.
const geometry = (page: Page) =>
  page.evaluate(() => {
    const grid = document.querySelector('[data-card-grid]') as HTMLElement;
    const cs = getComputedStyle(grid);
    const tracks = cs.gridTemplateColumns.split(' ').filter(Boolean);
    return { track: parseFloat(tracks[0]), gap: parseFloat(cs.columnGap) || 0, trackCount: tracks.length };
  });

const cardBox = (page: Page, id: string) =>
  page.evaluate((panelId) => {
    const el = document.querySelector(`[data-panel-id="${panelId}"]`) as HTMLElement;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }, id);

// The inline gridColumn of every managed card, exactly as applyLayout wrote it.
const inlineSpans = (page: Page) =>
  page.$$eval('[data-panel-id]', (els) => {
    const out: Record<string, string> = {};
    for (const el of els) out[el.getAttribute('data-panel-id')!] = (el as HTMLElement).style.gridColumn || '';
    return out;
  });

// P9's third clause, applied to whatever is on screen right now.
function expectEverySpanWellFormed(spans: Record<string, string>) {
  for (const [id, value] of Object.entries(spans)) {
    if (value === '') continue; // no override and no measurement: the declared class is in charge
    expect(value, `${id} carries a malformed gridColumn`).toMatch(/^span [1-6] \/ span [1-6]$/);
  }
}

// P9's fifth clause. A drag that left a transform, a left or a top on a real
// card means the ghost was not a ghost.
const strayDragStyles = (page: Page) =>
  page.$$eval('[data-panel-id]', (els) =>
    els
      .map((el) => {
        const s = (el as HTMLElement).style;
        const stray = [
          s.transform ? `transform:${s.transform}` : '',
          s.translate ? `translate:${s.translate}` : '',
          s.left ? `left:${s.left}` : '',
          s.top ? `top:${s.top}` : '',
          s.position ? `position:${s.position}` : '',
        ].filter(Boolean);
        return stray.length ? `${el.getAttribute('data-panel-id')}: ${stray.join(', ')}` : null;
      })
      .filter(Boolean),
  );

// The regression that matters most here: re-entering the measurement loops
// shows up as a table wider than the wrapper that is supposed to contain it.
const tableOverflow = (page: Page) =>
  page.$$eval('table', (tables) =>
    tables
      .map((t) => {
        const wrap = t.parentElement as HTMLElement;
        return wrap.scrollWidth > wrap.clientWidth
          ? { panel: t.closest('[data-panel-id]')?.getAttribute('data-panel-id') ?? '?', scrollWidth: wrap.scrollWidth, clientWidth: wrap.clientWidth }
          : null;
      })
      .filter(Boolean),
  );

// Keeps a pointer target inside the viewport: the mouse cannot be moved to a
// y the browser is not showing.
function clampY(page: Page, y: number) {
  const h = page.viewportSize()?.height ?? 1080;
  return Math.min(Math.max(y, 8), h - 10);
}

// Grabs a card's right-edge hotspot and presses, without committing.
//
// The grab point is 20px below the card's TOP, not its vertical middle: a card
// resized down to one track grows past 500px tall, and its midpoint then falls
// outside a 1080px viewport where the mouse cannot reach it. That is not a
// hypothetical — it is what made the first run of this file fail.
async function grabRightEdge(page: Page, id: string) {
  await page.locator(`[data-panel-id="${id}"]`).scrollIntoViewIfNeeded();
  const box = await cardBox(page, id);
  const y = clampY(page, box.top + 20);
  await page.mouse.move(box.right - 2, y);
  await page.mouse.down();
  return { box, y };
}

async function savedBlob(request: import('@playwright/test').APIRequestContext) {
  const res = await request.get(`/api/views/${VIEW}`);
  expect(res.status(), 'nothing was saved').toBe(200);
  return await res.json();
}

// The blob the server hands back carries ViewWrite's envelope
// (widgets/folder/saved_at), which validateSave — correctly — rejects. What
// P9 asks is that the PAYLOAD the UI sent passes it, so the envelope is
// stripped and the exact save shape is rebuilt before it is checked.
function expectPersistedBlobIsValid(blob: any) {
  const verdict = validateSave({ name: blob.name, order: blob.order, layout: blob.layout });
  expect(verdict.ok, `persisted blob rejected: ${verdict.error}`).toBe(true);
}

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

// Drops the card `id` onto the right half of whatever card is currently at DOM
// position `slot`. That aim gives the same insertion index whichever row the
// two cards happen to be on: the dragged card is counted either because the
// pointer is past its midpoint (same row) or because it is below it entirely
// (lower row), and the card to the RIGHT of the target is never counted,
// because the pointer stops short of the target's own right edge.
async function dragOntoRightHalfOf(page: Page, id: string, slot: number) {
  const ids = await domOrder(page);
  const targetBox = await cardBox(page, ids[slot]!);
  const handle = page.locator(`[data-panel-id="${id}"] [data-layout-handle]`);
  await expect(handle).toHaveCount(1);
  const hb = (await handle.boundingBox())!;
  const before = await cardBox(page, id);

  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 40, hb.y + 40, { steps: 5 });
  await page.mouse.move(
    (targetBox.left + targetBox.right) / 2 + 20,
    clampY(page, targetBox.top + 20),
    { steps: 15 },
  );

  // Mid-drag: the ghost and the insertion line exist, and the REAL card has
  // not moved a pixel. A card that moved mid-drag is the failure this whole
  // design exists to prevent.
  await expect(page.locator('[data-layout-ghost]')).toHaveCount(1);
  await expect(page.locator('[data-layout-insert-line]')).toHaveCount(1);
  // P9's "at all times" clause again — mid-drag, not only after the drop.
  expectEverySpanWellFormed(await inlineSpans(page));
  expect(await strayDragStyles(page)).toEqual([]);
  const during = await cardBox(page, id);
  expect(during.left, 'the real card moved mid-drag').toBeCloseTo(before.left, 0);
  expect(during.top, 'the real card moved mid-drag').toBeCloseTo(before.top, 0);
  expect(during.width, 'the real card resized mid-drag').toBeCloseTo(before.width, 0);

  await page.mouse.up();
  await page.waitForTimeout(700);
  await expect(page.locator('[data-layout-ghost]')).toHaveCount(0);
  await expect(page.locator('[data-layout-insert-line]')).toHaveCount(0);
}

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

const activeHandlePanel = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || !el.hasAttribute('data-layout-handle')) return null;
    return el.closest('[data-panel-id]')?.getAttribute('data-panel-id') ?? null;
  });

const liveText = (page: Page) => page.locator('[data-layout-live]').innerText();

async function tabToHandle(page: Page, id: string, max = 400) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if ((await activeHandlePanel(page)) === id) return i + 1;
  }
  throw new Error(`the ${id} move handle was not reachable within ${max} Tab presses`);
}

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
// the DOM, because no tab in the repo combines layoutKey with HiddenPanels
// (which is exactly why this is a landmine and not a live bug).
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

test('an unmanaged tab grows no handle, no hotspot and no live region', async ({ page }) => {
  // #network has no layoutKey, so item 8 must be structurally absent there —
  // not hidden, not disabled, not rendered.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#network');
  await page.waitForSelector('[data-card-grid]', { timeout: 20_000 });
  await page.waitForTimeout(1200);

  expect(await page.locator('[data-layout-resize]').count()).toBe(0);
  expect(await page.locator('[data-layout-handle]').count()).toBe(0);
  expect(await page.locator('[data-layout-live]').count()).toBe(0);
});
