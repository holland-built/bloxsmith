import { test, expect } from './fixtures';
import {
  domOrder, dragOntoRightHalfOf, expectPersistedBlobIsValid, gotoTab, liveText,
  savedBlob as savedBlobFor, tabToHandle,
} from './layout-helpers';

// Per-panel hide and show — the operator takes a tile off the page, and it
// stays off until they put it back.
//
// NOT THE SAME FEATURE AS tests/hidden-panels.spec.ts, despite the names. That
// file covers service-ownership hiding: the APP decides, because the tenant
// owns no DHCP service, and the row it renders is `data-testid="hidden-panels"`.
// This file covers the operator deciding, and its strip is
// `data-testid="hidden-tiles"`. Nothing below touches the other testid.
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

// The two tiles this file hides, and the words the strip has to use for them.
// The name comes from the Card's own title via registerTitle — a hidden Card
// renders null, so if that hand-up ever breaks the strip falls back to the raw
// panel id and these assertions fail, which is the point of asserting the
// words rather than a count.
const SECURITY_TODAY = { id: 'daily-security-today', name: 'Security Today' };
const HOSTS_ATTENTION = { id: 'daily-hosts-attention', name: 'Hosts Needing Attention' };

type Page = import('@playwright/test').Page;

const goto = (page: Page) => gotoTab(page, TAB, DECLARED_ORDER.length);
// After a tile is hidden the grid holds one panel fewer, so the mount wait has
// to expect the smaller number or it times out on a page that is already right.
const gotoWith = (page: Page, panels: number) => gotoTab(page, TAB, panels);

const strip = (page: Page) => page.getByTestId('hidden-tiles');
const hideButton = (page: Page, id: string) => page.locator(`[data-panel-id="${id}"] [data-layout-hide]`);
const showButton = (page: Page, name: string) => page.getByRole('button', { name: `Show ${name}`, exact: true });

const savedBlob = (request: import('@playwright/test').APIRequestContext) => savedBlobFor(request, VIEW);

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  await request.delete(`/api/views/${VIEW}`);
});
test.afterEach(async ({ request }) => {
  await request.delete(`/api/views/${VIEW}`);
});

// ---------------------------------------------------------------------------
// 1 — the tile goes away, and something on screen says where it went.
// ---------------------------------------------------------------------------

test('hiding a tile takes it off the grid and names it in the strip below', async ({ page, request }) => {
  test.setTimeout(120_000);
  await goto(page);
  expect(await domOrder(page)).toEqual(DECLARED_ORDER);
  // Nothing is hidden, so the strip is ABSENT — not present and empty. An
  // empty strip would be a permanent band of chrome on every clean dashboard.
  await expect(strip(page)).toHaveCount(0);

  await hideButton(page, SECURITY_TODAY.id).click();
  await page.waitForTimeout(600);

  // Gone from the DOM entirely, not collapsed and not zero-height: anything
  // left behind would still be a grid item and would still take a track.
  expect(await domOrder(page)).toEqual(DECLARED_ORDER.filter((id) => id !== SECURITY_TODAY.id));
  await expect(page.locator(`[data-panel-id="${SECURITY_TODAY.id}"]`)).toHaveCount(0);

  // ...and the way back is on screen, naming the tile in words.
  await expect(strip(page)).toBeVisible();
  await expect(strip(page)).toContainText('1 tile is hidden');
  await expect(strip(page)).toContainText(SECURITY_TODAY.name);
  await expect(showButton(page, SECURITY_TODAY.name)).toBeVisible();

  // The screen-reader channel said so too, and named the tile.
  expect(await liveText(page)).toContain(SECURITY_TODAY.name);
  expect(await liveText(page)).toContain('hidden');

  // The SERVER has it — inside `layout`, where ViewWrite's top-level whitelist
  // cannot silently drop it, and in a shape the save validator accepts.
  const blob = await savedBlob(request);
  expect(blob.layout.hidden).toEqual([SECURITY_TODAY.id]);
  expectPersistedBlobIsValid(blob);
});

// ---------------------------------------------------------------------------
// 2 — it round-tripped through the server, not through React state.
// ---------------------------------------------------------------------------

