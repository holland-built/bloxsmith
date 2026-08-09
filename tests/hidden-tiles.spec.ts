import { test, expect } from './fixtures';
import {
  domOrder, dragOntoRightHalfOf, expectPersistedBlobIsValid, gotoTab, liveText,
  savedBlob as savedBlobFor, tabToHandle,
} from './layout-helpers';

// "Arrange panels" — the one window that says what is on this page, what is off
// it, and lets you change either.
//
// WHAT THIS FILE USED TO COVER, AND WHY IT CHANGED. It used to describe a strip
// that rendered BELOW every panel and only once something had been hidden. The
// reported complaint was exactly that shape: an operator pressed a panel's ✕,
// the panel vanished, and the way back was a band of chrome under seven panels
// they could not see without scrolling — and on a tab where nothing had ever
// been hidden, it did not exist at all, so there was nothing to learn from
// before you needed it. The strip is now above the grid, present on every tab
// that has two or more panels, and it is a trigger rather than the feature: one
// plainly worded button that opens a window listing both halves.
//
// NOT THE SAME FEATURE AS tests/hidden-panels.spec.ts, despite the names. That
// file covers service-ownership hiding: the APP decides, because the tenant
// owns no DHCP service, and the row it renders is `data-testid="hidden-panels"`.
// This file covers the operator deciding. Its strip keeps the testid
// `hidden-tiles` across the move, because that name says which feature it is
// and not where it sits. Nothing below touches the other testid.
//
// ---------------------------------------------------------------------------
// VIEW OWNERSHIP — read tests/layout-persist.spec.ts's header and
// playwright.config.ts's `workers: 1` comment before adding to this file.
//
// A spec that WRITES a `__layout_<key>` server view is that view's exclusive
// owner, because there is exactly one of each per tenant and a second writer
// shows up as the first one reading back an order it never saved. Measured
// under 2 workers before `workers: 1` was pinned: a drag assertion read back
// layout-persist's fixture instead of the order it had just dragged.
//
// layout-drag.spec.ts and layout-persist.spec.ts both own `__layout_overview`,
// and layout-drag additionally owns `__layout_network`, `__layout_dns` and
// `__layout_security`. This file therefore owns `__layout_daily`, which no
// other spec writes, and deletes it before and after every test so nothing
// downstream loads a layout it did not ask for.
// ---------------------------------------------------------------------------

const VIEW = '__layout_daily';
const TAB = 'daily';

// The declared JSX order in Daily.jsx's <CardGrid layoutKey="daily">, and the
// title each panel renders. Hand-written from the source, never derived.
const DECLARED_ORDER = [
  'daily-open-issues',
  'daily-security-today',
  'daily-top-capacity-risks',
  'daily-hosts-attention',
  'daily-dns-zone-issues',
];

// The tiles this file names, and the words the window has to use for them. The
// name comes from the Card's own title via registerTitle — a hidden Card
// renders null, so if that hand-up ever breaks the window falls back to the raw
// panel id and these assertions fail, which is the point of asserting the words
// rather than a count.
const OPEN_ISSUES = { id: 'daily-open-issues', name: 'Open Issues' };
const SECURITY_TODAY = { id: 'daily-security-today', name: 'Security Today' };
const HOSTS_ATTENTION = { id: 'daily-hosts-attention', name: 'Hosts Needing Attention' };

type Page = import('@playwright/test').Page;

const goto = (page: Page) => gotoTab(page, TAB, DECLARED_ORDER.length);

// A REAL reload, and this file needs one where it used to call gotoTab again.
//
// MEASURED, NOT ASSUMED: `page.goto('/#daily')` on a page already at `/#daily`
// is a same-DOCUMENT navigation — the fragment does not change, so Chromium
// never tears the React tree down. Observed on 2026-08-09 while writing the
// test below: the saved view was DELETED over the API and the tab re-`goto`d,
// and the grid still showed the order that had just been dragged, because
// nothing had remounted and no layout GET was ever re-issued. Every "and it
// came back from the server" claim in this file rests on the tree actually
// being destroyed, so it has to be page.reload().
//
// After a tile is taken off the page the grid holds one panel fewer, so the
// mount wait has to be told the smaller number or it times out on a page that
// is already right.
async function reloadTab(page: Page, panels: number) {
  await page.reload();
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-panel-id]').length === n,
    panels,
    { timeout: 20_000 },
  );
  // The layout GET resolves on mount and applyLayout re-runs on a rAF; the
  // DataTables measure themselves on top of that. Same wait gotoTab uses.
  await page.waitForTimeout(1200);
}

