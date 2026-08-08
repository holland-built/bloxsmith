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

// Drops the card `id` onto the right half of whatever card is currently at DOM
// position `slot`. That aim gives the same insertion index whichever row the
// two cards happen to be on: the dragged card is counted either because the
// pointer is past its midpoint (same row) or because it is below it entirely
// (lower row), and the card to the RIGHT of the target is never counted,
// because the pointer stops short of the target's own right edge.
export async function dragOntoRightHalfOf(page: Page, id: string, slot: number) {
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
