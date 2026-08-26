import { expect } from '@playwright/test';
import { validateSave } from '../ui/src/lib/layout.js';

// The gestures of item 8 — grab a card, drag it, resize it, drive it from the
// keyboard — factored out of tests/layout-drag.spec.ts so that a second spec
// can perform the SAME gesture rather than a lookalike of it.
//
// WHY THIS FILE EXISTS AT ALL. tests/hidden-tiles.spec.ts has to prove that a
// drag does not wipe the hidden list. If it re-implemented "drag a card" with
// its own pointer arithmetic, a change to the real gesture could leave that
// spec passing against a drag the app no longer performs — the regression
// would be invisible in exactly the file written to catch it. One
// implementation, two callers, so both specs move together.
//
// Nothing here decides an expected value. Every function either drives the
// browser or reads geometry back out of it; the literals stay hand-written in
// the specs, next to the behaviour they describe.

type Page = import('@playwright/test').Page;

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

// Waits on the exact panel count rather than on a selector, because a tab
// paints its first card well before its last: a `waitForSelector` here would
// hand back a half-mounted grid and every order assertion would race it.
//
// The default viewport is TALL (2400, not 1080) for the drag tests. That is a
// limitation of the FEATURE, stated plainly rather than worked around: a drag
// does not auto-scroll the page, so a card whose target slot is off-screen
// cannot be dropped there by pointer today. The keyboard route has no such
// limit — it moves by position, not by pixels.
export async function gotoTab(page: Page, tabId: string, panelCount: number, width = 1920, height = 2400) {
  await page.setViewportSize({ width, height });
  await page.goto(`/#${tabId}`);
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-panel-id]').length === n,
    panelCount,
    { timeout: 20_000 },
  );
  // The layout GET resolves on mount and applyLayout re-runs on a rAF; the
  // DataTables measure themselves on top of that.
  await page.waitForTimeout(1200);
}

// ---------------------------------------------------------------------------
// Reading the page
// ---------------------------------------------------------------------------

export const domOrder = (page: Page) =>
  page.$$eval('[data-panel-id]', (els) => els.map((e) => e.getAttribute('data-panel-id')));

// The grid's own geometry, read the same way the browser reports it. Used to
// aim the pointer — never to compute an expected result.
export const geometry = (page: Page) =>
  page.evaluate(() => {
    const grid = document.querySelector('[data-card-grid]') as HTMLElement;
    const cs = getComputedStyle(grid);
    const tracks = cs.gridTemplateColumns.split(' ').filter(Boolean);
    return { track: parseFloat(tracks[0]), gap: parseFloat(cs.columnGap) || 0, trackCount: tracks.length };
  });

// ---------------------------------------------------------------------------
// The wide <-> narrow transition
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS. Every layout spec in this repo used to arrive at its width by
// loading fresh there, and that is exactly the case the collapse bug does NOT
// occur in. A fresh 390px load never writes an inline `span 6`, so there is
// nothing stale for the grid to trip over; the failure needs a grid that was
// laid out WIDE and is then made narrow while those spans are still on the
// elements. Measured at commit b41767a, loading #security at 1920 and narrowing
// to 390: gridTemplateColumns reported five tracks ("0px 0px 110.3px 110.3px
// 73.4px") on a grid-cols-2 grid and security-threat-events rendered 38px wide.
// A fresh 390 load of the same tab was, and is, correct. So the transition is
// the thing under test, and it needs a function that performs it honestly.
const SETTLE_MS = 800;

// Changes the viewport and waits for the grid to finish reacting to it.
//
// TWO FRAMES, NOT ONE, and that is not padding. The ResizeObserver on the grid
// delivers on the frame AFTER the layout that changed its box, and CardGrid's
// schedule() then defers applyLayout to a requestAnimationFrame of its own. A
// single frame lands between those two and reads a grid mid-repair, which would
// make this helper report the bug on a fixed build.
//
// The settle on top of that is for the bodies: a DataTable re-measures its
// columns at the new width, and a changed measurement republishes a need, which
// schedules one more applyLayout. Height is carried over from the current
// viewport so a caller narrowing a 2400px-tall page does not silently shorten it.
export async function narrowTo(page: Page, width: number, height?: number) {
  await page.setViewportSize({ width, height: height ?? page.viewportSize()?.height ?? 2400 });
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.waitForTimeout(SETTLE_MS);
}

// Everything about the grid that a breakpoint change is allowed to move, in one
// read, so "and it is identical a second later" can be a single toEqual.
//
// `rendered` is the track count the BROWSER produced (implicit columns and all);
// `declared` is the --grid-tracks the CSS set at this breakpoint, which is the
// same number readGeometry works from. The two disagreeing is the bug, stated
// directly: anything above `declared` is a column no rule ever asked for.
export const gridShape = (page: Page) =>
  page.evaluate(() => {
    const grid = document.querySelector('[data-card-grid]') as HTMLElement;
    if (!grid) return null;
    const cs = getComputedStyle(grid);
    const tracks = cs.gridTemplateColumns.split(' ').filter(Boolean);
    const cards = [...document.querySelectorAll('[data-panel-id]')].map((el) => ({
      id: el.getAttribute('data-panel-id')!,
      // Rounded to whole pixels: sub-pixel jitter between two reads of a
      // stationary card is the browser's rounding, not an oscillation.
      width: Math.round((el as HTMLElement).getBoundingClientRect().width),
      span: (el as HTMLElement).style.gridColumn || '',
    }));
    return {
      rendered: tracks.length,
      declared: Number(cs.getPropertyValue('--grid-tracks').trim()),
      trackPx: tracks.join(' '),
      gridWidth: grid.clientWidth,
      gap: parseFloat(cs.columnGap) || 0,
      cards,
    };
  });