const strip = (page: Page) => page.getByTestId('hidden-tiles');
const arrangeBtn = (page: Page) => page.getByRole('button', { name: 'Arrange panels', exact: true });
const dialog = (page: Page) => page.locator('[data-arrange-dialog]');
const hideButton = (page: Page, id: string) => page.locator(`[data-panel-id="${id}"] [data-layout-hide]`);

const moveUp = (page: Page, name: string) => page.getByRole('button', { name: `Move up: ${name}`, exact: true });
const moveDown = (page: Page, name: string) => page.getByRole('button', { name: `Move down: ${name}`, exact: true });
const takeOff = (page: Page, name: string) =>
  page.getByRole('button', { name: `Take off the page: ${name}`, exact: true });
const putBack = (page: Page, name: string) =>
  page.getByRole('button', { name: `Put back on the page: ${name}`, exact: true });

// The order the WINDOW believes the page is in, read off its own rows. Compared
// against domOrder() to prove the two cannot drift: the window is a view of the
// grid's state, not a copy of it, so a difference here is the popup having
// grown a draft order of its own.
const popupOrder = (page: Page) =>
  page.$$eval('[data-arrange^="up:"]', (els) => els.map((e) => e.getAttribute('data-arrange')!.slice(3)));

async function openArrange(page: Page) {
  await arrangeBtn(page).click();
  await expect(dialog(page)).toBeVisible();
}

const savedBlob = (request: import('@playwright/test').APIRequestContext) => savedBlobFor(request, VIEW);

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  await request.delete(`/api/views/${VIEW}`);
});
test.afterEach(async ({ request }) => {
  await request.delete(`/api/views/${VIEW}`);
});

// ---------------------------------------------------------------------------
// 1 — the way in is there BEFORE anything goes wrong, and it is above the fold.
//
// This is the complaint, turned into an assertion. Nothing is hidden, the tab
// has never been touched, and the control still has to be on screen without
// scrolling — because the moment it is needed is the moment after a panel has
// already disappeared, which is the worst possible moment to go looking.
// ---------------------------------------------------------------------------

test('the Arrange panels button is on screen before anything is hidden, above every panel', async ({ page }) => {
  test.setTimeout(120_000);
  // A REAL laptop viewport, not the tall 2400px one the drag helpers use: the
  // whole point is that this is visible without scrolling on the screen an
  // operator actually has.
  await gotoTab(page, TAB, DECLARED_ORDER.length, 1920, 1080);

  await expect(strip(page)).toBeVisible();
  await expect(arrangeBtn(page)).toBeVisible();
  // Nothing is off the page, so the strip says nothing about it. A permanent
  // "0 tiles are off the page." is a line that never changes and so never gets
  // read.
  await expect(strip(page)).not.toContainText('off the page');

  // Above the first panel, and inside the first screenful.
  // boundingBox() reports x/y/width/height, not a DOMRect — `.top` here would
  // be undefined, and `expect(undefined).toBeLessThan(...)` fails with a
  // matcher error rather than a useful one.
  const stripBox = (await strip(page).boundingBox())!;
  const firstPanel = (await page.locator('[data-panel-id]').first().boundingBox())!;
  expect(stripBox, 'the strip has no layout box').not.toBeNull();
  expect(stripBox.y, 'the strip is not above the panels').toBeLessThan(firstPanel.y);
  expect(stripBox.y + stripBox.height, 'the strip is below the fold on a 1080px screen').toBeLessThan(1080);
  expect(await page.evaluate(() => window.scrollY), 'the page was scrolled to see it').toBe(0);
});