test('a hidden tile is still hidden after a reload, and showing it again also sticks', async ({ page, request }) => {
  test.setTimeout(180_000);
  await goto(page);
  await hideButton(page, SECURITY_TODAY.id).click();
  await page.waitForTimeout(600);
  expect((await savedBlob(request)).layout.hidden).toEqual([SECURITY_TODAY.id]);

  // A full navigation: the React tree that did the hiding is gone, so the only
  // place this can come back from is GET /api/views/__layout_daily.
  await gotoWith(page, DECLARED_ORDER.length - 1);
  await expect(page.locator(`[data-panel-id="${SECURITY_TODAY.id}"]`)).toHaveCount(0);
  await expect(strip(page)).toContainText(SECURITY_TODAY.name);

  // Show puts it back — at the END of the page, because it was not in the DOM
  // when the order was last saved and so the saved order does not name it.
  // That is the same rule a newly added panel follows, and it is stated in the
  // panel's own ⓘ help rather than papered over here.
  await showButton(page, SECURITY_TODAY.name).click();
  await page.waitForTimeout(600);
  await expect(page.locator(`[data-panel-id="${SECURITY_TODAY.id}"]`)).toHaveCount(1);
  await expect(strip(page)).toHaveCount(0);
  expect(await domOrder(page)).toEqual([
    ...DECLARED_ORDER.filter((id) => id !== SECURITY_TODAY.id),
    SECURITY_TODAY.id,
  ]);

  const blob = await savedBlob(request);
  expect(blob.layout.hidden).toEqual([]);
  expectPersistedBlobIsValid(blob);

  // And the coming-back sticks too. A feature that only persists one of its
  // two states is worse than one that persists neither.
  await gotoWith(page, DECLARED_ORDER.length);
  await expect(page.locator(`[data-panel-id="${SECURITY_TODAY.id}"]`)).toHaveCount(1);
  await expect(strip(page)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 3 — a hidden tile is never unreachable.
//
// This is the accessibility clause, and it is the one that makes hiding safe
// to ship at all: a control that can remove content has to have a way back
// that does not need a mouse. Not one page.mouse call below — focus is reached
// by pressing Tab, which also proves both buttons are in the tab order rather
// than merely focusable by script.
// ---------------------------------------------------------------------------

const focusedInfo = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    return {
      show: el.hasAttribute('data-layout-show'),
      hide: el.hasAttribute('data-layout-hide'),
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

test('a tile can be hidden and brought back by keyboard alone, across a reload', async ({ page, request }) => {
  test.setTimeout(180_000);
  await goto(page);

  // Hide, from the keyboard. The hide button sits in the panel header next to
  // the move handle, so tabToHandle gets focus into the right panel and one
  // more Tab reaches the button — but that ordering is an implementation
  // detail, so this walks until it finds the right button instead of assuming.
  await tabToHandle(page, HOSTS_ATTENTION.id);
  await tabUntil(
    page,
    (info) => info?.hide && info.panel === HOSTS_ATTENTION.id,
    `the ${HOSTS_ATTENTION.id} hide button`,
  );
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  await expect(page.locator(`[data-panel-id="${HOSTS_ATTENTION.id}"]`)).toHaveCount(0);
  expect((await savedBlob(request)).layout.hidden).toEqual([HOSTS_ATTENTION.id]);

  // Reload, so the way back has to be found on a page nobody has interacted
  // with — the state a returning operator actually arrives in.
  await gotoWith(page, DECLARED_ORDER.length - 1);

  // VISIBLE, not merely in the DOM: a way back rendered inside a collapsed or
  // sr-only container would satisfy a count and help nobody.
  const show = showButton(page, HOSTS_ATTENTION.name);
  await expect(show).toBeVisible();
  const box = await show.boundingBox();
  expect(box, 'the Show control has no layout box').not.toBeNull();
  expect(box!.width, 'the Show control renders at zero width').toBeGreaterThan(0);
  expect(box!.height, 'the Show control renders at zero height').toBeGreaterThan(0);

  // Reached by Tab, from the top of the document.
  await page.keyboard.press('Tab');
  const presses = await tabUntil(
    page,
    (info) => info?.show && info.label === `Show ${HOSTS_ATTENTION.name}`,
    'the Show control',
  );
  expect(presses).toBeGreaterThan(0);

  // Operated by Enter on a native button — no click, no pointer.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  await expect(page.locator(`[data-panel-id="${HOSTS_ATTENTION.id}"]`)).toHaveCount(1);
  await expect(strip(page)).toHaveCount(0);
  expect(await liveText(page)).toContain(`${HOSTS_ATTENTION.name} is back on the page.`);
  expect((await savedBlob(request)).layout.hidden).toEqual([]);
});

// ---------------------------------------------------------------------------
// 4 — the two states share one saved record, so each has to survive the other.
//
// `order` and `layout.hidden` live in the same `__layout_daily` blob, and every
// gesture rewrites the WHOLE blob. A hide that snapshots the order it is about
// to change, or a drag that snapshots hidden as "whatever the DOM says" (the
// DOM cannot say — a hidden tile renders nothing), silently destroys the other
// half. That is the regression most likely to bite, so it gets both
// directions.
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
  await gotoWith(page, DECLARED_ORDER.length - 1);
  expect(await domOrder(page), 'the saved order did not survive the hide').toEqual(ORDER_A_VISIBLE);
  await expect(strip(page)).toContainText(HOSTS_ATTENTION.name);

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

  // Both halves come back together from the server.
  await gotoWith(page, DECLARED_ORDER.length - 1);
  expect(await domOrder(page)).toEqual(ORDER_B);
  await expect(page.locator(`[data-panel-id="${HOSTS_ATTENTION.id}"]`)).toHaveCount(0);
  await expect(strip(page)).toContainText(HOSTS_ATTENTION.name);

  // And the tile is still reachable after all of that.
  await showButton(page, HOSTS_ATTENTION.name).click();
  await page.waitForTimeout(600);
  expect(await domOrder(page)).toEqual([...ORDER_B, HOSTS_ATTENTION.id]);
  await expect(strip(page)).toHaveCount(0);
});