export const cardBox = (page: Page, id: string) =>
  page.evaluate((panelId) => {
    const el = document.querySelector(`[data-panel-id="${panelId}"]`) as HTMLElement;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }, id);

// The inline gridColumn of every managed card, exactly as applyLayout wrote it.
export const inlineSpans = (page: Page) =>
  page.$$eval('[data-panel-id]', (els) => {
    const out: Record<string, string> = {};
    for (const el of els) out[el.getAttribute('data-panel-id')!] = (el as HTMLElement).style.gridColumn || '';
    return out;
  });

// P9's third clause, applied to whatever is on screen right now.
export function expectEverySpanWellFormed(spans: Record<string, string>) {
  for (const [id, value] of Object.entries(spans)) {
    if (value === '') continue; // no override and no measurement: the declared class is in charge
    expect(value, `${id} carries a malformed gridColumn`).toMatch(/^span [1-6] \/ span [1-6]$/);
  }
}

// P9's fifth clause. A drag that left a transform, a left or a top on a real
// card means the ghost was not a ghost.
export const strayDragStyles = (page: Page) =>
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
export const tableOverflow = (page: Page) =>
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

// ---------------------------------------------------------------------------
// Pointer gestures
// ---------------------------------------------------------------------------

// Keeps a pointer target inside the viewport: the mouse cannot be moved to a
// y the browser is not showing.
export function clampY(page: Page, y: number) {
  const h = page.viewportSize()?.height ?? 1080;
  return Math.min(Math.max(y, 8), h - 10);
}

// Grabs a card's right-edge hotspot and presses, without committing.
//
// The grab point is 20px below the card's TOP, not its vertical middle: a card
// resized down to one track grows past 500px tall, and its midpoint then falls
// outside a 1080px viewport where the mouse cannot reach it. That is not a
// hypothetical — it is what made the first run of layout-drag.spec.ts fail.
export async function grabRightEdge(page: Page, id: string) {
  await page.locator(`[data-panel-id="${id}"]`).scrollIntoViewIfNeeded();
  const box = await cardBox(page, id);
  const y = clampY(page, box.top + 20);
  await page.mouse.move(box.right - 2, y);
  await page.mouse.down();
  return { box, y };
}

// Presses a panel's move handle and travels far enough for the drag to BEGIN,
// leaving the button down. The caller owns everything after that, including the
// pointerup.
//
// The 40px step matters and is not a round number chosen for looks: onHandleDown
// creates nothing until the pointer has moved more than 4px on an axis, because
// below that the gesture is a click on a button that must stay clickable and
// focusable. A caller that moves less than that gets no ghost and no insertion
// line, and would read the absence as a defect in whatever it came to measure.
//
// Extracted rather than copied. This file's own header gives the reason: a spec
// that re-implements "grab a card and drag it" with its own pointer arithmetic
// can go on passing against a gesture the app no longer performs.
export async function beginPanelDrag(page: Page, id: string) {
  const handle = page.locator(`[data-panel-id="${id}"] [data-layout-handle]`);
  await expect(handle).toHaveCount(1);
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 40, hb.y + 40, { steps: 5 });
  return hb;
}

// Drops the card `id` onto the right half of whatever card is currently at DOM
// position `slot`. That aim gives the same insertion index whichever row the
// two cards happen to be on: the dragged card is counted either because the
// pointer is past its midpoint (same row) or because it is below it entirely
// (lower row), and the card to the RIGHT of the target is never counted,
// because the pointer stops short of the target's own right edge.
export async function dragOntoRightHalfOf(page: Page, id: string, slot: number) {
  const ids = await domOrder(page);
  const targetBox = await cardBox(page, ids[slot]!);
  const before = await cardBox(page, id);

  await beginPanelDrag(page, id);
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

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

export const activeHandlePanel = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || !el.hasAttribute('data-layout-handle')) return null;
    return el.closest('[data-panel-id]')?.getAttribute('data-panel-id') ?? null;
  });

export const liveText = (page: Page) => page.locator('[data-layout-live]').innerText();

// Reaches a move handle by pressing Tab, which also proves the handle is in the
// tab order at all rather than merely focusable by script.
export async function tabToHandle(page: Page, id: string, max = 400) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if ((await activeHandlePanel(page)) === id) return i + 1;
  }
  throw new Error(`the ${id} move handle was not reachable within ${max} Tab presses`);
}

// ---------------------------------------------------------------------------
// The server side
// ---------------------------------------------------------------------------

export async function savedBlob(request: import('@playwright/test').APIRequestContext, view: string) {
  const res = await request.get(`/api/views/${view}`);
  expect(res.status(), `nothing was saved to ${view}`).toBe(200);
  return await res.json();
}

// The blob the server hands back carries ViewWrite's envelope
// (widgets/folder/saved_at), which validateSave — correctly — rejects. What
// P9 asks is that the PAYLOAD the UI sent passes it, so the envelope is
// stripped and the exact save shape is rebuilt before it is checked.
export function expectPersistedBlobIsValid(blob: any) {
  const verdict = validateSave({ name: blob.name, order: blob.order, layout: blob.layout });
  expect(verdict.ok, `persisted blob rejected: ${verdict.error}`).toBe(true);
}