// ---------------------------------------------------------------------------
// 2 — the tile goes away, the strip says so in words, and the window lists it.
// ---------------------------------------------------------------------------

test('hiding a tile takes it off the grid, and the window lists it under "Off this page"', async ({ page, request }) => {
  test.setTimeout(120_000);
  await goto(page);
  expect(await domOrder(page)).toEqual(DECLARED_ORDER);

  await hideButton(page, SECURITY_TODAY.id).click();
  await page.waitForTimeout(600);

  // Gone from the DOM entirely, not collapsed and not zero-height: anything
  // left behind would still be a grid item and would still take a track.
  expect(await domOrder(page)).toEqual(DECLARED_ORDER.filter((id) => id !== SECURITY_TODAY.id));
  await expect(page.locator(`[data-panel-id="${SECURITY_TODAY.id}"]`)).toHaveCount(0);

  // The strip counts it, in the singular.
  await expect(strip(page)).toContainText('1 tile is off the page.');

  // ...and the screen-reader channel said where the way back is.
  expect(await liveText(page)).toContain(SECURITY_TODAY.name);
  expect(await liveText(page)).toContain('Arrange panels');

  // The window names it, under the right heading, with the right button.
  await openArrange(page);
  await expect(dialog(page)).toContainText('Arrange this page');
  await expect(dialog(page)).toContainText('On this page');
  await expect(dialog(page)).toContainText('Off this page');
  await expect(dialog(page)).toContainText('Changes here save right away');
  await expect(putBack(page, SECURITY_TODAY.name)).toBeVisible();
  // A hidden tile is NOT ranked among the visible ones — `order` and
  // `layout.hidden` are separate fields, and interleaving them would let this
  // window save a state dragging can never produce.
  expect(await popupOrder(page)).not.toContain(SECURITY_TODAY.id);
  expect(await popupOrder(page)).toEqual(await domOrder(page));

  // The SERVER has it — inside `layout`, where ViewWrite's top-level whitelist
  // cannot silently drop it, and in a shape the save validator accepts.
  const blob = await savedBlob(request);
  expect(blob.layout.hidden).toEqual([SECURITY_TODAY.id]);
  expectPersistedBlobIsValid(blob);
});

// ---------------------------------------------------------------------------
// 3 — the window's Move up is the SAME move a drag makes.
//
// Two routes to one saved order. If the popup ever grows its own arithmetic —
// or its own draft copy of the order — this is where it shows up, because the
// two runs start from an identical deleted view and are compared to each other
// rather than each to a literal of its own.
// ---------------------------------------------------------------------------

const MOVED_UP = [
  'daily-security-today',
  'daily-open-issues',
  'daily-top-capacity-risks',
  'daily-hosts-attention',
  'daily-dns-zone-issues',
];

test('Move up in the window saves exactly the order a drag saves', async ({ page, request }) => {
  test.setTimeout(240_000);

  // --- route A: the pointer, using the app's real drag rather than a lookalike ---
  //
  // Dragging Open Issues past Security Today and moving Security Today up past
  // Open Issues are the SAME rearrangement, expressed from either end. The
  // drag has to be written this way round because the only drop the helper
  // aims is "onto the right half of the card at slot n", and dropping a card on
  // the right half of the card immediately before it is one of the two slots
  // that mean "where you already are" — it correctly moves nothing.
  await goto(page);
  await dragOntoRightHalfOf(page, OPEN_ISSUES.id, 1);
  expect(await domOrder(page)).toEqual(MOVED_UP);
  const draggedOrder = (await savedBlob(request)).order;
  expect(draggedOrder).toEqual(MOVED_UP);

  // --- route B: the window, from the same clean start ---
  await request.delete(`/api/views/${VIEW}`);
  await reloadTab(page, DECLARED_ORDER.length);
  expect(await domOrder(page), 'the tab did not actually reload back to its declared order').toEqual(DECLARED_ORDER);

  await openArrange(page);
  // The first row cannot go up and the last cannot go down. DISABLED, not
  // missing: a button that vanishes at the ends moves every other button out
  // from under the pointer and answers nothing.
  await expect(moveUp(page, OPEN_ISSUES.name)).toBeDisabled();
  await expect(moveDown(page, OPEN_ISSUES.name)).toBeEnabled();
  await expect(moveDown(page, 'DNS Zone Issues')).toBeDisabled();

  await moveUp(page, SECURITY_TODAY.name).click();
  await page.waitForTimeout(600);

  // Same order, from the same starting point, by the other route.
  const popupSaved = (await savedBlob(request)).order;
  expect(popupSaved, 'the window and the drag disagree about what "up one" means').toEqual(draggedOrder);
  expectPersistedBlobIsValid(await savedBlob(request));

  // The grid moved with it, and the window is describing the same page — while
  // it is still open, not after a close-and-reopen that could hide a stale copy.
  expect(await domOrder(page)).toEqual(MOVED_UP);
  expect(await popupOrder(page)).toEqual(MOVED_UP);
  expect(await liveText(page)).toContain(`Moved ${SECURITY_TODAY.name} up to position 1 of 5.`);

  // Now it is at the top, its own Move up is the disabled one.
  await expect(moveUp(page, SECURITY_TODAY.name)).toBeDisabled();
  await expect(moveUp(page, OPEN_ISSUES.name)).toBeEnabled();
});

// ---------------------------------------------------------------------------
// 4 — it round-tripped through the server, not through React state.
// ---------------------------------------------------------------------------

test('a change made in the window survives a reload, both ways round', async ({ page, request }) => {
  test.setTimeout(240_000);
  await goto(page);

  // Take one off the page from inside the window.
  await openArrange(page);
  await takeOff(page, SECURITY_TODAY.name).click();
  await page.waitForTimeout(600);
  await expect(page.locator(`[data-panel-id="${SECURITY_TODAY.id}"]`)).toHaveCount(0);
  await expect(putBack(page, SECURITY_TODAY.name)).toBeVisible();
  expect((await savedBlob(request)).layout.hidden).toEqual([SECURITY_TODAY.id]);

  // And move one, so the reload has to carry both halves of the blob.
  await moveUp(page, HOSTS_ATTENTION.name).click();
  await page.waitForTimeout(600);
  const AFTER = [
    'daily-open-issues',
    'daily-hosts-attention',
    'daily-top-capacity-risks',
    'daily-dns-zone-issues',
  ];
  expect(await domOrder(page)).toEqual(AFTER);
  expect((await savedBlob(request)).order).toEqual(AFTER);

  // A full navigation: the React tree that made the changes is gone, so the
  // only place this can come back from is GET /api/views/__layout_daily.
  await reloadTab(page, DECLARED_ORDER.length - 1);
  expect(await domOrder(page)).toEqual(AFTER);
  await expect(strip(page)).toContainText('1 tile is off the page.');

  // Put it back, from the window on a page nobody has interacted with.
  await openArrange(page);
  await putBack(page, SECURITY_TODAY.name).click();
  await page.waitForTimeout(600);
  await expect(page.locator(`[data-panel-id="${SECURITY_TODAY.id}"]`)).toHaveCount(1);
  // At the END of the page, because it was not in the DOM when the order was
  // last saved and so the saved order does not name it. That is the same rule a
  // newly added panel follows, and it is stated in the panel's own About help
  // rather than papered over here.
  expect(await domOrder(page)).toEqual([...AFTER, SECURITY_TODAY.id]);
  expect(await liveText(page)).toContain(`${SECURITY_TODAY.name} is back on the page.`);
  // The "Off this page" section is gone with the last tile in it, but the way
  // in is still there — that is the whole change.
  await expect(dialog(page)).not.toContainText('Off this page');
  await expect(strip(page)).not.toContainText('off the page');

  // And the coming-back sticks too. A feature that only persists one of its two
  // states is worse than one that persists neither.
  await reloadTab(page, DECLARED_ORDER.length);
  expect((await savedBlob(request)).layout.hidden).toEqual([]);
  await expect(page.locator(`[data-panel-id="${SECURITY_TODAY.id}"]`)).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// 5 — keyboard alone, end to end, including the way out.
//
// This is the accessibility clause, and it is the one that makes hiding safe to
// ship at all: a control that can remove content has to have a way back that
// does not need a mouse. Not one page.mouse call below — every control is
// reached by pressing Tab, which also proves it is in the tab order rather than
// merely focusable by script.
// ---------------------------------------------------------------------------

const focusedInfo = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    return {
      arrange: el.hasAttribute('data-layout-arrange'),
      hide: el.hasAttribute('data-layout-hide'),
      role: el.getAttribute('role'),
      action: el.getAttribute('data-arrange'),
      label: el.getAttribute('aria-label'),
      panel: el.closest('[data-panel-id]')?.getAttribute('data-panel-id') ?? null,
    };
  });

async function tabUntil(page: Page, match: (info: any) => boolean, what: string, max = 400) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (match(await focusedInfo(page))) return i + 1;
  }
  throw new Error(`${what} was not reachable within ${max} Tab presses`);
}

test('the window can be opened, driven and closed by keyboard alone, and hands focus back', async ({ page, request }) => {
  test.setTimeout(240_000);
  await goto(page);

  // Hide, from the keyboard, so the window has something to put back.
  await tabToHandle(page, HOSTS_ATTENTION.id);
  await tabUntil(
    page,
    (info) => info?.hide && info.panel === HOSTS_ATTENTION.id,
    `the ${HOSTS_ATTENTION.id} hide button`,
  );
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  await expect(page.locator(`[data-panel-id="${HOSTS_ATTENTION.id}"]`)).toHaveCount(0);

  // Reload, so the way back has to be found on a page nobody has interacted
  // with — the state a returning operator actually arrives in.
  await reloadTab(page, DECLARED_ORDER.length - 1);

  // VISIBLE, not merely in the DOM: a way back rendered inside a collapsed or
  // sr-only container would satisfy a count and help nobody.
  const box = await arrangeBtn(page).boundingBox();
  expect(box, 'the Arrange panels button has no layout box').not.toBeNull();
  expect(box!.width, 'the Arrange panels button renders at zero width').toBeGreaterThan(0);
  expect(box!.height, 'the Arrange panels button renders at zero height').toBeGreaterThan(0);

  // Reached by Tab, from the top of the document, and opened with Enter.
  await page.keyboard.press('Tab');
  await tabUntil(page, (info) => info?.arrange, 'the Arrange panels button');
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  // Focus lands on the dialog itself, not on its ✕ — what a screen reader then
  // reads is the window and its name, rather than "Close button" with no idea
  // what would be closed.
  expect((await focusedInfo(page))?.role).toBe('dialog');

  // Reorder from inside the window, by Tab and Enter.
  await tabUntil(page, (info) => info?.action === `down:${OPEN_ISSUES.id}`, 'the first row\'s Move down');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  expect(await liveText(page)).toContain(`Moved ${OPEN_ISSUES.name} down to position 2 of 4.`);
  expect(await popupOrder(page)).toEqual(await domOrder(page));
  // Focus did not fall out of the window when the rows re-sorted under it.
  expect((await focusedInfo(page))?.action).toBe(`down:${OPEN_ISSUES.id}`);

  // Put the hidden tile back, by Tab and Enter.
  await tabUntil(page, (info) => info?.action === `back:${HOSTS_ATTENTION.id}`, 'the Put back button');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  await expect(page.locator(`[data-panel-id="${HOSTS_ATTENTION.id}"]`)).toHaveCount(1);
  expect((await savedBlob(request)).layout.hidden).toEqual([]);

  // Escape closes it, and focus goes back to the button that opened it — not to
  // <body>, which would drop a keyboard user at the top of the document.
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  expect((await focusedInfo(page))?.arrange, 'focus did not return to the Arrange panels button').toBe(true);
});

// ---------------------------------------------------------------------------
// 6 — the two states share one saved record, so each has to survive the other.
//
// `order` and `layout.hidden` live in the same `__layout_daily` blob, and every
// gesture rewrites the WHOLE blob. A hide that snapshots the order it is about
// to change, or a drag that snapshots hidden as "whatever the DOM says" (the
// DOM cannot say — a hidden tile renders nothing), silently destroys the other
// half. That is the regression most likely to bite, so it gets both directions,
// and now the window is a third writer that has to obey the same rule.
// ---------------------------------------------------------------------------

test('hiding does not wipe a saved order, and dragging does not wipe the hidden list', async ({ page, request }) => {
  test.setTimeout(240_000);
  await goto(page);
  expect(await domOrder(page)).toEqual(DECLARED_ORDER);

  // --- an order, saved by the keyboard route ---
  await tabToHandle(page, DECLARED_ORDER[0]);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);

  const ORDER_A = [
    'daily-security-today',
    'daily-open-issues',
    'daily-top-capacity-risks',
    'daily-hosts-attention',
    'daily-dns-zone-issues',
  ];
  expect(await domOrder(page)).toEqual(ORDER_A);
  {
    const blob = await savedBlob(request);
    expect(blob.order).toEqual(ORDER_A);
    expect(blob.layout.hidden).toEqual([]);
  }

  // --- direction 1: hide, and the order must still be there ---
  await hideButton(page, HOSTS_ATTENTION.id).click();
  await page.waitForTimeout(600);

  {
    const blob = await savedBlob(request);
    // Still all five, and still in ORDER_A: the hide reads the order off the
    // DOM at the moment of the click, when this panel is still on screen.
    expect(blob.order, 'hiding a tile wiped the saved order').toEqual(ORDER_A);
    expect(blob.layout.hidden).toEqual([HOSTS_ATTENTION.id]);
    expectPersistedBlobIsValid(blob);
  }

  const ORDER_A_VISIBLE = ORDER_A.filter((id) => id !== HOSTS_ATTENTION.id);
  await reloadTab(page, DECLARED_ORDER.length - 1);
  expect(await domOrder(page), 'the saved order did not survive the hide').toEqual(ORDER_A_VISIBLE);
  await expect(strip(page)).toContainText('1 tile is off the page.');

  // --- direction 2: drag, and the hidden list must still be there ---
  //
  // The same gesture layout-drag.spec.ts drives, imported rather than
  // re-implemented, so a change to the drag cannot leave this passing against
  // a drag the app no longer performs.
  await dragOntoRightHalfOf(page, 'daily-dns-zone-issues', 0);

  const ORDER_B = [
    'daily-security-today',
    'daily-dns-zone-issues',
    'daily-open-issues',
    'daily-top-capacity-risks',
  ];
  expect(await domOrder(page)).toEqual(ORDER_B);

  {
    const blob = await savedBlob(request);
    expect(blob.layout.hidden, 'the drag wiped the hidden list').toEqual([HOSTS_ATTENTION.id]);
    // Four ids now, not five: the drag reads the order off the DOM, and the
    // hidden tile is not in it. That is correct and is why bringing a tile
    // back puts it at the end rather than where it used to be.
    expect(blob.order).toEqual(ORDER_B);
    expectPersistedBlobIsValid(blob);
  }

  // --- direction 3: the window, which must not wipe either half ---
  await reloadTab(page, DECLARED_ORDER.length - 1);
  await openArrange(page);
  expect(await popupOrder(page), 'the window opened describing a page that is not on screen').toEqual(ORDER_B);
  await expect(putBack(page, HOSTS_ATTENTION.name)).toBeVisible();

  await putBack(page, HOSTS_ATTENTION.name).click();
  await page.waitForTimeout(600);
  expect(await domOrder(page)).toEqual([...ORDER_B, HOSTS_ATTENTION.id]);
  {
    const blob = await savedBlob(request);
    // ORDER_B, not ORDER_B plus the restored tile: the window snapshots the
    // order off the DOM at the moment of the click, when the tile is still off
    // the page. Same rule the ✕ follows in the other direction, and the reason
    // a tile comes back at the end rather than where it was.
    expect(blob.order, 'the window wiped the dragged order').toEqual(ORDER_B);
    expect(blob.layout.hidden).toEqual([]);
    expectPersistedBlobIsValid(blob);
  }
  await expect(dialog(page)).not.toContainText('Off this page');
});

// ---------------------------------------------------------------------------
// 7 — dragging a row inside the window.
//
// The reported ask was "inside arrange panel allow drag to location as well" —
// AS WELL, so Move up / Move down are still there and still do the whole job
// for a keyboard. What these four tests hold down is that the new gesture is
// not a second implementation of reordering: it lands on the same saved order
// the buttons produce, through the same single commit path, and it cannot
// reach the one section of the window that has no ranks to change.
// ---------------------------------------------------------------------------

// The real gesture, not a lookalike. Pointer down on the row, past the 4px
// threshold so the drag actually begins, then onto the target row and up.
//
// `where` picks which half of the target row the pointer stops in, and that is
// the whole aim: the drop slot is counted by insertionIndex against the row
// MIDPOINTS, so "above" inserts before the target and "below" inserts after it.
// Written here rather than in tests/layout-helpers.ts because this file is its
// only caller — that file exists for gestures two specs share.
async function dragRow(page: Page, id: string, targetIndex: number, where: 'above' | 'below') {
  const src = (await page.locator(`[data-arrange-row="${id}"]`).boundingBox())!;
  const dst = (await page.locator('[data-arrange-row]').nth(targetIndex).boundingBox())!;
  expect(src, `no draggable row for ${id}`).not.toBeNull();

  // 40px in from the row's left edge is over its name, never over one of its
  // three buttons — a press on a button is a click on that button, by design.
  await page.mouse.move(src.x + 40, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + 40, src.y + src.height / 2 - 12, { steps: 3 });
  await page.mouse.move(dst.x + 40, where === 'above' ? dst.y + 2 : dst.y + dst.height - 2, { steps: 12 });
  // The chrome exists while the pointer is down, and is gone after it comes up:
  // an insertion line left on <body> is a fixed-position artefact over the
  // whole app.
  await expect(page.locator('[data-arrange-insert-line]')).toHaveCount(1);
  await page.mouse.up();
  await page.waitForTimeout(700);
  await expect(page.locator('[data-arrange-insert-line]')).toHaveCount(0);
}

test('a drag inside the window saves exactly the order Move up saves', async ({ page, request }) => {
  test.setTimeout(240_000);

  // --- route A: the drag ---
  await goto(page);
  expect(await domOrder(page)).toEqual(DECLARED_ORDER);
  await openArrange(page);
  await dragRow(page, SECURITY_TODAY.id, 0, 'above');

  expect(await domOrder(page)).toEqual(MOVED_UP);
  // The window is describing the same page while it is still open — not after
  // a close-and-reopen, which could hide a stale copy.
  expect(await popupOrder(page)).toEqual(MOVED_UP);
  const draggedOrder = (await savedBlob(request)).order;
  expect(draggedOrder).toEqual(MOVED_UP);
  expectPersistedBlobIsValid(await savedBlob(request));
  // Plain words, through the same live region the buttons already use.
  expect(await liveText(page)).toContain(`Moved ${SECURITY_TODAY.name} to position 1 of 5.`);

  // --- route B: the button, from an identical clean start ---
  await request.delete(`/api/views/${VIEW}`);
  await reloadTab(page, DECLARED_ORDER.length);
  expect(await domOrder(page), 'the tab did not reload back to its declared order').toEqual(DECLARED_ORDER);
  await openArrange(page);
  await moveUp(page, SECURITY_TODAY.name).click();
  await page.waitForTimeout(600);

  expect(
    (await savedBlob(request)).order,
    'the drag and the Move up button disagree about the same rearrangement',
  ).toEqual(draggedOrder);
});

test('a dragged row is still there after a reload', async ({ page, request }) => {
  test.setTimeout(240_000);
  await goto(page);
  await openArrange(page);

  // The other direction from the test above, and the one that exercises
  // moveItem's off-by-one: dropping BELOW a row further down the list is
  // counted against a list that still contains the dragged row, so the slot has
  // to lose one on the way in. A hand-written version of that sum lands the row
  // one position short, which a reload would then make permanent.
  await dragRow(page, OPEN_ISSUES.id, 2, 'below');
  const DRAGGED_DOWN = [
    'daily-security-today',
    'daily-top-capacity-risks',
    'daily-open-issues',
    'daily-hosts-attention',
    'daily-dns-zone-issues',
  ];
  expect(await domOrder(page)).toEqual(DRAGGED_DOWN);
  expect((await savedBlob(request)).order).toEqual(DRAGGED_DOWN);

  await reloadTab(page, DECLARED_ORDER.length);
  expect(await domOrder(page), 'the dragged order did not come back from the server').toEqual(DRAGGED_DOWN);
  await openArrange(page);
  expect(await popupOrder(page)).toEqual(DRAGGED_DOWN);
});

test('a row under "Off this page" cannot be dragged into the ordered list', async ({ page, request }) => {
  test.setTimeout(240_000);
  await goto(page);
  await openArrange(page);
  await takeOff(page, HOSTS_ATTENTION.name).click();
  await page.waitForTimeout(600);
  await expect(putBack(page, HOSTS_ATTENTION.name)).toBeVisible();

  const VISIBLE = DECLARED_ORDER.filter((id) => id !== HOSTS_ATTENTION.id);
  expect(await popupOrder(page)).toEqual(VISIBLE);
  // The hidden row carries no drag hook at all, so there is no gesture to make.
  // `order` and `layout.hidden` are separate fields in the saved blob, and a
  // hidden tile holding a rank is a state the grid itself can never render.
  await expect(page.locator('[data-arrange-row]')).toHaveCount(VISIBLE.length);
  const hiddenRow = page.locator('li', { has: page.locator(`[data-arrange="back:${HOSTS_ATTENTION.id}"]`) }).last();
  await expect(hiddenRow).toHaveCount(1);
  expect(await hiddenRow.getAttribute('data-arrange-row')).toBeNull();

  // And driving the pointer at it anyway changes nothing — no line, no move.
  //
  // Compared against the blob as it stands RIGHT NOW rather than against a
  // literal: `order` here is still all five ids, because the window snapshots
  // the order off the DOM at the moment of the click and the tile was still on
  // the page then (see test 6). That rule is not what this test is about — what
  // it is about is that the attempted drag changes neither field.
  const before = await savedBlob(request);
  const from = (await hiddenRow.boundingBox())!;
  const top = (await page.locator('[data-arrange-row]').first().boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2 - 12, { steps: 3 });
  await page.mouse.move(top.x + 40, top.y + 2, { steps: 12 });
  await expect(page.locator('[data-arrange-insert-line]')).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(700);

  expect(await popupOrder(page), 'a hidden tile was dragged into the ordered list').toEqual(VISIBLE);
  const blob = await savedBlob(request);
  expect(blob.order, 'the attempted drag rewrote the saved order').toEqual(before.order);
  expect(blob.layout.hidden, 'the attempted drag rewrote the hidden list').toEqual([HOSTS_ATTENTION.id]);
  expect(blob.layout.hidden).toEqual(before.layout.hidden);
  expectPersistedBlobIsValid(blob);
});

test('after a drag the window still traps Tab, closes on Escape and hands focus back', async ({ page }) => {
  test.setTimeout(240_000);
  await goto(page);
  await openArrange(page);
  await dragRow(page, SECURITY_TODAY.id, 0, 'above');

  // Focus did not fall out of the window when the rows re-sorted under the
  // drop. The row is now at the top, so its own Move up is disabled and the
  // fallback target — its Move down — is what should hold focus.
  expect(
    (await focusedInfo(page))?.action,
    'the drop dropped focus out of the window',
  ).toBe(`down:${SECURITY_TODAY.id}`);

  // The trap still holds: Tab from anywhere inside stays inside.
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    const info = await focusedInfo(page);
    expect(
      info?.action !== null || info?.role === 'dialog' || info?.label === 'Close',
      `Tab #${i + 1} after a drag left the window (${JSON.stringify(info)})`,
    ).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  expect(
    (await focusedInfo(page))?.arrange,
    'focus did not return to the Arrange panels button after a drag',
  ).toBe(true);
});
